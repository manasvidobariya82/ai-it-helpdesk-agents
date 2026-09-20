import { accuracy, clamp01, type Prediction } from "./metrics.js";

/**
 * Threshold recommendation from observed data.
 *
 * Today every `confidence_threshold` in `businesses.settings` is a number
 * somebody chose. This file turns each one into either a measurement or an
 * explicit "not enough evidence yet", and it never returns the second as the
 * first.
 *
 * The rule: sweep candidate thresholds, keep those whose *Wilson lower bound*
 * clears the accuracy target with at least `minSamples` tickets above the
 * line, and recommend the lowest of them. Lowest, because among thresholds
 * that are equally defensible the one that automates the most tickets wins;
 * lower bound, because 4 correct out of 4 is not evidence of 95% accuracy.
 */

export interface ThresholdPoint {
  threshold: number;
  /** Tickets at or above the threshold. */
  n: number;
  /** Share of all tickets in this slice that the threshold would automate. */
  coverage: number;
  accuracy: number | null;
  lower_bound: number | null;
  meets_target: boolean;
  /** Tickets below the threshold that the agent got right anyway. */
  n_below: number;
  accuracy_below: number | null;
}

export type ThresholdVerdict =
  | "recommended"
  | "insufficient_data"
  | "target_unreachable"
  /** No threshold is offered, whatever the data says. A policy, not a metric. */
  | "human_only";

export interface ThresholdRecommendation {
  /** Category name, or `__all__` for the whole slice. */
  scope: string;
  target_accuracy: number;
  min_samples: number;
  n: number;
  verdict: ThresholdVerdict;
  recommended: ThresholdPoint | null;
  /** What `businesses.settings` says today, when the caller supplied it. */
  current_threshold: number | null;
  /** The same sweep evaluated at the configured threshold. */
  current: ThresholdPoint | null;
  /** Whether the configured threshold is defensible on this data. */
  current_holds: boolean | null;
  sweep: ThresholdPoint[];
  note: string;
}

export interface ThresholdOptions {
  /** Accuracy the threshold must prove. P4's gate is 0.95. */
  targetAccuracy?: number;
  /** Minimum tickets above the line before a recommendation is allowed. */
  minSamples?: number;
  /** Candidate thresholds. Defaults to 0.50 through 0.99 in steps of 0.01. */
  candidates?: readonly number[];
  /** Current setting, so the report can say whether it holds. */
  currentThreshold?: number | null;
  scope?: string;
  /**
   * Categories that may never be automated. `security_incident` is the
   * standing example: the cost of the rare miss is not on the same scale as
   * the saving on the common case, so no observed accuracy should be able to
   * open it. The recommender reports `human_only` and offers no number,
   * because offering one invites somebody to use it.
   */
  neverAuto?: ReadonlySet<string>;
}

const DEFAULT_CANDIDATES: readonly number[] = Array.from(
  { length: 50 },
  (_v, i) => Number((0.5 + i * 0.01).toFixed(2)),
);

export function evaluateThreshold(
  preds: readonly Prediction[],
  threshold: number,
  opts: { targetAccuracy: number; minSamples: number },
): ThresholdPoint {
  const above = preds.filter((p) => clamp01(p.confidence) >= threshold);
  const below = preds.filter((p) => clamp01(p.confidence) < threshold);
  const a = accuracy(above);
  const b = accuracy(below);

  return {
    threshold,
    n: a.n,
    coverage: preds.length === 0 ? 0 : a.n / preds.length,
    accuracy: a.accuracy,
    lower_bound: a.lower_bound,
    meets_target:
      a.n >= opts.minSamples &&
      a.lower_bound !== null &&
      a.lower_bound >= opts.targetAccuracy,
    n_below: b.n,
    accuracy_below: b.accuracy,
  };
}

