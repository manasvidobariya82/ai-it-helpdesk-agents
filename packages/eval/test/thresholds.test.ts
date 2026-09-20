import { describe, expect, it } from "vitest";
import {
  evaluateThreshold,
  recommendPerCategory,
  recommendThreshold,
  type Prediction,
} from "@hd/eval";

/**
 * Build a slice where confidence actually predicts correctness: everything at
 * or above `splitAt` is right, everything below it is wrong. A recommender
 * that cannot find the line in this data cannot find it anywhere.
 */
function separable(
  splitAt: number,
  n: number,
  category = "access_identity",
  wrong = "hardware",
): Prediction[] {
  return Array.from({ length: n }, (_v, i) => {
    const confidence = Number((0.5 + (i / n) * 0.49).toFixed(2));
    const correct = confidence >= splitAt;
    return {
      id: `${category}-${i}`,
      predicted: category,
      actual: correct ? category : wrong,
      confidence,
    };
  });
}

describe("evaluateThreshold", () => {
  it("splits coverage and accuracy either side of the line", () => {
    const preds = separable(0.8, 100);
    const point = evaluateThreshold(preds, 0.8, {
      targetAccuracy: 0.95,
      minSamples: 10,
    });
    expect(point.accuracy).toBe(1);
    expect(point.accuracy_below).toBe(0);
    expect(point.n + point.n_below).toBe(100);
    expect(point.coverage).toBeCloseTo(point.n / 100, 10);
  });
});

describe("recommendThreshold", () => {
  it("recommends the lowest threshold that proves the target", () => {
    // Among defensible thresholds the one that automates the most wins.
    const rec = recommendThreshold(separable(0.8, 200), {
      targetAccuracy: 0.95,
      minSamples: 30,
    });
    expect(rec.verdict).toBe("recommended");
    expect(rec.recommended!.threshold).toBeGreaterThanOrEqual(0.8);
    expect(rec.recommended!.threshold).toBeLessThan(0.9);
    expect(rec.recommended!.accuracy).toBe(1);
  });

  it("refuses to recommend from a handful of samples", () => {
    // Four for four is an accuracy of 1.0 and evidence of nothing.
    const preds: Prediction[] = Array.from({ length: 4 }, (_v, i) => ({
      id: `t${i}`,
      predicted: "hardware",
      actual: "hardware",
      confidence: 0.99,
    }));
    const rec = recommendThreshold(preds, { targetAccuracy: 0.95, minSamples: 30 });
    expect(rec.verdict).toBe("insufficient_data");
    expect(rec.recommended).toBeNull();
    expect(rec.note).toContain("shadow");
  });

  it("says the target is unreachable rather than picking the least bad dial", () => {
    // 200 samples, 70% right at every confidence level. No threshold fixes a
    // classifier that is wrong uniformly.
    const preds: Prediction[] = Array.from({ length: 200 }, (_v, i) => ({
      id: `t${i}`,
      predicted: "software",
      actual: i % 10 < 7 ? "software" : "hardware",
      confidence: 0.5 + (i % 50) / 100,
    }));
    const rec = recommendThreshold(preds, { targetAccuracy: 0.95, minSamples: 30 });
    expect(rec.verdict).toBe("target_unreachable");
    expect(rec.recommended).toBeNull();
    expect(rec.note).toContain("Fix the classifier");
  });

  it("judges the configured threshold against the same evidence", () => {
    const rec = recommendThreshold(separable(0.8, 200), {
      targetAccuracy: 0.95,
      minSamples: 30,
      currentThreshold: 0.6,
    });
    // 0.6 is below the line where this classifier becomes reliable, so the
    // number sitting in settings today is not justified by the data.
    expect(rec.current_threshold).toBe(0.6);
    expect(rec.current_holds).toBe(false);
    expect(rec.current!.accuracy!).toBeLessThan(0.95);
  });

  it("confirms a configured threshold stricter than the recommendation", () => {
    // 0.85 automates a strict subset of what the recommended line automates,
    // so it holds even though the thinner sample above it cannot prove 95% on
    // its own. Failing it here would push operators towards looser dials to
    // satisfy the report.
    const rec = recommendThreshold(separable(0.8, 200), {
      targetAccuracy: 0.95,
      minSamples: 30,
      currentThreshold: 0.85,
    });
    expect(rec.current!.meets_target).toBe(false);
    expect(rec.current!.threshold).toBeGreaterThan(rec.recommended!.threshold);
    expect(rec.current_holds).toBe(true);
  });
});

describe("recommendPerCategory", () => {
  it("groups by the agent's label, because that is what the gate sees", () => {
    const preds: Prediction[] = [
      ...separable(0.8, 200, "access_identity", "hardware"),
      ...separable(0.9, 600, "hardware", "software"),
    ];
    const recs = recommendPerCategory(preds, {
      targetAccuracy: 0.95,
      minSamples: 30,
      currentFor: (c) => (c === "hardware" ? 0.7 : 0.95),
    });

    expect(recs.map((r) => r.scope).sort()).toEqual(["access_identity", "hardware"]);
    const hardware = recs.find((r) => r.scope === "hardware")!;
    expect(hardware.current_threshold).toBe(0.7);
    // Categories calibrate differently — that is why the setting is per
    // category — and the recommendation follows the category's own data.
    expect(hardware.recommended!.threshold).toBeGreaterThanOrEqual(0.9);
  });
});
