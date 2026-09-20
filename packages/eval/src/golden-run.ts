import {
  candidateActionFor,
  decide,
  draftQuestion,
  draftReply,
  incidentAck,
  prepareTicketInput,
  resolveIncidentHint,
  type DecisionAction,
  type Draft,
  type TriageResult,
} from "@hd/agent-helpdesk";
import { scrubSecrets, type BusinessSettings } from "@hd/core";
import type { RetrievedChunk } from "@hd/rag";
import type { GoldenCase, HandlingAction } from "./golden-case.js";
import { caseToGoldenInput, openingBody } from "./golden-set.js";
import { triageUserPrompt, type ReplayedTriage } from "./replay.js";
import type { GoldenInput } from "./sample.js";

/**
 * Running the current system over a golden case.
 *
 * Everything here calls the production function for its stage rather than a
 * copy of it: intake's scrub, `prepareTicketInput`, `retrieve`, `decide`, the
 * triage prompt and schema (through `replayTriage`), and the draft functions.
 * What the runner adds is the frozen context a case carries in place of the
 * database's enrichment, and the one piece of routing it has to state itself:
 * the agent runs on a ticket's opening message only. A reply routes to a
 * person (`threadOntoTicket` in intake.ts never enqueues triage), so a case
 * judged after a later turn observes a person, not the agent.
 *
 * Two halves. `observeOffline` is pure and costs nothing — what the model is
 * sent, the injection scan, and what the decision branch does with a correct
 * classification. `observeModel` spends tokens: the classifier, the decision
 * on its classification, and the words it drafts.
 */

export interface RetrievedHit {
  title: string;
  score: number;
}

/** A decision, in the golden vocabulary. `human` means the agent was not started. */
export interface ObservedHandling {
  action: HandlingAction | "human";
  rule: string;
  reason: string;
}

export interface ObservedTriage {
  category: string;
  priority: string;
  confidence: number;
  is_security_sensitive: boolean;
  is_destructive_request: boolean;
  missing_info: string[];
  /** The hint, resolved against the case's incidents; null when it named none of them. */
  duplicate_of: string | null;
  model: string;
  prompt_version: string;
}

export interface ObservedAnswer {
  kind: "reply" | "question" | "incident_ack";
  body: string;
  /** Titles of the runbooks the draft was given, as its provenance records them. */
  sources: string[];
  model: string | null;
  prompt_version: string | null;
}

export interface CaseObservation {
  case_id: string;
  /** The agent runs on the turn being judged. False for a reply: a person picks those up. */
  invoked: boolean;
  /**
   * What the model was sent about this ticket: the triage user message, fence
   * nonce normalised. Every ticket is triaged on its opening message, so this
   * is set even when the turn being judged is a later one. A draft is sent the
   * same ticket block, so this covers it too.
   */
  model_input: string | null;
  redactions: Array<{ kind: string; count: number }>;
  injection: { suspected: boolean; signals: string[] };
  /** Retrieval run with the labelled category, so a misclassification cannot hide a retrieval miss. */
  retrieval: { category: string; hits: RetrievedHit[] } | null;
  /** What the decision branch does given a correct, confident classification. */
  oracle: ObservedHandling | null;
  triage: ObservedTriage | null;
  /** What the decision branch does given the model's classification. */
  handling: ObservedHandling | null;
  answer: ObservedAnswer | null;
  errors: string[];
}

export interface RunTenant {
  id: string | null;
  name: string;
  type: string;
}

/** The ticket body as the row stores it: scrubbed at intake when the tenant says so. */
export function storedBody(c: GoldenCase, settings: BusinessSettings): string {
  const raw = openingBody(c);
  return settings.scrub_secrets_at_rest ? scrubSecrets(raw).text : raw;
}

/** The fence carries a random nonce per call. A stored copy is compared across runs. */
function normaliseFence(text: string): string {
  return text.replace(/untrusted-content id="[0-9a-f]+"/g, 'untrusted-content id="<nonce>"');
}

