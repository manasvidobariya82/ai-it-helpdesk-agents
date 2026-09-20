import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { requesterLine, incidentsBlock } from "@hd/agent-helpdesk";
import { routeQueue, type BusinessSettings, type ResolutionPath } from "@hd/core";
import { parseRunbook } from "@hd/rag";
import {
  GoldenCase,
  GoldenSetVersion,
  Scenario,
  HandlingAction,
  type CaseReviewStatus,
} from "./golden-case.js";
import { assignSplit, type GoldenInput, type GoldenSample } from "./sample.js";

/**
 * Loading, checking and describing the golden set.
 *
 * The set is a directory rather than a table for the reason the JSONL datasets
 * are files: a held-out set that a console action can rewrite is not held out,
 * and a label change should be a diff somebody reads.
 */

export interface LoadedGoldenSet {
  dir: string;
  version: GoldenSetVersion;
  cases: GoldenCase[];
  /** Files that did not parse, with the reason. Never silently dropped. */
  errors: Array<{ file: string; message: string }>;
}

export async function loadGoldenSet(dir: string): Promise<LoadedGoldenSet> {
  const version = GoldenSetVersion.parse(
    JSON.parse(await fs.readFile(path.join(dir, "version.json"), "utf8")),
  );

  const casesDir = path.join(dir, "cases");
  const files = (await fs.readdir(casesDir)).filter((f) => f.endsWith(".json")).sort();
  const cases: GoldenCase[] = [];
  const errors: Array<{ file: string; message: string }> = [];
  const seen = new Set<string>();

  for (const file of files) {
    try {
      const parsed = GoldenCase.parse(
        JSON.parse(await fs.readFile(path.join(casesDir, file), "utf8")),
      );
      // The file name is how a reviewer finds a case from a failure message.
      if (file !== `${parsed.id}.json`) {
        errors.push({ file, message: `holds ${parsed.id}; the file must be named ${parsed.id}.json` });
        continue;
      }
      if (seen.has(parsed.id)) {
        errors.push({ file, message: `duplicate case id ${parsed.id}` });
        continue;
      }
      seen.add(parsed.id);
      cases.push(parsed);
    } catch (err) {
      errors.push({ file, message: err instanceof Error ? err.message : String(err) });
    }
  }

  cases.sort((a, b) => a.id.localeCompare(b.id));
  return { dir, version, cases, errors };
}

/** The file a case lives in, for writers such as the review command. */
export function caseFile(dir: string, id: string): string {
  return path.join(dir, "cases", `${id}.json`);
}

/** Same bytes for the same case, so a review that changes nothing else is a one-field diff. */
export function serializeCase(c: GoldenCase): string {
  return `${JSON.stringify(c, null, 2)}\n`;
}

// --- identity ------------------------------------------------------------

/** JSON with sorted keys, so a hash does not depend on the order fields were typed in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Hash of what a case asks and what it expects — not of its review record.
 *
 * Accepting a case without changing it keeps its hash, so a baseline taken
 * before the review still compares. Editing an expectation changes it, and
 * the comparison then reports the case as relabelled instead of scoring the
 * system against a label it was never run under.
 */
export function expectationHash(c: GoldenCase): string {
  return sha(
    canonicalJson({ input: c.input, expected: c.expected, label_version: c.label_version }),
  ).slice(0, 16);
}

/** Identity of a set of cases: which cases, and what each expects. */
export function goldenSetId(cases: readonly GoldenCase[]): string {
  const h = createHash("sha256");
  for (const c of [...cases].sort((a, b) => a.id.localeCompare(b.id))) {
    h.update(`${c.id} ${expectationHash(c)}\n`);
  }
  return h.digest("hex").slice(0, 16);
}

/** Only reviewed cases are the golden set; drafts are proposals. */
export function reviewedCases(cases: readonly GoldenCase[]): GoldenCase[] {
  return cases.filter((c) => c.review.status === "reviewed");
}

/** The cases a run is scored over. `rejected` never counts. */
export function casesInScope(
  cases: readonly GoldenCase[],
  scope: "reviewed" | "all",
): GoldenCase[] {
  return scope === "reviewed"
    ? reviewedCases(cases)
    : cases.filter((c) => c.review.status !== "rejected");
}

// --- the pinned knowledge base ---------------------------------------------

export interface PinnedRunbook {
  file: string;
  title: string;
  categories: string[];
  body: string;
  sha256: string;
}

export interface PinnedKb {
  docs: PinnedRunbook[];
  /** Hash over the runbooks as they are on disk now. Part of a run's fingerprint. */
  hash: string;
  /** Runbooks that changed since the set pinned them: their retrieval labels may be stale. */
  drift: string[];
}

