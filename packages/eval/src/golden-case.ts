import { TicketPriority, TicketSource } from "@hd/core";
import { z } from "zod";
import { Split } from "./sample.js";

/**
 * A golden case: one ticket, what the agent is given, and what a person has
 * decided the agent should do with it.
 *
 * `GoldenSample` (sample.ts) labels a classification. A case labels the whole
 * of the agent's behaviour on a ticket — the classification, the runbook it
 * should find, whether it should answer, ask, link or hand over, what a good
 * answer contains, and what must never appear in anything it sends — because
 * a prompt, model or retrieval change can break any of those without moving
 * category accuracy at all.
 *
 * One case per file in `eval/golden-set/cases/`, so review happens one ticket
 * at a time and a relabel is a readable diff. The labelling guidelines live
 * next to the files, in `eval/golden-set/README.md`.
 */

/** Why the case is in the set. A case can have several. */
export const Scenario = z.enum([
  "straightforward", // a question the runbooks answer
  "technical", // a fault that needs diagnosis
  "ambiguous", // not enough to act on, or two readings
  "multi_turn", // judged after a later turn, not the opening message
  "internal_note", // the conversation holds words the requester must not see
  "attachment", // the substance is in a file the agent cannot read
  "draft_edited", // the agent drafted, a person edited, the edit is the label
  "sensitive_info", // secrets or personal data in the requester's text
  "legacy", // a ticket from before the conversation, copied in by the backfill
  "security",
  "destructive",
  "prompt_injection",
  "known_incident",
  "vip",
]);
export type Scenario = z.infer<typeof Scenario>;

/**
 * What should happen next, in the vocabulary of the decision branch.
 *
 * `reply` answers and resolves, `clarify` asks one question, `link_incident`
 * attaches to an open outage, `escalate` hands the ticket to a person, and
 * `action` runs a whitelisted tool. The mapping from `decide()`'s actions is in
 * `golden-run.ts`.
 */
export const HandlingAction = z.enum(["reply", "clarify", "link_incident", "escalate", "action"]);
export type HandlingAction = z.infer<typeof HandlingAction>;

/**
 * Review state. `draft` is a proposal nobody has signed off, whoever wrote
 * it; only `reviewed` cases are the golden set, and only they are scored as
 * ground truth. A case drafted by a model is a draft until a person says
 * otherwise — the reviewer rules in `lintGoldenSet` make that checkable.
 */
export const CaseReviewStatus = z.enum(["draft", "reviewed", "needs_changes", "rejected"]);
export type CaseReviewStatus = z.infer<typeof CaseReviewStatus>;

export const CaseReview = z.object({
  status: CaseReviewStatus,
  /** Who drafted the expectations. A model that drafted them says so here. */
  authored_by: z.string().min(1),
  authored_at: z.string(),
  /** A person, by email. Never the author, never a model. */
  reviewed_by: z.string().nullable().default(null),
  reviewed_at: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
});
export type CaseReview = z.infer<typeof CaseReview>;

export const CaseAttachment = z.object({
  filename: z.string(),
  content_type: z.string().nullable().default(null),
  /**
   * What the file actually contains, for the reviewer. Never given to the
   * system: the agent sees file names only, and a case that fed it this text
   * would score a capability production does not have.
   */
  shows: z.string().nullable().default(null),
});
export type CaseAttachment = z.infer<typeof CaseAttachment>;

/**
 * One entry in the conversation, in the model of docs/conversation.md: an
 * author kind, a kind, a visibility, words, and attachments in order.
 */
export const CaseTurn = z.object({
  author: z.enum(["requester", "staff", "ai", "system"]),
  kind: z.enum(["message", "draft"]).default("message"),
  visibility: z.enum(["public", "internal"]).default("public"),
  body: z.string(),
  attachments: z.array(CaseAttachment).default([]),
  /** 1-based turn this one was made from, such as the draft a person edited and sent. */
  derived_from_turn: z.number().int().positive().nullable().default(null),
  /** A copy of a record from before the conversation (D4). */
  legacy: z.boolean().default(false),
});
export type CaseTurn = z.infer<typeof CaseTurn>;

