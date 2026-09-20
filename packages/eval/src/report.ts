import {
  accuracy,
  calibrationSummary,
  classMetrics,
  confusions,
  macroF1,
  type Accuracy,
  type CalibrationSummary,
  type ClassMetric,
  type ConfusionCell,
  type Prediction,
} from "./metrics.js";
import {
  datasetCoverage,
  type DatasetCoverage,
  type GoldenLabel,
  type GoldenSample,
} from "./sample.js";
import {
  operatingThresholds,
  recommendPerCategory,
  recommendThreshold,
  type ThresholdRecommendation,
} from "./thresholds.js";
import {
  routingByCategory,
  routingOutcome,
  type CategoryRouting,
  type RoutingOutcome,
  type RoutingSample,
} from "./routing.js";

/**
 * A scored run: what the agent said next to what a human said, for one slice
 * of one dataset. The same shape whether the predictions came out of
 * `triage_shadow` or out of a fresh replay, so the scoring code has one path.
 */
export interface ScoredSample {
  id: string;
  predicted: {
    category: string;
    priority: string;
    confidence: number;
    /** Where the routing table would have sent it. Derived, not stored. */
    team?: string | null;
    is_security_sensitive?: boolean | null;
    is_destructive_request?: boolean | null;
  };
  actual: GoldenLabel;
}

export type GateStatus = "pass" | "fail" | "unmeasured";

export interface Gate {
  id: string;
  label: string;
  status: GateStatus;
  observed: number | null;
  /** How to render `observed`, so the table does not mix 0.7654 with 90.0%. */
  unit: "rate" | "score" | "count";
  target: string;
  note: string;
}

export interface SafetyMiss {
  id: string;
  flag: "security_sensitive" | "destructive";
}

export interface SafetySlice {
  /** Samples carrying a human safety label *and* an agent flag to compare. */
  comparable: number;
  security_positives: number;
  destructive_positives: number;
  misses: SafetyMiss[];
  /** Agent flagged it, human did not. Cheap; tracked, not gated. */
  false_alarms: number;
  status: GateStatus;
}

export interface EvalReport {
  generated_at: string;
  dataset: {
    path: string | null;
    dataset_id: string | null;
    split: string;
    coverage: DatasetCoverage | null;
  };
  source: "shadow" | "replay" | "dataset";
  model: string | null;
  prompt_version: string | null;
  n: number;
  category: {
    overall: Accuracy;
    macro_f1: number | null;
    by_class: ClassMetric[];
    confusions: ConfusionCell[];
  };
  priority: {
    overall: Accuracy;
    macro_f1: number | null;
    by_class: ClassMetric[];
  };
  /** Team routing, scored only where a team label exists on both sides. */
  team: {
    overall: Accuracy;
    labelled: number;
  };
  calibration: CalibrationSummary;
  thresholds: {
    overall: ThresholdRecommendation;
    by_category: ThresholdRecommendation[];
  };
  /**
   * What the classification would cost in practice, under two policies: the
   * thresholds configured in `businesses.settings` today, and the ones this
   * data supports. The gap between them is the argument for changing the dial.
   */
  routing: {
    configured: RoutingOutcome | null;
    recommended: RoutingOutcome;
    /** Which of the two the per-category table and the gate describe. */
    policy: "configured" | "recommended";
    by_category: CategoryRouting[];
    never_auto: string[];
  };
  safety: SafetySlice;
  gates: Gate[];
  passed: boolean;
}

export interface ScoreOptions {
  source?: "shadow" | "replay" | "dataset";
  datasetPath?: string | null;
  datasetId?: string | null;
  split?: string;
  samples?: readonly GoldenSample[];
  taxonomy?: readonly string[];
  model?: string | null;
  promptVersion?: string | null;
  /** Current per-category thresholds from `businesses.settings`. */
  currentThresholdFor?: (category: string) => number | null;
  /** Categories no threshold may open, from `settings.never_auto_categories`. */
  neverAuto?: readonly string[];
  /**
   * Share of triaged tickets in the window that ever got a human outcome.
   * Supplied by the caller because only the database knows the denominator —
   * the harness sees the labelled rows, not the unlabelled ones.
   */
  outcomeCoverage?: { labelled: number; triaged: number } | null;
  /** Whether a regression run is wired into CI. Gated, so it cannot be assumed. */
  regressionAutomated?: boolean;
  gates?: Partial<GateTargets>;
}

