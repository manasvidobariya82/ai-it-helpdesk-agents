import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { EvalReport } from "./report.js";

/**
 * Regression gate for model and prompt changes.
 *
 * The prompt registry writes a version with every call precisely so that a
 * drop in accuracy can be attributed to a prompt edit rather than to a model
 * swap or a shift in the ticket mix. This file is the other half of that
 * argument: a stored baseline, and a comparison that refuses to run across
 * two different datasets.
 */

export const Baseline = z.object({
  created_at: z.string(),
  label: z.string(),
  model: z.string().nullable(),
  prompt_version: z.string().nullable(),
  dataset_id: z.string().nullable(),
  dataset_path: z.string().nullable(),
  split: z.string(),
  /**
   * Model, prompt, taxonomy, routing rules and threshold policy, hashed. A run
   * with a different fingerprint is a different configuration, not a delta.
   */
  fingerprint: z.string().nullable().default(null),
  fingerprint_parts: z.record(z.string(), z.string()).nullable().default(null),
  n: z.number().int(),
  metrics: z.object({
    category_accuracy: z.number().nullable(),
    category_macro_f1: z.number().nullable(),
    priority_accuracy: z.number().nullable(),
    team_accuracy: z.number().nullable().default(null),
    ece: z.number().nullable(),
    brier: z.number().nullable(),
    false_routing_rate: z.number().nullable().default(null),
    coverage: z.number().nullable().default(null),
    safety_misses: z.number().int(),
  }),
});
export type Baseline = z.infer<typeof Baseline>;

export function baselineFrom(
  report: EvalReport,
  label: string,
  fingerprint?: { hash: string; parts: Record<string, string> } | null,
): Baseline {
  return {
    created_at: report.generated_at,
    label,
    model: report.model,
    prompt_version: report.prompt_version,
    dataset_id: report.dataset.dataset_id,
    dataset_path: report.dataset.path,
    split: report.dataset.split,
    fingerprint: fingerprint?.hash ?? null,
    fingerprint_parts: fingerprint?.parts ?? null,
    n: report.n,
    metrics: {
      category_accuracy: report.category.overall.accuracy,
      category_macro_f1: report.category.macro_f1,
      priority_accuracy: report.priority.overall.accuracy,
      team_accuracy: report.team.overall.accuracy,
      ece: report.calibration.ece,
      brier: report.calibration.brier,
      false_routing_rate: report.routing.recommended.false_routing_rate,
      coverage: report.routing.recommended.coverage,
      safety_misses: report.safety.misses.length,
    },
  };
}

export interface RegressionTolerance {
  /** How far accuracy may fall before it counts as a regression. */
  accuracy_drop: number;
  macro_f1_drop: number;
  /** How far calibration error may rise. */
  ece_rise: number;
  brier_rise: number;
  /** How far the false-routing rate may rise. Tighter: it is the trust metric. */
  false_routing_rise: number;
  /** Coverage may fall a little; a cautious model is not a broken one. */
  coverage_drop: number;
}

export const DEFAULT_TOLERANCE: RegressionTolerance = {
  accuracy_drop: 0.02,
  macro_f1_drop: 0.03,
  ece_rise: 0.02,
  brier_rise: 0.02,
  false_routing_rise: 0.01,
  coverage_drop: 0.05,
};

export interface MetricDelta {
  metric: string;
  baseline: number | null;
  current: number | null;
  delta: number | null;
  /** `worse` only when it moved past the tolerance, not merely down. */
  verdict: "better" | "same" | "worse" | "unmeasured";
  tolerance: number;
}

export interface RegressionResult {
  comparable: boolean;
  reason: string;
  baseline_label: string;
  /** True when the model or prompt changed, which is the point of running this. */
  changed: { model: boolean; prompt: boolean; configuration: boolean };
  /** Which parts of the fingerprint moved, when it moved. */
  configuration_changes: string[];
  deltas: MetricDelta[];
  regressions: MetricDelta[];
  passed: boolean;
}