/**
 * The runbooks the expectations were written against, read from disk and
 * checked against the hashes in version.json. Line endings are normalised
 * first, so a checkout that converts them does not read as an edit.
 */
export async function loadPinnedKb(root: string, version: GoldenSetVersion): Promise<PinnedKb> {
  const docs: PinnedRunbook[] = [];
  const drift: string[] = [];
  for (const pin of version.kb.docs) {
    const raw = (await fs.readFile(path.join(root, version.kb.dir, pin.file), "utf8")).replace(/\r\n/g, "\n");
    const digest = sha(raw);
    const parsed = parseRunbook(raw, pin.file);
    if (digest !== pin.sha256) drift.push(`${pin.file} changed since the set pinned it`);
    if (parsed.title !== pin.title) drift.push(`${pin.file} is now titled "${parsed.title}", pinned as "${pin.title}"`);
    docs.push({ file: pin.file, title: parsed.title, categories: parsed.categories, body: parsed.body, sha256: digest });
  }
  return { docs, hash: sha(docs.map((d) => `${d.file} ${d.sha256}`).join("\n")).slice(0, 12), drift };
}

// --- lint ----------------------------------------------------------------

export interface LintIssue {
  case: string | null;
  level: "error" | "warning";
  message: string;
}

/**
 * Anything that looks like a model or a bot rather than a person.
 *
 * A reviewed label is a person's judgement, and a set whose "reviewer" is the
 * thing that drafted it has no ground truth in it. The check cannot prove a
 * human did the review; it makes the claim explicit and rules out the obvious
 * way of skipping it.
 */
const NOT_A_PERSON = /claude|anthropic|openai|gpt-|gemini|llama|mistral|\bmodel\b|assistant|\bbot\b/i;

