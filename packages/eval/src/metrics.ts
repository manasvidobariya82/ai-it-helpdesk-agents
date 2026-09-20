/**
 * Classification metrics, deliberately pure.
 *
 * Every number the console shows and every number the CLI gates on comes from
 * this file. A second implementation behind the dashboard is how a threshold
 * ends up justified by one calculation and enforced by another.
 *
 * Nothing here touches the database, a model, or the clock, so the tests can
 * assert exact values against hand-worked examples.
 */

/** One scored prediction. `confidence` is the model's own 0-1 self-report. */
export interface Prediction {
  id: string;
  predicted: string;
  actual: string;
  confidence: number;
}

export interface Accuracy {
  n: number;
  correct: number;
  accuracy: number | null;
  /** Wilson 95% lower bound. The honest number when n is small. */
  lower_bound: number | null;
}

export function accuracy(preds: readonly Prediction[]): Accuracy {
  const n = preds.length;
  const correct = preds.reduce((acc, p) => acc + (p.predicted === p.actual ? 1 : 0), 0);
  if (n === 0) return { n: 0, correct: 0, accuracy: null, lower_bound: null };
  return {
    n,
    correct,
    accuracy: correct / n,
    lower_bound: wilsonLowerBound(correct, n),
  };
}

/**
 * Wilson score interval, lower bound only.
 *
 * Used everywhere a decision depends on an observed rate. 3 correct out of 3
 * is an accuracy of 1.0 and a lower bound of 0.44, and only the second number
 * should be allowed to widen autonomy. z defaults to 1.96 (95%).
 */
export function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

export interface ClassMetric {
  label: string;
  /** Rows whose *actual* label is this class. */
  support: number;
  /** Rows the model *assigned* to this class. */
  predicted: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

/**
 * Per-class precision/recall/F1 for single-label multiclass.
 *
 * Precision and recall are `null`, not 0, when the denominator is empty: a
 * class the model never predicted has undefined precision, and averaging a
 * fabricated zero into the macro score quietly punishes the model for a class
 * that was never in the sample.
 */
export function classMetrics(preds: readonly Prediction[]): ClassMetric[] {
  const labels = new Set<string>();
  for (const p of preds) {
    labels.add(p.actual);
    labels.add(p.predicted);
  }

  const out: ClassMetric[] = [];
  for (const label of [...labels].sort()) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const p of preds) {
      if (p.predicted === label && p.actual === label) tp += 1;
      else if (p.predicted === label) fp += 1;
      else if (p.actual === label) fn += 1;
    }
    const precision = tp + fp === 0 ? null : tp / (tp + fp);
    const recall = tp + fn === 0 ? null : tp / (tp + fn);
    const f1 =
      precision === null || recall === null
        ? null
        : precision + recall === 0
          ? 0
          : (2 * precision * recall) / (precision + recall);
    out.push({
      label,
      support: tp + fn,
      predicted: tp + fp,
      tp,
      fp,
      fn,
      precision,
      recall,
      f1,
    });
  }
  return out;
}

/**
 * Macro F1 over classes that actually appear in the ground truth.
 *
 * Classes with no support are excluded: a category nobody filed a ticket for
 * should not move the score in either direction.
 */
export function macroF1(metrics: readonly ClassMetric[]): number | null {
  const scored = metrics.filter((m) => m.support > 0 && m.f1 !== null);
  if (scored.length === 0) return null;
  return scored.reduce((acc, m) => acc + (m.f1 ?? 0), 0) / scored.length;
}

export interface ConfusionCell {
  actual: string;
  predicted: string;
  n: number;
}

/** Off-diagonal cells only, largest first: the list of mistakes worth reading. */
export function confusions(preds: readonly Prediction[]): ConfusionCell[] {
  const counts = new Map<string, ConfusionCell>();
  for (const p of preds) {
    if (p.predicted === p.actual) continue;
    const key = `${p.actual}>${p.predicted}`;
    const cell = counts.get(key);
    if (cell) cell.n += 1;
    else counts.set(key, { actual: p.actual, predicted: p.predicted, n: 1 });
  }
  return [...counts.values()].sort(
    (a, b) => b.n - a.n || a.actual.localeCompare(b.actual),
  );
}