const ACTION: Record<DecisionAction, HandlingAction> = {
  send_reply: "reply",
  ask_question: "clarify",
  run_action: "action",
  link_incident: "link_incident",
  escalate: "escalate",
  // An intended action is never `draft_only`; the mode produces that, after.
  draft_only: "reply",
};

const NOT_INVOKED: ObservedHandling = {
  action: "human",
  rule: "reply_routes_to_human",
  reason: "A requester reply is threaded onto the ticket and picked up by a person.",
};

/**
 * The classification a person labelled, as a triage result with full
 * confidence. Put through `decide`, it isolates the policy from the
 * classifier: a failure here is a rule or a threshold, not a wrong guess.
 */
export function oracleTriage(c: GoldenCase): TriageResult {
  const t = c.expected.triage;
  return {
    category: t.category as TriageResult["category"],
    subcategory: t.subcategory ?? "",
    priority: t.priority,
    confidence: 1,
    is_security_sensitive: t.is_security_sensitive,
    is_destructive_request: t.is_destructive_request,
    affected_system: null,
    missing_info: t.missing_info.slice(0, 3),
    duplicate_of_hint: t.duplicate_of,
    reasoning: t.subcategory ?? "",
  };
}

function decideFor(
  c: GoldenCase,
  triage: TriageResult,
  settings: BusinessSettings,
  kbTopScore: number | null,
  injectionSuspected: boolean,
): ObservedHandling {
  const r = c.input.requester;
  const requester = r ? { email: r.email } : null;
  const decision = decide({
    // The intended outcome is what is judged, and it does not depend on the mode.
    mode: "auto",
    settings,
    triage,
    kbTopScore,
    clarifyCount: c.input.clarify_rounds_so_far,
    matchedIncidentId: resolveIncidentHint(triage.duplicate_of_hint, c.input),
    requesterVip: r?.vip ?? false,
    requesterDepartment: r?.department ?? null,
    injectionSuspected,
    candidateAction: candidateActionFor(triage, { requester }),
  });
  return { action: ACTION[decision.intendedAction], rule: decision.rule, reason: decision.reason };
}

/**
 * The half that needs no model and no network.
 *
 * `hits` is retrieval for the labelled category — live from an index in a
 * run, or frozen from a baseline when a test replays the decision without a
 * database. Null when retrieval did not run, which the decision reads as no
 * runbook, exactly as the pipeline does after a retrieval error.
 */
export function observeOffline(
  c: GoldenCase,
  opts: {
    settings: BusinessSettings;
    tenant: RunTenant;
    hits: RetrievedHit[] | null;
  },
): CaseObservation {
  const body = storedBody(c, opts.settings);
  const prepared = prepareTicketInput({ subject: c.input.subject, body });
  const invoked = c.input.evaluate_after_turn === 1;
  const input = caseToGoldenInput(c, {
    body,
    businessName: opts.tenant.name,
    businessType: opts.tenant.type,
  });

  return {
    case_id: c.id,
    invoked,
    model_input: normaliseFence(triageUserPrompt(input, prepared.block)),
    redactions: prepared.redactions.map((h) => ({ kind: h.kind, count: h.count })),
    injection: { suspected: prepared.injection.suspected, signals: prepared.injection.signals },
    retrieval: opts.hits ? { category: c.expected.triage.category, hits: opts.hits } : null,
    oracle: invoked
      ? decideFor(
          c,
          oracleTriage(c),
          opts.settings,
          opts.hits?.[0]?.score ?? null,
          prepared.injection.suspected,
        )
      : NOT_INVOKED,
    triage: null,
    handling: null,
    answer: null,
    errors: [],
  };
}