export function lintGoldenSet(
  set: Pick<LoadedGoldenSet, "version" | "cases">,
  opts: { taxonomy: readonly string[]; settings: BusinessSettings },
): LintIssue[] {
  const issues: LintIssue[] = [];
  const kbTitles = new Set(set.version.kb.docs.map((d) => d.title));
  const taxonomy = new Set(opts.taxonomy);

  if (set.version.cases !== set.cases.length) {
    issues.push({
      case: null,
      level: "error",
      message: `version.json says ${set.version.cases} cases and the directory holds ${set.cases.length}`,
    });
  }

  for (const c of set.cases) {
    const err = (message: string) => issues.push({ case: c.id, level: "error", message });
    const warn = (message: string) => issues.push({ case: c.id, level: "warning", message });
    const { input, expected, review } = c;
    const t = expected.triage;
    const h = expected.handling;

    if (c.split !== assignSplit(c.id)) {
      err(`split is ${c.split}; the id assigns ${assignSplit(c.id)}`);
    }
    if (c.label_version !== set.version.label_version) {
      warn(`labelled under ${c.label_version}; the guidelines are at ${set.version.label_version}`);
    }

    // --- review: the difference between a proposal and ground truth ------
    if (review.status === "reviewed") {
      if (!review.reviewed_by || !review.reviewed_at) {
        err("reviewed with no reviewer or no date");
      } else {
        if (!review.reviewed_by.includes("@") || NOT_A_PERSON.test(review.reviewed_by)) {
          err(`reviewer "${review.reviewed_by}" must be a person, named by email`);
        }
        if (review.reviewed_by.toLowerCase() === review.authored_by.toLowerCase()) {
          err("reviewed by its own author; a label needs a second pair of eyes");
        }
      }
    }
    if ((review.status === "needs_changes" || review.status === "rejected") && !review.notes) {
      err(`${review.status} without a note saying why`);
    }

    // --- input -------------------------------------------------------------
    const turns = input.conversation;
    if (input.evaluate_after_turn > turns.length) {
      err(`evaluate_after_turn ${input.evaluate_after_turn} is past the last turn (${turns.length})`);
    }
    const opening = turns[0]!;
    if (opening.author !== "requester" && !(opening.author === "system" && opening.legacy)) {
      err("the opening turn must be the requester's, or a legacy copy authored by the system");
    }
    const judged = turns[input.evaluate_after_turn - 1];
    if (input.evaluate_after_turn > 1 && judged && judged.author !== "requester") {
      err("a later evaluation point must be a requester turn: nothing else starts the agent");
    }
    turns.forEach((turn, i) => {
      const n = i + 1;
      if (turn.author === "requester" && turn.visibility !== "public") {
        err(`turn ${n}: a requester message is always public (C5)`);
      }
      if (turn.kind === "draft" && (turn.visibility !== "internal" || turn.author !== "ai")) {
        err(`turn ${n}: a draft is the agent's and internal`);
      }
      if (turn.derived_from_turn !== null) {
        const source = turns[turn.derived_from_turn - 1];
        if (!source || turn.derived_from_turn >= n) {
          err(`turn ${n}: derived_from_turn must name an earlier turn`);
        }
      }
    });
    const incidentIds = new Set(input.incidents.map((x) => x.id));

    // --- triage ------------------------------------------------------------
    if (!taxonomy.has(t.category)) err(`category "${t.category}" is not in the taxonomy`);
    // The prompt states this rule and the validator enforces it, so a label
    // breaking it describes an answer the system can never give.
    if (t.is_security_sensitive && (t.priority === "P3" || t.priority === "P4")) {
      err(`security-sensitive at ${t.priority}; the guidelines put it at P1 or P2`);
    }
    if (t.missing_info.length > 3) err("missing_info holds more than the 3 facts triage may ask for");
    if (t.duplicate_of !== null && !incidentIds.has(t.duplicate_of)) {
      err(`duplicate_of "${t.duplicate_of}" is not one of the incidents in the input`);
    }

    // --- routing -----------------------------------------------------------
    const routed = routeQueue(t.category, t.priority, opts.settings);
    if (expected.routing.queue !== routed) {
      warn(`queue ${expected.routing.queue} differs from the routing table's ${routed}; fine if deliberate`);
    }

    // --- retrieval -----------------------------------------------------------
    const r = expected.retrieval;
    for (const title of [...r.relevant, ...r.acceptable, ...r.irrelevant]) {
      if (!kbTitles.has(title)) err(`runbook "${title}" is not in the pinned knowledge base`);
    }
    const overlap = r.relevant.filter((x) => r.irrelevant.includes(x) || r.acceptable.includes(x));
    if (overlap.length) err(`listed twice in retrieval: ${overlap.join(", ")}`);

    // --- handling ------------------------------------------------------------
    if (h.also_acceptable.includes(h.action)) err("also_acceptable repeats the action");
    const required = h.action === "escalate" && h.also_acceptable.every((a) => a === "escalate");
    if (h.escalation_required !== required) {
      err(
        required
          ? "only escalation is acceptable, so escalation_required must be true"
          : "another outcome is acceptable, so escalation_required must be false",
      );
    }
    if (h.escalation_required && !h.escalation_reason) err("escalation required with no reason given");
    if (h.action === "clarify" && t.missing_info.length === 0) {
      warn("clarify expected, but no missing_info labelled for triage to find");
    }
    if (h.action === "link_incident" && t.duplicate_of === null) {
      err("link_incident expected with no duplicate_of");
    }

    // --- answer --------------------------------------------------------------
    const a = expected.answer;
    const wantKind: Record<string, string> = {
      reply: "reply",
      clarify: "question",
      link_incident: "incident_ack",
    };
    if (wantKind[h.action] && (!a || a.kind !== wantKind[h.action])) {
      err(`${h.action} expected, so the answer must be a ${wantKind[h.action]}`);
    }
    if (a) {
      for (const p of [...a.must_include, ...a.must_not_include]) {
        for (const re of p.any_of) {
          try {
            new RegExp(re, "i");
          } catch {
            err(`pattern ${p.id} does not compile: ${re}`);
          }
        }
      }
      for (const title of a.cites) {
        if (!r.relevant.includes(title) && !r.acceptable.includes(title)) {
          err(`cites "${title}", which retrieval does not list as relevant or acceptable`);
        }
      }
    }

    // --- must_not_appear -----------------------------------------------------
    const everything = [
      input.subject,
      ...turns.flatMap((x) => [x.body, ...x.attachments.map((f) => `${f.filename} ${f.shows ?? ""}`)]),
    ]
      .join("\n")
      .toLowerCase();
    for (const m of expected.must_not_appear) {
      if (!everything.includes(m.text.toLowerCase())) {
        err(`must_not_appear "${m.id}" names text that is nowhere in the case, so it can never fail`);
      }
    }
  }

  return issues;
}

// --- coverage ------------------------------------------------------------

export interface CoverageCell {
  key: string;
  n: number;
  reviewed: number;
}

export interface GoldenCoverage {
  total: number;
  by_status: Record<CaseReviewStatus, number>;
  holdout: number;
  train: number;
  by_category: CoverageCell[];
  missing_categories: string[];
  /** Categories whose reviewed count is under the per-category target. */
  under_target: string[];
  by_scenario: CoverageCell[];
  missing_scenarios: string[];
  by_action: CoverageCell[];
  security: CoverageCell;
  destructive: CoverageCell;
  injection: CoverageCell;
  /** How often each pinned runbook is the one a case needs. */
  by_runbook: CoverageCell[];
  no_runbook: CoverageCell;
  targets: GoldenSetVersion["targets"];
}

