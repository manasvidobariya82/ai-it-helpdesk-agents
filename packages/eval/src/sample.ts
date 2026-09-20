import { ResolutionPath, TicketPriority, TicketSource } from "@hd/core";
import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The golden set lives in a file, not in a table.
 *
 * A held-out set that any console action can silently rewrite is not held out.
 * Keeping it as JSONL in the repo means a label change shows up in a diff, the
 * set is pinned to a commit, and an eval run from six weeks ago can be
 * reproduced exactly. `triage_shadow` is where labels are *collected*;
 * `eval/datasets/*.jsonl` is where they are *frozen*.
 */

/**
 * Category is a plain string, not the `TicketCategory` enum.
 *
 * Two reasons. `triage_shadow.agent_category` is `text` in the database, so a
 * historical row may name a category the enum has since dropped; and a
 * dataset that refuses to load after a taxonomy change is a dataset that gets
 * deleted rather than migrated. Unknown labels are reported by
 * `datasetCoverage`, not rejected at parse time.
 */
export const GoldenLabel = z.object({
  category: z.string(),
  priority: TicketPriority,
  /**
   * The team the ticket should have reached.
   *
   * Seeded by the exporter from `routeQueue(human_category, human_priority)`,
   * because routing is a pure function of the classification — which is what
   * makes the false-routing rate readable as "how classification errors turn
   * into tickets landing on the wrong desk". A reviewer can overwrite it when
   * the routing table itself is what got the ticket wrong.
   */
  team: z.string().nullable().default(null),
  path: ResolutionPath.nullable().default(null),
  /**
   * The safety slice. Null means nobody has labelled it, which is why the
   * safety gate reports `unmeasured` rather than passing by default: a gate
   * that passes on an empty set is worse than no gate.
   */
  is_security_sensitive: z.boolean().nullable().default(null),
  is_destructive_request: z.boolean().nullable().default(null),
});
export type GoldenLabel = z.infer<typeof GoldenLabel>;

/**
 * Everything the triage prompt sees, frozen at capture time.
 *
 * Replay rebuilds the prompt from these fields rather than from the live
 * database. Enrichment is time-dependent — the incidents that were open when
 * the ticket arrived are not the incidents open now — so a replay that
 * re-enriches is scoring the classifier against a prompt it was never given.
 */
export const GoldenInput = z.object({
  source: TicketSource,
  subject: z.string(),
  body: z.string(),
  attachments: z.array(z.string()).default([]),
  requester_line: z.string().default(""),
  vip: z.boolean().default(false),
  device_line: z.string().default(""),
  recent_tickets: z.string().default(""),
  active_incidents: z.string().default(""),
  business_name: z.string().default(""),
  business_type: z.string().default(""),
  /**
   * `captured` means the context block was written by the pipeline at triage
   * time and replay is exact. `reconstructed` means the exporter rebuilt it
   * from current data for a ticket triaged before capture existed, so a replay
   * difference may be the context, not the prompt. The report says which.
   */
  fidelity: z.enum(["captured", "reconstructed"]).default("reconstructed"),
});
export type GoldenInput = z.infer<typeof GoldenInput>;

/** What the agent actually said at the time. Absent for hand-written samples. */
export const RecordedPrediction = z.object({
  category: z.string(),
  priority: TicketPriority,
  confidence: z.number(),
  path: ResolutionPath.nullable().default(null),
  /** The agent's own safety flags, so the frozen sample holds both sides. */
  is_security_sensitive: z.boolean().nullable().default(null),
  is_destructive_request: z.boolean().nullable().default(null),
  model: z.string().nullable().default(null),
  prompt_version: z.string().nullable().default(null),
  recorded_at: z.string().nullable().default(null),
});
export type RecordedPrediction = z.infer<typeof RecordedPrediction>;

export const Split = z.enum(["train", "holdout"]);
export type Split = z.infer<typeof Split>;

/**
 * Review status. This is the distinction between production feedback and a
 * golden set, and it is the reason the two can live in one file.
 *
 * A human correction in the console is evidence, not ground truth. The person
 * clicking it is triaging their queue at 4pm, not curating a benchmark, and
 * they are wrong often enough that a set built by trusting every correction
 * measures agreement with a busy colleague rather than correctness. Exports
 * land as `candidate`. Only `reviewed` samples are scored as golden;
 * `rejected` ones stay in the file so nobody re-imports them next month.
 */
