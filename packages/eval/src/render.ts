import type { RegressionResult } from "./baseline.js";
import type { EvalReport, Gate } from "./report.js";
import { pct } from "./report.js";
import type { RoutingOutcome } from "./routing.js";
import type { ThresholdRecommendation } from "./thresholds.js";

/**
 * Plain-text rendering for the CLI.
 *
 * A report nobody reads gates nothing, so this is written to be read in a
 * terminal at a glance: the gates first, the threshold table second, the
 * per-class detail last.
 */
export function renderReport(report: EvalReport): string {
  const out: string[] = [];
  const rule = "-".repeat(72);

  out.push(rule);
  out.push(`Triage evaluation — ${report.source} — n=${report.n}`);
  out.push(
    `model=${report.model ?? "mixed/unknown"}  prompt=${report.prompt_version ?? "mixed/unknown"}  split=${report.dataset.split}`,
  );
  if (report.dataset.path) {
    out.push(`dataset=${report.dataset.path}  id=${report.dataset.dataset_id}`);
  }
  out.push(rule);

  out.push("");
  out.push("GATES");
  for (const g of report.gates) out.push(`  ${gateLine(g)}`);
  out.push("");
  out.push(
    report.passed
      ? "  All gates pass."
      : `  ${report.gates.filter((g) => g.status !== "pass").length} gate(s) not passing.`,
  );

  out.push("");
  out.push("ACCURACY");
  out.push(
    `  category  ${pct(report.category.overall.accuracy)}  (${report.category.overall.correct}/${report.category.overall.n}, lower bound ${pct(report.category.overall.lower_bound)}, macro F1 ${num(report.category.macro_f1)})`,
  );
  out.push(
    `  priority  ${pct(report.priority.overall.accuracy)}  (${report.priority.overall.correct}/${report.priority.overall.n}, macro F1 ${num(report.priority.macro_f1)})`,
  );

  out.push("");
  out.push("CALIBRATION");
  out.push(
    `  ECE ${num(report.calibration.ece, 4)}   worst bucket ${num(report.calibration.mce, 4)} (${report.calibration.mce_bin ?? "none with enough samples"})   Brier ${num(report.calibration.brier, 4)}`,
  );
  out.push("  bucket        n   conf    acc    gap   corrected");
  for (const b of report.calibration.bins) {
    if (b.n === 0) continue;
    out.push(
      `  ${b.label}  ${String(b.n).padStart(4)}  ${num(b.mean_confidence)}  ${num(b.accuracy)}  ${signed(b.gap)}  ${pct(b.correction_rate)}`,
    );
  }

  out.push("");
  out.push("THRESHOLDS");
  out.push(`  overall: ${report.thresholds.overall.note}`);
  for (const t of report.thresholds.by_category) out.push(thresholdLine(t));

  out.push("");
  out.push("ROUTING  (what the classification would cost)");
  if (report.team.labelled === 0) {
    out.push(
      "  No sample has a team on both sides, so coverage and false routing are",
    );
    out.push(
      "  unmeasured. Pass the tenant settings when scoring and the routing table",
    );
    out.push("  derives both.");
  } else {
    out.push(`  team accuracy ${pct(report.team.overall.accuracy)} over ${report.team.labelled} labelled ticket(s)`);
    out.push(`  under recommended thresholds: ${routingLine(report.routing.recommended)}`);
    if (report.routing.configured) {
      out.push(`  under configured thresholds:  ${routingLine(report.routing.configured)}`);
    }
    if (report.routing.never_auto.length > 0) {
      out.push(`  never automated by policy: ${report.routing.never_auto.join(", ")}`);
    }
    out.push(
      `  per category, under the ${report.routing.policy} thresholds:`,
    );
    out.push("  category                 thr     n  routed  misrouted  false-route");
    for (const c of report.routing.by_category) {
      const thr = c.never_auto ? "human" : c.threshold === null ? "hold" : c.threshold.toFixed(2);
      out.push(
        `  ${c.category.padEnd(22)}  ${thr.padStart(5)}  ${String(c.n).padStart(4)}  ${String(c.routed).padStart(6)}  ${String(c.misrouted).padStart(9)}  ${pct(c.false_routing_rate).padStart(11)}`,
      );
    }
    for (const m of report.routing.recommended.misroutes.slice(0, 5)) {
      out.push(
        `    MISROUTE ${m.id} conf ${m.confidence.toFixed(2)}: sent to ${m.from}, belonged in ${m.to}`,
      );
    }
  }

  out.push("");
  out.push("SAFETY SLICE");
  if (report.safety.status === "unmeasured") {
    out.push(
      "  Unmeasured. No sample carries a human security or destructive label,",
    );
    out.push(
      "  so the zero-misses gate has not been checked. Label the safety slice",
    );
    out.push("  before treating this as green.");
  } else {
    out.push(
      `  ${report.safety.misses.length} miss(es) over ${report.safety.security_positives} security and ${report.safety.destructive_positives} destructive positives (${report.safety.comparable} comparable samples, ${report.safety.false_alarms} false alarm(s)).`,
    );
    for (const m of report.safety.misses.slice(0, 10)) {
      out.push(`    MISS ${m.flag}  ${m.id}`);
    }
  }

  if (report.category.confusions.length > 0) {
    out.push("");
    out.push("TOP CONFUSIONS  (human label -> agent label)");
    for (const c of report.category.confusions.slice(0, 10)) {
      out.push(`  ${String(c.n).padStart(4)}  ${c.actual} -> ${c.predicted}`);
    }
  }

  out.push("");
  out.push("PER CATEGORY");
  out.push("  category                support  prec    recall  F1");
  for (const c of report.category.by_class) {
    out.push(
      `  ${c.label.padEnd(22)}  ${String(c.support).padStart(7)}  ${num(c.precision)}  ${num(c.recall)}  ${num(c.f1)}`,
    );
  }

  if (report.dataset.coverage) {
    const cov = report.dataset.coverage;
    out.push("");
    out.push(
      `DATASET  ${cov.n} reviewed of ${cov.total} (${cov.candidates} candidate, ${cov.rejected} rejected)`,
    );
    out.push(
      `         ${cov.train} train / ${cov.holdout} holdout, safety-labelled ${cov.safety_labelled}, label version(s) ${cov.label_versions.join(", ") || "none"}`,
    );
    if (cov.labelers.length) out.push(`         labelled by ${cov.labelers.join(", ")}`);
    if (cov.missing_categories.length) {
      out.push(`  no samples for: ${cov.missing_categories.join(", ")}`);
    }
    if (cov.unknown_categories.length) {
      out.push(`  labels outside the taxonomy: ${cov.unknown_categories.join(", ")}`);
    }
  }

  out.push("");
  return out.join("\n");
}