export interface GateTargets {
  min_dataset_size: number;
  min_category_accuracy: number;
  /** Per category, not just overall. One good category can hide three bad ones. */
  min_per_category_accuracy: number;
  /** Categories below this many samples are not held to the per-category gate. */
  min_category_n: number;
  max_ece: number;
  max_bin_gap: number;
  min_bin_n: number;
  max_correction_rate: number;
  max_false_routing_rate: number;
  /** Share of triaged tickets that must have a human outcome recorded. */
  min_outcome_coverage: number;
  /** Accuracy a category threshold must prove before autonomy widens. */
  threshold_target_accuracy: number;
  threshold_min_samples: number;
}

/** P2's exit criteria, expressed as numbers a script can check. */
export const DEFAULT_GATES: GateTargets = {
  min_dataset_size: 100,
  min_category_accuracy: 0.9,
  min_per_category_accuracy: 0.85,
  min_category_n: 20,
  max_ece: 0.05,
  max_bin_gap: 0.05,
  min_bin_n: 30,
  max_correction_rate: 0.15,
  max_false_routing_rate: 0.05,
  min_outcome_coverage: 0.9,
  threshold_target_accuracy: 0.95,
  threshold_min_samples: 30,
};

export function scoreRun(
  scored: readonly ScoredSample[],
  opts: ScoreOptions = {},
): EvalReport {
  const gates = { ...DEFAULT_GATES, ...(opts.gates ?? {}) };

  const categoryPreds: Prediction[] = scored.map((s) => ({
    id: s.id,
    predicted: s.predicted.category,
    actual: s.actual.category,
    confidence: s.predicted.confidence,
  }));

  // Priority shares the ticket's single confidence score because the prompt
  // asks for one number covering both. That is worth remembering when reading
  // the priority calibration: it is the same self-report, scored against a
  // different label.
  const priorityPreds: Prediction[] = scored.map((s) => ({
    id: s.id,
    predicted: s.predicted.priority,
    actual: s.actual.priority,
    confidence: s.predicted.confidence,
  }));

  // Team is scored only where both sides have one. A sample nobody gave an
  // expected team is not a routing success.
  const teamPreds: Prediction[] = scored
    .filter((s) => s.predicted.team != null && s.actual.team != null)
    .map((s) => ({
      id: s.id,
      predicted: s.predicted.team!,
      actual: s.actual.team!,
      confidence: s.predicted.confidence,
    }));

  const catClasses = classMetrics(categoryPreds);
  const priClasses = classMetrics(priorityPreds);
  const catAccuracy = accuracy(categoryPreds);
  const calibration = calibrationSummary(categoryPreds, {
    minBinN: gates.min_bin_n,
  });
  const safety = scoreSafety(scored);

  const neverAuto = new Set(opts.neverAuto ?? []);
  const byCategory = recommendPerCategory(categoryPreds, {
    targetAccuracy: gates.threshold_target_accuracy,
    minSamples: gates.threshold_min_samples,
    neverAuto,
    ...(opts.currentThresholdFor ? { currentFor: opts.currentThresholdFor } : {}),
  });

  const routingSamples: RoutingSample[] = scored
    .filter((s) => s.predicted.team != null && s.actual.team != null)
    .map((s) => ({
      id: s.id,
      category: s.predicted.category,
      confidence: s.predicted.confidence,
      predicted_team: s.predicted.team!,
      actual_team: s.actual.team!,
      category_correct: s.predicted.category === s.actual.category,
    }));

  const operating = operatingThresholds(byCategory);
  const recommendedPolicy = {
    thresholdFor: (c: string) => operating.get(c) ?? null,
    neverAuto,
  };
  const configuredPolicy = opts.currentThresholdFor
    ? { thresholdFor: opts.currentThresholdFor, neverAuto }
    : null;

  const report: EvalReport = {
    generated_at: new Date().toISOString(),
    dataset: {
      path: opts.datasetPath ?? null,
      dataset_id: opts.datasetId ?? null,
      split: opts.split ?? "all",
      coverage:
        opts.samples && opts.taxonomy
          ? datasetCoverage(opts.samples, opts.taxonomy)
          : null,
    },
    source: opts.source ?? "dataset",
    model: opts.model ?? null,
    prompt_version: opts.promptVersion ?? null,
    n: scored.length,
    category: {
      overall: catAccuracy,
      macro_f1: macroF1(catClasses),
      by_class: catClasses,
      confusions: confusions(categoryPreds),
    },
    priority: {
      overall: accuracy(priorityPreds),
      macro_f1: macroF1(priClasses),
      by_class: priClasses,
    },
    team: {
      overall: accuracy(teamPreds),
      labelled: teamPreds.length,
    },
    calibration,
    thresholds: {
      overall: recommendThreshold(categoryPreds, {
        targetAccuracy: gates.threshold_target_accuracy,
        minSamples: gates.threshold_min_samples,
        scope: "__all__",
      }),
      by_category: byCategory,
    },
    routing: {
      configured: configuredPolicy
        ? routingOutcome(routingSamples, configuredPolicy)
        : null,
      recommended: routingOutcome(routingSamples, recommendedPolicy),
      policy: configuredPolicy ? "configured" : "recommended",
      // Broken down under the policy in force, because the per-category table
      // is where somebody looks to find which queue is absorbing the mistakes,
      // and that is a question about production, not about a proposal.
      by_category: routingByCategory(
        routingSamples,
        configuredPolicy ?? recommendedPolicy,
      ),
      never_auto: [...neverAuto].sort(),
    },
    safety,
    gates: [],
    passed: false,
  };

  report.gates = buildGates(report, gates, opts);
  report.passed = report.gates.every((g) => g.status === "pass");
  return report;
}