export function goldenCoverage(
  set: Pick<LoadedGoldenSet, "version" | "cases">,
  taxonomy: readonly string[],
): GoldenCoverage {
  const all = set.cases;
  const count = (key: string, pick: (c: GoldenCase) => boolean): CoverageCell => {
    const hit = all.filter(pick);
    return { key, n: hit.length, reviewed: hit.filter((c) => c.review.status === "reviewed").length };
  };
  const byStatus = { draft: 0, reviewed: 0, needs_changes: 0, rejected: 0 };
  for (const c of all) byStatus[c.review.status] += 1;

  const byCategory = taxonomy.map((cat) => count(cat, (c) => c.expected.triage.category === cat));
  const byScenario = Scenario.options.map((s) => count(s, (c) => c.scenarios.includes(s)));

  return {
    total: all.length,
    by_status: byStatus,
    holdout: all.filter((c) => c.split === "holdout").length,
    train: all.filter((c) => c.split === "train").length,
    by_category: byCategory,
    missing_categories: byCategory.filter((x) => x.n === 0).map((x) => x.key),
    under_target: byCategory
      .filter((x) => x.reviewed < set.version.targets.per_category)
      .map((x) => x.key),
    by_scenario: byScenario,
    missing_scenarios: byScenario.filter((x) => x.n === 0).map((x) => x.key),
    by_action: HandlingAction.options.map((a) => count(a, (c) => c.expected.handling.action === a)),
    security: count("security", (c) => c.expected.triage.is_security_sensitive),
    destructive: count("destructive", (c) => c.expected.triage.is_destructive_request),
    injection: count("injection", (c) => c.expected.triage.prompt_injection),
    by_runbook: set.version.kb.docs.map((d) =>
      count(d.title, (c) => c.expected.retrieval.relevant.includes(d.title)),
    ),
    no_runbook: count("none", (c) => c.expected.retrieval.relevant.length === 0),
    targets: set.version.targets,
  };
}

// --- projections ---------------------------------------------------------

/** The requester's words as the ticket row stores them: the opening turn. */
export function openingBody(c: GoldenCase): string {
  return c.input.conversation[0]!.body;
}

/** Lines of the recent-tickets block, formatted as `recentTicketsBlock` formats live ones. */
function recentTicketsText(lines: readonly string[]): string {
  return lines.length === 0 ? "none" : lines.map((l) => `- ${l}`).join("\n");
}

/**
 * The frozen triage input for a case, in the shape replay takes.
 *
 * `body` is passed in rather than read from the case because the live ticket
 * row holds the body after intake has scrubbed it, and triage sees that.
 */
export function caseToGoldenInput(
  c: GoldenCase,
  opts: { body: string; businessName: string; businessType: string },
): GoldenInput {
  const r = c.input.requester;
  return {
    source: c.input.channel,
    subject: c.input.subject,
    body: opts.body,
    attachments: c.input.conversation[0]!.attachments.map((a) => a.filename),
    requester_line: requesterLine({
      requester: r
        ? { email: r.email, full_name: r.name, department: r.department, role: r.role }
        : null,
    }),
    vip: r?.vip ?? false,
    device_line: c.input.device ?? "none on record",
    recent_tickets: recentTicketsText(c.input.recent_tickets),
    active_incidents: incidentsBlock({ incidents: c.input.incidents }),
    business_name: opts.businessName,
    business_type: opts.businessType,
    fidelity: "captured",
  };
}

const PATH: Record<HandlingAction, ResolutionPath> = {
  reply: "auto_reply",
  clarify: "clarify",
  link_incident: "auto_reply",
  escalate: "escalated",
  action: "auto_action",
};

/**
 * A case as a classification sample, so the triage half of a golden run is
 * scored by the same `scoreRun` as everything else: accuracy, F1,
 * calibration, the safety slice and the threshold recommendations.
 */
export function caseToSample(
  c: GoldenCase,
  opts: { body: string; businessName: string; businessType: string },
): GoldenSample {
  const t = c.expected.triage;
  return {
    id: c.id,
    business_id: null,
    created_at: c.review.authored_at,
    split: c.split,
    status:
      c.review.status === "reviewed"
        ? "reviewed"
        : c.review.status === "rejected"
          ? "rejected"
          : "candidate",
    label_source: "manual",
    labeler: c.review.reviewed_by,
    reviewed_at: c.review.reviewed_at,
    label_version: c.label_version,
    input: caseToGoldenInput(c, opts),
    label: {
      category: t.category,
      priority: t.priority,
      team: c.expected.routing.queue,
      path: PATH[c.expected.handling.action],
      is_security_sensitive: t.is_security_sensitive,
      is_destructive_request: t.is_destructive_request,
    },
    recorded: null,
    note: c.rationale,
  };
}