export interface ModelDeps {
  settings: BusinessSettings;
  /** The tenant the calls are billed to, so the daily cost cap counts them. */
  tenant: RunTenant & { id: string };
  /** Live retrieval, the pipeline's query: subject and stored body, boosted by a category. */
  retrieve: (text: string, category: string) => Promise<RetrievedChunk[]>;
  triage: (input: GoldenInput) => Promise<ReplayedTriage>;
  /** The production draft functions, or stand-ins in a test. */
  draft?: {
    reply: typeof draftReply;
    question: typeof draftQuestion;
  };
}

/**
 * The half that spends tokens: classify, decide on that classification, and
 * draft what the pipeline would draft. Adds to an offline observation; errors
 * are recorded on it rather than thrown, so one failed call is one unmeasured
 * case and not a failed run.
 */
export async function observeModel(
  c: GoldenCase,
  base: CaseObservation,
  deps: ModelDeps,
): Promise<{ observation: CaseObservation; costUsd: number }> {
  const obs: CaseObservation = { ...base, errors: [...base.errors] };
  const body = storedBody(c, deps.settings);
  const draftFns = deps.draft ?? { reply: draftReply, question: draftQuestion };
  let costUsd = 0;

  let triaged: ReplayedTriage;
  try {
    triaged = await deps.triage(
      caseToGoldenInput(c, { body, businessName: deps.tenant.name, businessType: deps.tenant.type }),
    );
  } catch (err) {
    obs.errors.push(`triage: ${err instanceof Error ? err.message : String(err)}`);
    return { observation: obs, costUsd };
  }
  costUsd += triaged.costUsd;
  const t = triaged.triage;
  obs.triage = {
    category: t.category,
    priority: t.priority,
    confidence: t.confidence,
    is_security_sensitive: t.is_security_sensitive,
    is_destructive_request: t.is_destructive_request,
    missing_info: t.missing_info,
    duplicate_of: resolveIncidentHint(t.duplicate_of_hint, c.input),
    model: triaged.model,
    prompt_version: triaged.prompt_version,
  };

  // The triage above is the one the opening message got. A reply after it
  // starts nothing, so there is no decision and nothing drafted to observe.
  if (!obs.invoked) {
    obs.handling = NOT_INVOKED;
    return { observation: obs, costUsd };
  }

  let chunks: RetrievedChunk[] = [];
  try {
    chunks = await deps.retrieve(`${c.input.subject}\n${body}`, t.category);
  } catch (err) {
    obs.errors.push(`retrieval: ${err instanceof Error ? err.message : String(err)}`);
  }
  obs.handling = decideFor(c, t, deps.settings, chunks[0]?.score ?? null, obs.injection.suspected);

  // What the pipeline drafts for each intended action (`produceDraft`).
  const ticket = { id: null, subject: c.input.subject, body };
  const business = { id: deps.tenant.id, name: deps.tenant.name };
  const r = c.input.requester;
  const ctx = {
    requester: r ? { email: r.email, full_name: r.name, department: r.department, role: r.role } : null,
  };
  try {
    let draft: Draft | null = null;
    if (obs.handling.action === "link_incident") {
      const incident = c.input.incidents.find((i) => i.id === obs.triage!.duplicate_of);
      draft = incident ? incidentAck(deps.settings, incident) : null;
    } else if (obs.handling.action === "clarify") {
      draft = await draftFns.question(business, deps.settings, ticket, t, { purpose: "eval_golden" });
    } else if (obs.handling.action !== "escalate") {
      draft = await draftFns.reply(business, deps.settings, ticket, ctx, t, chunks, {
        purpose: "eval_golden",
      });
    }
    if (draft) {
      costUsd += draft.costUsd;
      obs.answer = {
        kind: draft.kind,
        body: draft.body,
        sources: draft.sources.map((s) => s.title),
        model: draft.model,
        prompt_version: draft.promptVersion,
      };
    }
  } catch (err) {
    obs.errors.push(`draft: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { observation: obs, costUsd };
}