function scoreSafety(scored: readonly ScoredSample[]): SafetySlice {
  const misses: SafetyMiss[] = [];
  let comparable = 0;
  let securityPositives = 0;
  let destructivePositives = 0;
  let falseAlarms = 0;

  for (const s of scored) {
    const secLabel = s.actual.is_security_sensitive;
    const destLabel = s.actual.is_destructive_request;
    const secPred = s.predicted.is_security_sensitive;
    const destPred = s.predicted.is_destructive_request;

    const secComparable = secLabel !== null && secPred !== null && secPred !== undefined;
    const destComparable =
      destLabel !== null && destPred !== null && destPred !== undefined;
    if (!secComparable && !destComparable) continue;
    comparable += 1;

    if (secComparable) {
      if (secLabel === true) {
        securityPositives += 1;
        if (secPred !== true) misses.push({ id: s.id, flag: "security_sensitive" });
      } else if (secPred === true) {
        falseAlarms += 1;
      }
    }
    if (destComparable) {
      if (destLabel === true) {
        destructivePositives += 1;
        if (destPred !== true) misses.push({ id: s.id, flag: "destructive" });
      } else if (destPred === true) {
        falseAlarms += 1;
      }
    }
  }

  return {
    comparable,
    security_positives: securityPositives,
    destructive_positives: destructivePositives,
    misses,
    false_alarms: falseAlarms,
    // An empty safety slice is `unmeasured`, never `pass`. Nothing was checked,
    // so nothing was proven, and the report has to say so out loud.
    status: comparable === 0 ? "unmeasured" : misses.length === 0 ? "pass" : "fail",
  };
}

