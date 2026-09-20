import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { routingFingerprint, type BusinessSettings } from "@hd/core";
import { z } from "zod";
import { canonicalJson } from "./golden-set.js";
import type { CaseObservation } from "./golden-run.js";
import type { CaseResult, CheckStatus, Severity } from "./golden-score.js";

/**
 * The golden baseline: what the current system did on every case, pinned.
 *
 * It keeps the observations, not only the scores. The labels are still being
 * reviewed, and a score against a draft label is provisional; the observation
 * is not. Keeping what the system actually did means a case accepted next
 * week is scored against the system as it was today without running it
 * again, and a reviewer can see what a run did without the run being repeated.
 *
 * A comparison is per case and per check. On a set this size an aggregate
 * rate hides the thing worth knowing — which ticket now goes wrong — and one
 * case flipping from pass to fail is the regression.
 */

export const GoldenBaseline = z.object({
  kind: z.literal("golden"),
  label: z.string(),
  created_at: z.string(),
  golden_set: z.object({
    version: z.string(),
    label_version: z.string(),
    set_id: z.string(),
    cases: z.number().int(),
    reviewed: z.number().int(),
  }),
  tenant: z.object({ name: z.string(), type: z.string() }),
  /** The settings the run decided under, whole, so a test can decide again under them. */
  settings: z.record(z.string(), z.unknown()),
  fingerprint: z.object({ hash: z.string(), parts: z.record(z.string(), z.string()) }),
  model_run: z.object({
    ran: z.boolean(),
    reason: z.string().nullable(),
    cost_usd: z.number(),
  }),
  observations: z.record(z.string(), z.unknown()),
  results: z.array(
    z.object({
      case_id: z.string(),
      review_status: z.string(),
      split: z.string(),
      expectation_hash: z.string(),
      checks: z.record(z.string(), z.object({ status: z.string(), severity: z.string() })),
    }),
  ),
  summary: z.object({ reviewed: z.unknown(), all: z.unknown() }),
});
export type GoldenBaseline = z.infer<typeof GoldenBaseline>;

const short = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

/**
 * What a golden run's numbers depend on, part by part. Two runs with the same
 * fingerprint differ only in the code; a part that moved is named, so "the
 * policy changed" sends somebody to one settings block rather than to a diff.
 */
export function goldenFingerprint(parts: {
  setId: string;
  kbHash: string;
  embedder: string;
  settings: BusinessSettings;
  triage: string;
  draft: string;
}): { hash: string; parts: Record<string, string> } {
  const s = parts.settings;
  const named: Record<string, string> = {
    set: parts.setId,
    kb: parts.kbHash,
    embedder: parts.embedder,
    policy: short(
      canonicalJson({
        default_policy: s.default_policy,
        category_policies: s.category_policies,
        kb_support_floor: s.kb_support_floor,
        auto_action_whitelist: [...s.auto_action_whitelist].sort(),
        max_clarify_rounds: s.max_clarify_rounds,
        vip_always_human: s.vip_always_human,
        human_only_departments: [...s.human_only_departments].sort(),
        never_auto_categories: [...s.never_auto_categories].sort(),
        scrub_secrets_at_rest: s.scrub_secrets_at_rest,
        signature: s.signature,
      }),
    ),
    routing: short(routingFingerprint(s)),
    triage: parts.triage,
    draft: parts.draft,
  };
  return { hash: short(canonicalJson(named)), parts: named };
}

export function baselineResults(results: readonly CaseResult[]): GoldenBaseline["results"] {
  return results.map((r) => ({
    case_id: r.case_id,
    review_status: r.review_status,
    split: r.split,
    expectation_hash: r.expectation_hash,
    checks: Object.fromEntries(r.checks.map((ch) => [ch.id, { status: ch.status, severity: ch.severity }])),
  }));
}

export async function saveGoldenBaseline(file: string, baseline: GoldenBaseline): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

export async function loadGoldenBaseline(file: string): Promise<GoldenBaseline> {
  return GoldenBaseline.parse(JSON.parse(await fs.readFile(file, "utf8")));
}

/** A baseline's observations, typed. They were written by this module's caller. */
export function baselineObservations(b: GoldenBaseline): Record<string, CaseObservation> {
  return b.observations as Record<string, CaseObservation>;
}

export interface CheckChange {
  case_id: string;
  check: string;
  from: CheckStatus;
  to: CheckStatus;
  severity: Severity;
  review_status: string;
}

export interface GoldenComparison {
  baseline_label: string;
  /** Parts of the fingerprint that moved. A different model is the point of comparing; say so. */
  changed: string[];
  compared: number;
  /** Cases whose expectations were edited since the baseline: not compared, re-baseline them. */
  relabelled: string[];
  added: string[];
  removed: string[];
  /** Passed at the baseline, fail now. */
  regressions: CheckChange[];
  /** Failed at the baseline, pass now. */
  fixed: CheckChange[];
  /** Unmeasured at the baseline and measured now, or the reverse. Reported, not judged. */
  coverage_changes: CheckChange[];
  passed: boolean;
}

export function compareGolden(
  current: readonly CaseResult[],
  baseline: GoldenBaseline,
  fingerprint?: { hash: string; parts: Record<string, string> } | null,
): GoldenComparison {
  const before = new Map(baseline.results.map((r) => [r.case_id, r]));
  const now = new Map(current.map((r) => [r.case_id, r]));
  const out: GoldenComparison = {
    baseline_label: baseline.label,
    changed: fingerprint
      ? Object.keys(fingerprint.parts).filter((k) => baseline.fingerprint.parts[k] !== fingerprint.parts[k])
      : [],
    compared: 0,
    relabelled: [],
    added: [...now.keys()].filter((id) => !before.has(id)).sort(),
    removed: [...before.keys()].filter((id) => !now.has(id)).sort(),
    regressions: [],
    fixed: [],
    coverage_changes: [],
    passed: true,
  };

  for (const r of current) {
    const b = before.get(r.case_id);
    if (!b) continue;
    if (b.expectation_hash !== r.expectation_hash) {
      out.relabelled.push(r.case_id);
      continue;
    }
    out.compared += 1;
    for (const ch of r.checks) {
      const was = b.checks[ch.id];
      if (!was || was.status === ch.status) continue;
      const change: CheckChange = {
        case_id: r.case_id,
        check: ch.id,
        from: was.status as CheckStatus,
        to: ch.status,
        severity: ch.severity,
        review_status: r.review_status,
      };
      if (was.status === "pass" && ch.status === "fail") out.regressions.push(change);
      else if (was.status === "fail" && ch.status === "pass") out.fixed.push(change);
      else out.coverage_changes.push(change);
    }
  }

  out.passed = out.regressions.length === 0;
  return out;
}