export const ReviewStatus = z.enum(["candidate", "reviewed", "rejected"]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export const GoldenSample = z.object({
  /** Ticket id where one exists. Stable, because the split is derived from it. */
  id: z.string(),
  business_id: z.string().nullable().default(null),
  created_at: z.string(),
  split: Split,
  status: ReviewStatus.default("candidate"),
  /** How the label arrived. `manual` means somebody wrote it from scratch. */
  label_source: z.enum(["human_correction", "human_confirmation", "manual"]),
  /** Who reviewed it. Null while the sample is still a candidate. */
  labeler: z.string().nullable().default(null),
  reviewed_at: z.string().nullable().default(null),
  /**
   * Which labelling guidelines were in force. A category definition that
   * changes makes every label written under the old one suspect, and without
   * this you cannot tell which half of the set that is.
   */
  label_version: z.string().default("v1"),
  input: GoldenInput,
  label: GoldenLabel,
  recorded: RecordedPrediction.nullable().default(null),
  /** Free text for whoever labelled it. Shown when a sample fails. */
  note: z.string().nullable().default(null),
});
export type GoldenSample = z.infer<typeof GoldenSample>;

/**
 * The single text a labeller reads, and the exact text the prompt receives.
 *
 * Derived rather than stored: `input_text` is `subject` and `body` with the
 * separator the prompt uses, so storing it as well would put two copies of the
 * same requester text in one record with nothing keeping them equal.
 */
export function inputText(sample: GoldenSample): string {
  return `Subject: ${sample.input.subject}\n\n${sample.input.body}`;
}

/** Only reviewed samples count. Candidates are raw production feedback. */
export function goldenOnly(samples: readonly GoldenSample[]): GoldenSample[] {
  return samples.filter((s) => s.status === "reviewed");
}

/**
 * Deterministic split assignment from the sample id.
 *
 * Hash-based rather than random so that adding samples never reshuffles the
 * existing ones. A sample that was holdout last month is holdout today, which
 * is the only way "held out of all prompt iteration" survives contact with a
 * growing dataset.
 */
export function assignSplit(id: string, holdoutPct = 30): Split {
  const digest = createHash("sha256").update(id).digest();
  const bucket = digest.readUInt16BE(0) % 100;
  return bucket < holdoutPct ? "holdout" : "train";
}

/**
 * Content hash of a dataset. A baseline records it, and a comparison against a
 * different dataset id is reported as incomparable rather than as a regression.
 */
export function datasetId(samples: readonly GoldenSample[]): string {
  const h = createHash("sha256");
  // Only reviewed samples are scored, so only reviewed samples define the
  // identity. Adding candidates to the file does not invalidate a baseline;
  // promoting or relabelling one does, which is correct.
  const scored = goldenOnly(samples).sort((a, b) => a.id.localeCompare(b.id));
  for (const s of scored) {
    h.update(
      [
        s.id,
        s.label.category,
        s.label.priority,
        s.label.team ?? "",
        String(s.label.is_security_sensitive),
        String(s.label.is_destructive_request),
        s.label_version,
      ].join(" "),
    );
    h.update("");
  }
  return h.digest("hex").slice(0, 16);
}

export interface DatasetCoverage {
  /** Reviewed samples only — the golden set proper. */
  n: number;
  /** Everything in the file, reviewed or not. */
  total: number;
  candidates: number;
  rejected: number;
  label_versions: string[];
  labelers: string[];
  train: number;
  holdout: number;
  by_category: Array<{ category: string; n: number; holdout: number }>;
  /** Categories in the taxonomy with no sample at all. The gap to go fill. */
  missing_categories: string[];
  /** Categories present in the data but not in the taxonomy. */
  unknown_categories: string[];
  /** Samples carrying a human safety label. */
  safety_labelled: number;
  security_sensitive: number;
  destructive: number;
}

export function datasetCoverage(
  all: readonly GoldenSample[],
  taxonomy: readonly string[],
): DatasetCoverage {
  // Coverage describes the golden set, not the inbox of candidates waiting for
  // somebody to look at them. Both counts are reported; only one is the set.
  const samples = goldenOnly(all);
  const byCat = new Map<string, { category: string; n: number; holdout: number }>();
  for (const s of samples) {
    const cell = byCat.get(s.label.category) ?? {
      category: s.label.category,
      n: 0,
      holdout: 0,
    };
    cell.n += 1;
    if (s.split === "holdout") cell.holdout += 1;
    byCat.set(s.label.category, cell);
  }

  const known = new Set(taxonomy);
  const present = new Set(byCat.keys());

  return {
    n: samples.length,
    total: all.length,
    candidates: all.filter((s) => s.status === "candidate").length,
    rejected: all.filter((s) => s.status === "rejected").length,
    label_versions: [...new Set(samples.map((s) => s.label_version))].sort(),
    labelers: [...new Set(samples.map((s) => s.labeler).filter((l): l is string => !!l))].sort(),
    train: samples.filter((s) => s.split === "train").length,
    holdout: samples.filter((s) => s.split === "holdout").length,
    by_category: [...byCat.values()].sort((a, b) => b.n - a.n),
    missing_categories: taxonomy.filter((c) => !present.has(c)),
    unknown_categories: [...present].filter((c) => !known.has(c)).sort(),
    safety_labelled: samples.filter(
      (s) =>
        s.label.is_security_sensitive !== null ||
        s.label.is_destructive_request !== null,
    ).length,
    security_sensitive: samples.filter((s) => s.label.is_security_sensitive === true)
      .length,
    destructive: samples.filter((s) => s.label.is_destructive_request === true).length,
  };
}