function buildGates(
  report: EvalReport,
  targets: GateTargets,
  opts: ScoreOptions,
): Gate[] {
  const gates: Gate[] = [];
  const cov = report.dataset.coverage;

  gates.push({
    id: "dataset_size",
    label: "Labelled samples",
    unit: "count",
    status:
      report.n >= targets.min_dataset_size
        ? "pass"
        : report.n === 0
          ? "unmeasured"
          : "fail",
    observed: report.n,
    target: `>= ${targets.min_dataset_size}`,
    note:
      report.n >= targets.min_dataset_size
        ? "Enough labelled tickets for the rest of these numbers to mean something."
        : `${targets.min_dataset_size - report.n} more reconciled tickets needed.`,
  });

  // "A golden dataset exists" is a claim about reviewed labels, not about rows
  // in a file. A thousand unreviewed candidates are production feedback.
  if (cov) {
    gates.push({
      id: "golden_dataset_exists",
      label: "Reviewed golden samples",
      unit: "count",
      status:
        cov.n >= targets.min_dataset_size
          ? "pass"
          : cov.n === 0
            ? "unmeasured"
            : "fail",
      observed: cov.n,
      target: `>= ${targets.min_dataset_size} reviewed`,
      note:
        cov.n >= targets.min_dataset_size
          ? `${cov.n} reviewed by ${cov.labelers.length || "nobody named"}, label version(s) ${cov.label_versions.join(", ") || "none"}.`
          : `${cov.candidates} candidate(s) are waiting for review. Only reviewed samples are scored as golden.`,
    });
  }

  // Measurable outcomes: what share of triaged tickets ever got a human verdict.
  // Without it, every number above is computed on whatever slice happened to be
  // reviewed, and a biased slice measures the reviewers, not the classifier.
  const oc = opts.outcomeCoverage ?? null;
  const ocRate = oc && oc.triaged > 0 ? oc.labelled / oc.triaged : null;
  gates.push({
    id: "outcome_coverage",
    label: "Triage with a human outcome",
    unit: "rate",
    status:
      ocRate === null
        ? "unmeasured"
        : ocRate >= targets.min_outcome_coverage
          ? "pass"
          : "fail",
    observed: ocRate,
    target: `>= ${pct(targets.min_outcome_coverage)}`,
    note:
      ocRate === null
        ? "Caller did not supply the triaged-ticket denominator, so the labelled slice cannot be checked for bias."
        : `${oc!.labelled} of ${oc!.triaged} triaged tickets carry a human classification.`,
  });

  if (cov) {
    gates.push({
      id: "category_coverage",
      label: "Every category represented",
      unit: "count",
      status: cov.missing_categories.length === 0 ? "pass" : "fail",
      observed: cov.by_category.length,
      target: "every category in the taxonomy",
      note:
        cov.missing_categories.length === 0
          ? "No category is unlabelled."
          : `Missing: ${cov.missing_categories.join(", ")}.`,
    });
  }

  gates.push({
    id: "category_accuracy",
    label: "Classification accuracy",
    unit: "rate",
    status:
      report.category.overall.accuracy === null
        ? "unmeasured"
        : report.category.overall.accuracy >= targets.min_category_accuracy
          ? "pass"
          : "fail",
    observed: report.category.overall.accuracy,
    target: `>= ${pct(targets.min_category_accuracy)}`,
    note: `${report.category.overall.correct}/${report.category.overall.n} correct; 95% lower bound ${pct(report.category.overall.lower_bound)}.`,
  });

  gates.push({
    id: "calibration_ece",
    label: "Expected calibration error",
    unit: "score",
    status:
      report.calibration.ece === null
        ? "unmeasured"
        : report.calibration.ece <= targets.max_ece
          ? "pass"
          : "fail",
    observed: report.calibration.ece,
    target: `<= ${targets.max_ece.toFixed(2)}`,
    note:
      report.calibration.ece === null
        ? "No reconciled predictions to bin."
        : `When the agent says 0.9 it should be right 90% of the time; it is off by ${pct(report.calibration.ece)} on average.`,
  });

  const worstBin = report.calibration.mce;
  gates.push({
    id: "calibration_worst_bin",
    label: `Worst bucket (n >= ${targets.min_bin_n})`,
    unit: "score",
    status:
      worstBin === null
        ? "unmeasured"
        : worstBin <= targets.max_bin_gap
          ? "pass"
          : "fail",
    observed: worstBin,
    target: `<= ${targets.max_bin_gap.toFixed(2)}`,
    note:
      worstBin === null
        ? `No confidence bucket has ${targets.min_bin_n} samples yet.`
        : `Bucket ${report.calibration.mce_bin} is off by ${pct(worstBin)}.`,
  });

  const correctionRate =
    report.category.overall.accuracy === null
      ? null
      : 1 - report.category.overall.accuracy;
  gates.push({
    id: "correction_rate",
    label: "Human correction rate",
    unit: "rate",
    status:
      correctionRate === null
        ? "unmeasured"
        : correctionRate < targets.max_correction_rate
          ? "pass"
          : "fail",
    observed: correctionRate,
    target: `< ${pct(targets.max_correction_rate)}`,
    note: "Share of triaged tickets a human had to reclassify.",
  });

  // Per category, because an overall 91% can be four strong categories and two
  // that route half their tickets to the wrong desk.
  const weak = report.category.by_class.filter(
    (c) =>
      c.support >= targets.min_category_n &&
      c.recall !== null &&
      c.recall < targets.min_per_category_accuracy,
  );
  const eligible = report.category.by_class.filter(
    (c) => c.support >= targets.min_category_n,
  );
  gates.push({
    id: "per_category_accuracy",
    label: `Weakest category (n >= ${targets.min_category_n})`,
    unit: "rate",
    status:
      eligible.length === 0 ? "unmeasured" : weak.length === 0 ? "pass" : "fail",
    observed:
      eligible.length === 0
        ? null
        : Math.min(...eligible.map((c) => c.recall ?? 1)),
    target: `>= ${pct(targets.min_per_category_accuracy)} each`,
    note:
      eligible.length === 0
        ? `No category has ${targets.min_category_n} labelled tickets yet.`
        : weak.length === 0
          ? `All ${eligible.length} category/ies with enough data clear the bar.`
          : `Below the bar: ${weak.map((c) => `${c.label} ${pct(c.recall)}`).join(", ")}.`,
  });

  // Measured against the policy actually in force, falling back to the one the
  // data supports. Scoring only the recommended policy would report a clean
  // zero for a tenant whose configured thresholds misroute a fifth of their
  // traffic, because the recommendation holds those tickets and production
  // does not.
  const fr = report.routing.configured ?? report.routing.recommended;
  const policyName = report.routing.policy;
  gates.push({
    id: "false_routing_rate",
    label: "False-routing rate",
    unit: "rate",
    status:
      fr.false_routing_rate === null
        ? "unmeasured"
        : fr.false_routing_rate <= targets.max_false_routing_rate
          ? "pass"
          : "fail",
    observed: fr.false_routing_rate,
    target: `<= ${pct(targets.max_false_routing_rate)}`,
    note:
      fr.false_routing_rate === null
        ? `No ticket would auto-route under the ${policyName} thresholds, so nothing can be misrouted — and nothing is proven either.`
        : `Under ${policyName} thresholds, ${fr.misrouted} of ${fr.routed} auto-routed tickets reach the wrong team (95% upper bound ${pct(fr.false_routing_upper_bound)}). Coverage ${pct(fr.coverage)}.`,
  });

  // "Thresholds are data-derived" is checkable: every category that is
  // configured to automate must have a recommendation that supports it.
  const configured = report.thresholds.by_category.filter(
    (t) => t.current_threshold !== null && t.verdict !== "human_only",
  );
  const unjustified = configured.filter((t) => t.current_holds === false);
  gates.push({
    id: "thresholds_data_derived",
    label: "Configured thresholds justified",
    unit: "count",
    status:
      configured.length === 0
        ? "unmeasured"
        : unjustified.length === 0
          ? "pass"
          : "fail",
    observed: unjustified.length,
    target: "0 unjustified",
    note:
      configured.length === 0
        ? "No category has a configured threshold to check."
        : unjustified.length === 0
          ? `All ${configured.length} configured threshold(s) are supported by the observed data.`
          : `Not supported by the data: ${unjustified.map((t) => `${t.scope} @ ${t.current_threshold?.toFixed(2)}`).join(", ")}.`,
  });

  gates.push({
    id: "regression_automated",
    label: "Regression runs automatically",
    unit: "count",
    status:
      opts.regressionAutomated === undefined
        ? "unmeasured"
        : opts.regressionAutomated
          ? "pass"
          : "fail",
    observed: null,
    target: "wired into CI",
    note:
      opts.regressionAutomated === undefined
        ? "Caller did not say. A regression suite nobody runs is a regression suite that does not exist."
        : opts.regressionAutomated
          ? "A baseline is pinned and `npm run eval regress` gates the change."
          : "No pinned baseline for this dataset and model/prompt pair.",
  });

  gates.push({
    id: "safety_slice",
    label: "Safety slice misses",
    unit: "count",
    status: report.safety.status,
    observed: report.safety.misses.length,
    target: "0",
    note:
      report.safety.status === "unmeasured"
        ? "No sample carries a human security/destructive label. This gate is not passing, it is unchecked."
        : `${report.safety.misses.length} miss(es) across ${report.safety.security_positives + report.safety.destructive_positives} labelled positives.`,
  });

  return gates;
}

export function pct(v: number | null, digits = 1): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(digits)}%`;
}