export const CaseRequester = z.object({
  name: z.string().nullable().default(null),
  email: z.string(),
  department: z.string().nullable().default(null),
  role: z.string().nullable().default(null),
  vip: z.boolean().default(false),
});
export type CaseRequester = z.infer<typeof CaseRequester>;

export const CaseIncident = z.object({
  id: z.string(),
  priority: TicketPriority,
  subject: z.string(),
});
export type CaseIncident = z.infer<typeof CaseIncident>;

/**
 * Everything the agent is given, frozen, for the same reason `GoldenInput` is:
 * enrichment is time-dependent, and a case that re-enriched from the live
 * database would be scored against context it was never written for.
 */
export const CaseInput = z.object({
  channel: TicketSource,
  /** Null for a sender the directory does not know. */
  requester: CaseRequester.nullable(),
  /** The "Assigned device" line, or null for none on record. */
  device: z.string().nullable().default(null),
  /** Lines of the "open tickets from this requester" block, pre-formatted. */
  recent_tickets: z.array(z.string()).default([]),
  /** Active incidents shown to triage. `expected.triage.duplicate_of` names one of these. */
  incidents: z.array(CaseIncident).default([]),
  subject: z.string(),
  conversation: z.array(CaseTurn).min(1),
  /**
   * The behaviour is judged as of the arrival of this turn (1-based). The
   * opening message is 1. A later turn must be the requester's, because
   * nothing else starts the agent.
   */
  evaluate_after_turn: z.number().int().positive().default(1),
  /** Clarifying rounds the agent has already spent on this ticket. */
  clarify_rounds_so_far: z.number().int().min(0).default(0),
});
export type CaseInput = z.infer<typeof CaseInput>;

/**
 * A fact an answer must or must not state. `any_of` holds case-insensitive
 * regular expressions; one match is enough. Several phrasings of one fact
 * belong in one entry, so the count of entries is the count of facts.
 */
export const AnswerPattern = z.object({
  id: z.string(),
  what: z.string(),
  any_of: z.array(z.string()).min(1),
});
export type AnswerPattern = z.infer<typeof AnswerPattern>;

export const ExpectedTriage = z.object({
  category: z.string(),
  priority: TicketPriority,
  subcategory: z.string().nullable().default(null),
  is_security_sensitive: z.boolean(),
  is_destructive_request: z.boolean(),
  /**
   * Facts the requester has to supply before anybody can act. Empty when the
   * ticket says enough. Non-empty is what sends the decision branch to
   * `clarify`, so it is labelled here rather than inferred from the outcome.
   */
  missing_info: z.array(z.string()).default([]),
  /** Id of the incident in `input.incidents` this ticket duplicates, or null. */
  duplicate_of: z.string().nullable().default(null),
  /** The text tries to instruct the agent. A human judgement, not the scanner's. */
  prompt_injection: z.boolean().default(false),
});
export type ExpectedTriage = z.infer<typeof ExpectedTriage>;

/** Knowledge-base documents, by title as the index stores them. */
export const ExpectedRetrieval = z.object({
  /** Must be retrieved. Empty means no runbook covers this ticket. */
  relevant: z.array(z.string()).default([]),
  /** Fine to retrieve, not required. */
  acceptable: z.array(z.string()).default([]),
  /** Would mislead: an answer built on these is wrong for this ticket. */
  irrelevant: z.array(z.string()).default([]),
});
export type ExpectedRetrieval = z.infer<typeof ExpectedRetrieval>;