export function compareToBaseline(
  report: EvalReport,
  baseline: Baseline,
  tolerance: Partial<RegressionTolerance> = {},
  current?: { hash: string; parts: Record<string, string> } | null,
): RegressionResult {
  const tol = { ...DEFAULT_TOLERANCE, ...tolerance };

  const fpMoved =
    !!current &&
    baseline.fingerprint !== null &&
    baseline.fingerprint !== current.hash;

  // Name the part that moved. "Configuration changed" sends somebody reading
  // diffs; "routing changed" sends them to one file.
  const configurationChanges =
    fpMoved && baseline.fingerprint_parts
      ? Object.keys(current.parts).filter(
          (k) => baseline.fingerprint_parts![k] !== current.parts[k],
        )
      : [];

  const changed = {
    model: baseline.model !== report.model,
    prompt: baseline.prompt_version !== report.prompt_version,
    configuration: fpMoved,
  };

  // Comparing scores across two different label sets is not a regression test,
  // it is a coincidence. Refuse rather than produce a number that looks real.
  if (
    baseline.dataset_id !== null &&
    report.dataset.dataset_id !== null &&
    baseline.dataset_id !== report.dataset.dataset_id
  ) {
    return {
      comparable: false,
      reason: `Dataset changed (${baseline.dataset_id} -> ${report.dataset.dataset_id}). Re-baseline before comparing.`,
      baseline_label: baseline.label,
      changed,
      configuration_changes: configurationChanges,
      deltas: [],
      regressions: [],
      passed: false,
    };
  }

  if (baseline.split !== report.dataset.split) {
    return {
      comparable: false,
      reason: `Split changed (${baseline.split} -> ${report.dataset.split}).`,
      baseline_label: baseline.label,
      changed,
      configuration_changes: configurationChanges,
      deltas: [],
      regressions: [],
      passed: false,
    };
  }

  const deltas: MetricDelta[] = [
    higherIsBetter(
      "category_accuracy",
      baseline.metrics.category_accuracy,
      report.category.overall.accuracy,
      tol.accuracy_drop,
    ),
    higherIsBetter(
      "category_macro_f1",
      baseline.metrics.category_macro_f1,
      report.category.macro_f1,
      tol.macro_f1_drop,
    ),
    higherIsBetter(
      "priority_accuracy",
      baseline.metrics.priority_accuracy,
      report.priority.overall.accuracy,
      tol.accuracy_drop,
    ),
    lowerIsBetter("ece", baseline.metrics.ece, report.calibration.ece, tol.ece_rise),
    lowerIsBetter(
      "brier",
      baseline.metrics.brier,
      report.calibration.brier,
      tol.brier_rise,
    ),
    higherIsBetter(
      "team_accuracy",
      baseline.metrics.team_accuracy,
      report.team.overall.accuracy,
      tol.accuracy_drop,
    ),
    lowerIsBetter(
      "false_routing_rate",
      baseline.metrics.false_routing_rate,
      report.routing.recommended.false_routing_rate,
      tol.false_routing_rise,
    ),
    higherIsBetter(
      "coverage",
      baseline.metrics.coverage,
      report.routing.recommended.coverage,
      tol.coverage_drop,
    ),
    // Safety has no tolerance. One new miss is a regression.
    lowerIsBetter(
      "safety_misses",
      baseline.metrics.safety_misses,
      report.safety.misses.length,
      0,
    ),
  ];

  const regressions = deltas.filter((d) => d.verdict === "worse");

  return {
    comparable: true,
    reason: describeChange(changed, configurationChanges),
    baseline_label: baseline.label,
    changed,
    configuration_changes: configurationChanges,
    deltas,
    regressions,
    passed: regressions.length === 0,
  };
}

function higherIsBetter(
  metric: string,
  base: number | null,
  current: number | null,
  tolerance: number,
): MetricDelta {
  if (base === null || current === null) {
    return { metric, baseline: base, current, delta: null, verdict: "unmeasured", tolerance };
  }
  const delta = current - base;
  return {
    metric,
    baseline: base,
    current,
    delta,
    verdict: delta < -tolerance ? "worse" : delta > 0 ? "better" : "same",
    tolerance,
  };
}

function lowerIsBetter(
  metric: string,
  base: number | null,
  current: number | null,
  tolerance: number,
): MetricDelta {
  if (base === null || current === null) {
    return { metric, baseline: base, current, delta: null, verdict: "unmeasured", tolerance };
  }
  const delta = current - base;
  return {
    metric,
    baseline: base,
    current,
    delta,
    verdict: delta > tolerance ? "worse" : delta < 0 ? "better" : "same",
    tolerance,
  };
}

function describeChange(
  changed: { model: boolean; prompt: boolean; configuration: boolean },
  configurationChanges: readonly string[],
): string {
  const parts: string[] = [];
  if (changed.model && changed.prompt) parts.push("Model and prompt both changed.");
  else if (changed.model) parts.push("Model changed, prompt unchanged.");
  else if (changed.prompt) parts.push("Prompt changed, model unchanged.");
  else parts.push("Same model and prompt version.");

  if (changed.configuration) {
    const named = configurationChanges.filter((c) => c !== "model" && c !== "prompt");
    parts.push(
      named.length > 0
        ? `Configuration also changed: ${named.join(", ")}.`
        : "Configuration fingerprint changed.",
    );
  }
  return parts.join(" ");
}

export async function loadBaseline(file: string): Promise<Baseline> {
  return Baseline.parse(JSON.parse(await fs.readFile(file, "utf8")));
}

export async function saveBaseline(file: string, baseline: Baseline): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}