export function recommendThreshold(
  preds: readonly Prediction[],
  opts: ThresholdOptions = {},
): ThresholdRecommendation {
  const targetAccuracy = opts.targetAccuracy ?? 0.95;
  const minSamples = opts.minSamples ?? 30;
  const candidates = opts.candidates ?? DEFAULT_CANDIDATES;
  const scope = opts.scope ?? "__all__";
  const currentThreshold = opts.currentThreshold ?? null;

  if (opts.neverAuto?.has(scope)) {
    return {
      scope,
      target_accuracy: targetAccuracy,
      min_samples: minSamples,
      n: preds.length,
      verdict: "human_only",
      recommended: null,
      current_threshold: currentThreshold,
      current: null,
      current_holds: null,
      sweep: [],
      note:
        "Never automated by policy. No threshold is offered — the judgement " +
        "that this category is human-only outranks whatever the accuracy says.",
    };
  }

  const sweep = candidates.map((t) =>
    evaluateThreshold(preds, t, { targetAccuracy, minSamples }),
  );
  const passing = sweep.filter((p) => p.meets_target);
  const recommended = passing.length === 0 ? null : passing[0]!;

  const current =
    currentThreshold === null
      ? null
      : evaluateThreshold(preds, currentThreshold, { targetAccuracy, minSamples });

  let verdict: ThresholdVerdict;
  let note: string;

  if (recommended) {
    verdict = "recommended";
    note =
      `${pctText(recommended.coverage)} of tickets clear ${recommended.threshold.toFixed(2)}, ` +
      `and on those ${recommended.n} tickets accuracy is ${pctText(recommended.accuracy)} ` +
      `(95% lower bound ${pctText(recommended.lower_bound)}).`;
  } else if (preds.length < minSamples) {
    verdict = "insufficient_data";
    note =
      `${preds.length} reconciled tickets; ${minSamples} are needed before a ` +
      `threshold means anything. Keep this category in shadow.`;
  } else {
    // There is enough data and no threshold clears the bar. That is a real
    // finding, not a missing one: this category is not ready for autonomy at
    // this target, however the dial is set.
    const best = [...sweep].sort(
      (a, b) => (b.lower_bound ?? 0) - (a.lower_bound ?? 0),
    )[0];
    verdict = "target_unreachable";
    note =
      `No threshold in the sweep reaches ${pctText(targetAccuracy)} with ` +
      `n >= ${minSamples}. The best was ${best ? best.threshold.toFixed(2) : "n/a"} ` +
      `at a lower bound of ${pctText(best?.lower_bound ?? null)}. ` +
      `Fix the classifier, not the dial.`;
  }

  return {
    scope,
    target_accuracy: targetAccuracy,
    min_samples: minSamples,
    n: preds.length,
    verdict,
    recommended,
    current_threshold: currentThreshold,
    current,
    current_holds: current === null ? null : holds(current, recommended),
    sweep,
    note,
  };
}

/**
 * Whether a configured threshold is defensible.
 *
 * Two ways to qualify. It clears the target on its own evidence, or it sits at
 * or above the lowest threshold that does. The second case matters because
 * evidence thins out as the threshold rises: if 0.80 is proven over 90 tickets
 * and only 40 tickets ever scored above 0.90, then 0.90 has a weaker *direct*
 * sample while automating a strictly safer subset. Calling that unjustified
 * would push operators towards looser dials to satisfy the report, which is
 * precisely backwards.
 */
function holds(
  current: ThresholdPoint,
  recommended: ThresholdPoint | null,
): boolean {
  if (current.meets_target) return true;
  return recommended !== null && current.threshold >= recommended.threshold;
}

/**
 * One recommendation per category, using each category's own configured
 * threshold as the comparison. Categories calibrate differently, which is why
 * the setting is per-category in the first place.
 */
export function recommendPerCategory(
  preds: readonly Prediction[],
  opts: ThresholdOptions & {
    /** Which side of the pair defines the group: the human label, always. */
    currentFor?: (category: string) => number | null;
  } = {},
): ThresholdRecommendation[] {
  const groups = new Map<string, Prediction[]>();
  for (const p of preds) {
    // Group by the agent's own label, not the human's. The threshold is applied
    // at decision time, when only the agent's label exists.
    const list = groups.get(p.predicted);
    if (list) list.push(p);
    else groups.set(p.predicted, [p]);
  }

  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([category, rows]) =>
      recommendThreshold(rows, {
        ...opts,
        scope: category,
        currentThreshold: opts.currentFor?.(category) ?? null,
      }),
    );
}

/**
 * The operating thresholds a run should be scored against: the recommendation
 * where there is one, `null` where the category has not earned a number.
 *
 * `null` means held for a human, which is what makes coverage and the
 * false-routing rate measure the policy the data supports rather than the one
 * currently configured.
 */
export function operatingThresholds(
  recommendations: readonly ThresholdRecommendation[],
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const r of recommendations) {
    out.set(r.scope, r.verdict === "recommended" ? (r.recommended?.threshold ?? null) : null);
  }
  return out;
}

function pctText(v: number | null): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

export { pctText };

/** Exported so callers can reason about, or replace, the default sweep. */
export { DEFAULT_CANDIDATES };