export const ExpectedHandling = z.object({
  action: HandlingAction,
  /** Other outcomes a reviewer would also accept, for a ticket with two fair readings. */
  also_acceptable: z.array(HandlingAction).default([]),
  /**
   * A person must own this ticket: any outcome but an escalation is unsafe.
   * True exactly when `action` is `escalate` and nothing else is acceptable,
   * which the lint enforces, so the field is there to be read, not to disagree.
   */
  escalation_required: z.boolean(),
  escalation_reason: z.string().nullable().default(null),
  /** Decision rules that should fire, when the reason matters. Empty means any. */
  rules: z.array(z.string()).default([]),
});
export type ExpectedHandling = z.infer<typeof ExpectedHandling>;

export const ExpectedAnswer = z.object({
  kind: z.enum(["reply", "question", "incident_ack"]),
  must_include: z.array(AnswerPattern).default([]),
  must_not_include: z.array(AnswerPattern).default([]),
  /** Runbook titles the answer should be sourced from. */
  cites: z.array(z.string()).default([]),
  /** For the reviewer and for judged scoring later; not scored automatically. */
  characteristics: z.array(z.string()).default([]),
  /** A human-approved answer, where one exists. A reference, never the scorer. */
  reference: z.string().nullable().default(null),
});
export type ExpectedAnswer = z.infer<typeof ExpectedAnswer>;

/**
 * Text that must not leave the system in the named places. `model_input` is
 * everything sent to a model for this ticket; `answer` is anything the agent
 * writes. The text must occur somewhere in the case, or the check is vacuous.
 */
export const MustNotAppear = z.object({
  id: z.string(),
  text: z.string().min(1),
  in: z.array(z.enum(["model_input", "answer"])).min(1),
  why: z.string(),
});
export type MustNotAppear = z.infer<typeof MustNotAppear>;

export const GoldenCase = z.object({
  id: z.string().regex(/^case-\d{3,}$/),
  title: z.string(),
  scenarios: z.array(Scenario).min(1),
  /** Where the ticket came from. `synthetic` cases are written to cover a gap. */
  origin: z.object({
    kind: z.enum(["synthetic", "seed_email", "seed_ticket", "production"]),
    ref: z.string().nullable().default(null),
  }),
  /** Derived from the id (`assignSplit`), stored so a reader can see it; the lint checks it. */
  split: Split,
  /** Which labelling guidelines the expectations follow. */
  label_version: z.string().default("v1"),
  review: CaseReview,
  input: CaseInput,
  expected: z.object({
    triage: ExpectedTriage,
    routing: z.object({ queue: z.string() }),
    retrieval: ExpectedRetrieval,
    handling: ExpectedHandling,
    /** Null when no answer is expected: the ticket goes to a person. */
    answer: ExpectedAnswer.nullable().default(null),
    must_not_appear: z.array(MustNotAppear).default([]),
  }),
  /** Why this is the right outcome. Written for the reviewer; shown when a case fails. */
  rationale: z.string(),
});
export type GoldenCase = z.infer<typeof GoldenCase>;

/**
 * `eval/golden-set/version.json`: the set's version, the guidelines its labels
 * follow, and the knowledge base and policy the expectations were written
 * against. A runbook edit can make a retrieval label wrong without anybody
 * touching a case, so the runbooks are pinned by hash.
 */
export const GoldenSetVersion = z.object({
  version: z.string(),
  label_version: z.string(),
  status: z.string(),
  updated_at: z.string(),
  description: z.string(),
  cases: z.number().int().nonnegative(),
  targets: z.object({
    total: z.number().int().positive(),
    per_category: z.number().int().positive(),
    holdout_pct: z.number().int().min(0).max(100),
  }),
  kb: z.object({
    dir: z.string(),
    docs: z.array(z.object({ file: z.string(), title: z.string(), sha256: z.string() })),
  }),
  /** The tenant policy the handling labels assume, in prose and in values. */
  policy: z.object({
    tenant: z.string(),
    notes: z.array(z.string()),
    settings: z.record(z.string(), z.unknown()),
  }),
  changelog: z.array(z.object({ version: z.string(), date: z.string(), changes: z.array(z.string()) })),
});
export type GoldenSetVersion = z.infer<typeof GoldenSetVersion>;
