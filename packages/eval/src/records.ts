import { clamp01 } from "./metrics.js";
import type { EvalReport, ScoredSample } from "./report.js";

/**
 * The per-ticket row an evaluation run produces.
 *
 * Aggregates answer "is the classifier good". These rows answer "which
 * categories can safely operate at which confidence threshold", because that
 * question needs slicing after the fact — by tenant, by model, by prompt
 * version, by bucket — and no aggregate survives being re-sliced.
 *
 * They are written once per run and never updated. A run is a measurement of a
 * moment; editing one is editing the past.
 */
export interface EvalRecord {
  ticket_id: string;
  tenant: string | null;
  confidence: number;
  /** "0.80-0.90". Precomputed so the obvious query needs no arithmetic. */
  confidence_bucket: string;
  /** The agent's category. Named `category` because that is the slice key. */
  category: string;
  predicted_category: string;
  actual_category: string;
  correct: boolean;
  predicted_priority: string;
  actual_priority: string;
  priority_correct: boolean;
  predicted_team: string | null;
  actual_team: string | null;
  team_correct: boolean | null;
  /** Whether this ticket would auto-route under the recommended thresholds. */
  would_auto_route: boolean;
  model_version: string | null;
  prompt_version: string | null;
  evaluation_timestamp: string;
}

export function bucketOf(confidence: number, bins = 10): string {
  const c = clamp01(confidence);
  const width = 1 / bins;
  const index = Math.min(bins - 1, Math.floor(c / width));
  return `${(index * width).toFixed(2)}-${((index + 1) * width).toFixed(2)}`;
}

export function toRecords(
  scored: readonly ScoredSample[],
  report: EvalReport,
  opts: { tenant?: string | null; bins?: number } = {},
): EvalRecord[] {
  // Which tickets the recommended policy would have automated, so the rows can
  // be filtered down to the slice autonomy actually touches.
  const routed = new Set<string>();
  for (const m of report.routing.by_category) {
    if (m.never_auto || m.threshold === null) continue;
    for (const s of scored) {
      if (s.predicted.category !== m.category) continue;
      if (clamp01(s.predicted.confidence) >= m.threshold) routed.add(s.id);
    }
  }

  return scored.map((s) => ({
    ticket_id: s.id,
    tenant: opts.tenant ?? null,
    confidence: s.predicted.confidence,
    confidence_bucket: bucketOf(s.predicted.confidence, opts.bins ?? 10),
    category: s.predicted.category,
    predicted_category: s.predicted.category,
    actual_category: s.actual.category,
    correct: s.predicted.category === s.actual.category,
    predicted_priority: s.predicted.priority,
    actual_priority: s.actual.priority,
    priority_correct: s.predicted.priority === s.actual.priority,
    predicted_team: s.predicted.team ?? null,
    actual_team: s.actual.team ?? null,
    team_correct:
      s.predicted.team == null || s.actual.team == null
        ? null
        : s.predicted.team === s.actual.team,
    would_auto_route: routed.has(s.id),
    model_version: report.model,
    prompt_version: report.prompt_version,
    evaluation_timestamp: report.generated_at,
  }));
}