function gateLine(g: Gate): string {
  const mark = g.status === "pass" ? "PASS" : g.status === "fail" ? "FAIL" : "----";
  return `${mark}  ${g.label.padEnd(30)} ${gateObserved(g).padStart(8)}  target ${g.target}\n        ${g.note}`;
}

/** Observed and target have to read in the same units, or the table lies. */
export function gateObserved(g: Gate): string {
  if (g.observed === null) return "n/a";
  if (g.unit === "count") return String(g.observed);
  if (g.unit === "rate") return pct(g.observed);
  return g.observed.toFixed(4);
}

function routingLine(r: RoutingOutcome): string {
  return (
    `${r.routed} auto-routed (${pct(r.coverage)} coverage), ` +
    `${r.misrouted} misrouted = ${pct(r.false_routing_rate)} ` +
    `(95% upper bound ${pct(r.false_routing_upper_bound)}); ` +
    `${r.held} held for a human, ${r.held_correct} of which the agent had right`
  );
}

function thresholdLine(t: ThresholdRecommendation): string {
  const head = `  ${t.scope.padEnd(22)} n=${String(t.n).padStart(4)}  `;
  if (t.verdict === "recommended" && t.recommended) {
    const cur =
      t.current_threshold === null
        ? ""
        : `  configured ${t.current_threshold.toFixed(2)} (${t.current_holds ? "holds" : "NOT justified by this data"})`;
    return `${head}recommend ${t.recommended.threshold.toFixed(2)}  coverage ${pct(t.recommended.coverage)}  acc ${pct(t.recommended.accuracy)}  lb ${pct(t.recommended.lower_bound)}${cur}`;
  }
  if (t.verdict === "human_only") {
    return `${head}human review always — never automated by policy`;
  }
  if (t.verdict === "insufficient_data") {
    return `${head}insufficient data — keep in shadow`;
  }
  return `${head}NO defensible threshold — ${t.note}`;
}

export function renderRegression(result: RegressionResult): string {
  const out: string[] = [];
  out.push("-".repeat(72));
  out.push(`Regression vs baseline "${result.baseline_label}"`);
  out.push(`  ${result.reason}`);
  out.push("-".repeat(72));

  if (!result.comparable) {
    out.push("  NOT COMPARABLE — no verdict issued.");
    out.push("");
    return out.join("\n");
  }

  for (const d of result.deltas) {
    const mark =
      d.verdict === "worse"
        ? "WORSE"
        : d.verdict === "better"
          ? "better"
          : d.verdict === "same"
            ? "same "
            : "---- ";
    out.push(
      `  ${mark}  ${d.metric.padEnd(20)} ${num(d.baseline, 4)} -> ${num(d.current, 4)}  (${signed(d.delta, 4)}, tolerance ${d.tolerance})`,
    );
  }
  out.push("");
  out.push(
    result.passed
      ? "  No regression beyond tolerance."
      : `  ${result.regressions.length} regression(s): ${result.regressions.map((r) => r.metric).join(", ")}`,
  );
  out.push("");
  return out.join("\n");
}

function num(v: number | null, digits = 3): string {
  return v === null ? "  n/a" : v.toFixed(digits);
}

function signed(v: number | null, digits = 3): string {
  if (v === null) return "  n/a";
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
}