export interface CalibrationBin {
  /** Inclusive lower edge. */
  lo: number;
  /** Exclusive upper edge, except the last bin which includes 1.0. */
  hi: number;
  label: string;
  n: number;
  mean_confidence: number | null;
  accuracy: number | null;
  /** accuracy - mean_confidence. Negative means overconfident. */
  gap: number | null;
  /** The number the dashboard shows: how often a human had to fix this bin. */
  correction_rate: number | null;
}

/**
 * Confidence bins with their observed accuracy.
 *
 * Bins are fixed-width rather than equal-count on purpose: the operator
 * question is "when the agent says 0.9, is it right 90 percent of the time",
 * and that question is about the stated number, not about the population
 * quantile.
 */
export function calibrationBins(
  preds: readonly Prediction[],
  bins = 10,
): CalibrationBin[] {
  const width = 1 / bins;
  const out: CalibrationBin[] = [];

  for (let i = 0; i < bins; i += 1) {
    const lo = i * width;
    const hi = (i + 1) * width;
    const isLast = i === bins - 1;
    const members = preds.filter((p) => {
      const c = clamp01(p.confidence);
      return c >= lo && (isLast ? c <= hi : c < hi);
    });

    const n = members.length;
    const correct = members.reduce(
      (acc, p) => acc + (p.predicted === p.actual ? 1 : 0),
      0,
    );
    const meanConf =
      n === 0 ? null : members.reduce((acc, p) => acc + clamp01(p.confidence), 0) / n;
    const acc = n === 0 ? null : correct / n;

    out.push({
      lo,
      hi,
      label: `${lo.toFixed(2)}-${hi.toFixed(2)}`,
      n,
      mean_confidence: meanConf,
      accuracy: acc,
      gap: acc === null || meanConf === null ? null : acc - meanConf,
      correction_rate: acc === null ? null : 1 - acc,
    });
  }

  return out;
}

export interface CalibrationSummary {
  bins: CalibrationBin[];
  /** Support-weighted mean |accuracy - confidence|. The headline number. */
  ece: number | null;
  /** Worst single bin, restricted to bins with enough samples to mean anything. */
  mce: number | null;
  /** Which bin produced the MCE, so the report can name it. */
  mce_bin: string | null;
  /** Mean squared error of confidence against correctness. Lower is better. */
  brier: number | null;
  /** Bins with fewer than this many samples were excluded from mce. */
  min_bin_n: number;
  n: number;
}

export function calibrationSummary(
  preds: readonly Prediction[],
  opts: { bins?: number; minBinN?: number } = {},
): CalibrationSummary {
  const bins = calibrationBins(preds, opts.bins ?? 10);
  const minBinN = opts.minBinN ?? 30;
  const n = preds.length;

  const populated = bins.filter((b) => b.n > 0 && b.gap !== null);
  const ece =
    n === 0 || populated.length === 0
      ? null
      : populated.reduce((acc, b) => acc + (b.n / n) * Math.abs(b.gap ?? 0), 0);

  // The MCE deliberately ignores thin bins. One ticket in the 0.3 bucket is
  // not a calibration failure, and letting it dominate the worst-bin number
  // trains people to ignore the worst-bin number.
  let mce: number | null = null;
  let mceBin: string | null = null;
  for (const b of bins) {
    if (b.n < minBinN || b.gap === null) continue;
    const g = Math.abs(b.gap);
    if (mce === null || g > mce) {
      mce = g;
      mceBin = b.label;
    }
  }

  const brier =
    n === 0
      ? null
      : preds.reduce((acc, p) => {
          const c = clamp01(p.confidence);
          const y = p.predicted === p.actual ? 1 : 0;
          return acc + (c - y) ** 2;
        }, 0) / n;

  return { bins, ece, mce, mce_bin: mceBin, brier, min_bin_n: minBinN, n };
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}
