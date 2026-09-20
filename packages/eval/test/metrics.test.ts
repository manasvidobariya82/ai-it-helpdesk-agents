import { describe, expect, it } from "vitest";
import {
  accuracy,
  calibrationBins,
  calibrationSummary,
  classMetrics,
  confusions,
  macroF1,
  wilsonLowerBound,
  type Prediction,
} from "@hd/eval";

function p(
  id: string,
  predicted: string,
  actual: string,
  confidence: number,
): Prediction {
  return { id, predicted, actual, confidence };
}

describe("accuracy", () => {
  it("reports nulls rather than zero on an empty set", () => {
    const a = accuracy([]);
    expect(a.n).toBe(0);
    expect(a.accuracy).toBeNull();
    expect(a.lower_bound).toBeNull();
  });

  it("counts exact label matches", () => {
    const a = accuracy([
      p("1", "hardware", "hardware", 0.9),
      p("2", "hardware", "software", 0.8),
      p("3", "software", "software", 0.7),
      p("4", "network_connectivity", "network_connectivity", 0.99),
    ]);
    expect(a.correct).toBe(3);
    expect(a.accuracy).toBe(0.75);
  });
});

describe("wilsonLowerBound", () => {
  it("is far below the point estimate when n is small", () => {
    // The case the threshold recommender exists to refuse: three for three
    // looks like 100% accuracy and is worth about 44%.
    expect(wilsonLowerBound(3, 3)).toBeGreaterThan(0.4);
    expect(wilsonLowerBound(3, 3)).toBeLessThan(0.5);
  });

  it("converges towards the point estimate as n grows", () => {
    expect(wilsonLowerBound(950, 1000)).toBeGreaterThan(0.93);
    expect(wilsonLowerBound(950, 1000)).toBeLessThan(0.95);
  });

  it("is zero for an empty sample", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
});

describe("classMetrics", () => {
  const preds = [
    // hardware: 2 right, 1 missed (called software)
    p("1", "hardware", "hardware", 0.9),
    p("2", "hardware", "hardware", 0.9),
    p("3", "software", "hardware", 0.6),
    // software: 1 right, 1 false positive above
    p("4", "software", "software", 0.8),
    // other: predicted once, never actual
    p("5", "other", "software", 0.4),
  ];

  it("computes precision, recall and F1 per class", () => {
    const m = classMetrics(preds);
    const hardware = m.find((c) => c.label === "hardware")!;
    expect(hardware.tp).toBe(2);
    expect(hardware.fn).toBe(1);
    expect(hardware.fp).toBe(0);
    expect(hardware.precision).toBe(1);
    expect(hardware.recall).toBeCloseTo(2 / 3, 10);
    expect(hardware.f1).toBeCloseTo(0.8, 10);

    const software = m.find((c) => c.label === "software")!;
    expect(software.tp).toBe(1);
    expect(software.fp).toBe(1);
    expect(software.fn).toBe(1);
    expect(software.precision).toBe(0.5);
    expect(software.recall).toBe(0.5);
  });

  it("leaves recall undefined for a class with no ground-truth support", () => {
    const other = classMetrics(preds).find((c) => c.label === "other")!;
    expect(other.support).toBe(0);
    expect(other.recall).toBeNull();
    expect(other.precision).toBe(0);
  });

  it("excludes zero-support classes from the macro average", () => {
    // `other` is never a true label. Averaging a null F1 in as 0 would punish
    // the classifier for a category that was not in the sample.
    const m = classMetrics(preds);
    expect(macroF1(m)).toBeCloseTo((0.8 + 0.5) / 2, 10);
  });
});

describe("confusions", () => {
  it("lists only mistakes, largest first", () => {
    const c = confusions([
      p("1", "software", "hardware", 0.6),
      p("2", "software", "hardware", 0.6),
      p("3", "other", "hardware", 0.5),
      p("4", "hardware", "hardware", 0.9),
    ]);
    expect(c).toHaveLength(2);
    expect(c[0]).toEqual({ actual: "hardware", predicted: "software", n: 2 });
    expect(c[1]!.n).toBe(1);
  });
});

describe("calibrationBins", () => {
  it("puts 1.0 in the top bin rather than off the end", () => {
    const bins = calibrationBins([p("1", "a", "a", 1)], 10);
    expect(bins[9]!.n).toBe(1);
  });

  it("reports the correction rate as the complement of accuracy", () => {
    const bins = calibrationBins(
      [
        p("1", "a", "a", 0.95),
        p("2", "a", "b", 0.95),
        p("3", "a", "a", 0.95),
        p("4", "a", "a", 0.95),
      ],
      10,
    );
    const top = bins[9]!;
    expect(top.n).toBe(4);
    expect(top.accuracy).toBe(0.75);
    expect(top.correction_rate).toBe(0.25);
    expect(top.gap).toBeCloseTo(0.75 - 0.95, 10);
  });
});

describe("calibrationSummary", () => {
  it("is zero when stated confidence matches observed accuracy", () => {
    // Ten predictions at 0.90, nine of them right. Perfectly calibrated.
    const preds = Array.from({ length: 10 }, (_v, i) =>
      p(String(i), "a", i === 0 ? "b" : "a", 0.9),
    );
    const summary = calibrationSummary(preds, { minBinN: 1 });
    expect(summary.ece).toBeCloseTo(0, 10);
    expect(summary.mce).toBeCloseTo(0, 10);
  });

  it("measures the gap when the model is overconfident", () => {
    // Says 0.99, right half the time.
    const preds = Array.from({ length: 10 }, (_v, i) =>
      p(String(i), "a", i % 2 === 0 ? "a" : "b", 0.99),
    );
    const summary = calibrationSummary(preds, { minBinN: 1 });
    expect(summary.ece).toBeCloseTo(0.49, 10);
    expect(summary.brier).toBeCloseTo((0.01 ** 2 + 0.99 ** 2) / 2, 10);
  });

  it("ignores thin buckets when picking the worst one", () => {
    const preds: Prediction[] = [
      // 40 well-calibrated samples at 0.95
      ...Array.from({ length: 40 }, (_v, i) =>
        p(`hi${i}`, "a", i < 38 ? "a" : "b", 0.95),
      ),
      // one wild miss at 0.35, which is not a calibration finding
      p("lonely", "a", "b", 0.35),
    ];
    const summary = calibrationSummary(preds, { minBinN: 30 });
    expect(summary.mce_bin).toBe("0.90-1.00");
    expect(summary.mce!).toBeLessThan(0.05);
    // The thin bucket still shows in the table, it just does not set the gate.
    expect(summary.bins.find((b) => b.label === "0.30-0.40")!.n).toBe(1);
  });

  it("returns nulls rather than a passing zero on an empty set", () => {
    const summary = calibrationSummary([]);
    expect(summary.ece).toBeNull();
    expect(summary.mce).toBeNull();
    expect(summary.brier).toBeNull();
  });
});
