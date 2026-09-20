import type { GoldenComparison } from "./golden-baseline.js";
import type { GoldenCase } from "./golden-case.js";
import type { GoldenCoverage, LintIssue } from "./golden-set.js";
import type { CaseResult, GoldenSummary } from "./golden-score.js";
import { DIMENSIONS } from "./golden-score.js";
import { pct } from "./report.js";

/**
 * Plain-text rendering for `npm run eval golden`. The review state first,
 * because every number after it means something different when the labels
 * are drafts.
 */

const RULE = "-".repeat(72);

export function renderGoldenCoverage(cov: GoldenCoverage, issues: readonly LintIssue[]): string {
  const out: string[] = [];
  out.push(RULE);
  out.push(`Golden set — ${cov.total} case(s), ${cov.by_status.reviewed} reviewed`);
  out.push(RULE);
  out.push(
    `  status   draft ${cov.by_status.draft} · reviewed ${cov.by_status.reviewed} · needs changes ${cov.by_status.needs_changes} · rejected ${cov.by_status.rejected}`,
  );
  out.push(`  split    train ${cov.train} · holdout ${cov.holdout} (target holdout ${cov.targets.holdout_pct}%)`);
  out.push(
    `  target   ${cov.targets.total} reviewed in all, ${cov.targets.per_category} reviewed per category — ${cov.by_status.reviewed}/${cov.targets.total} so far`,
  );

  const cells = (title: string, xs: GoldenCoverage["by_category"]) => {
    out.push("");
    out.push(title);
    for (const x of xs) {
      out.push(`  ${x.key.padEnd(38)} ${String(x.n).padStart(3)}  (${x.reviewed} reviewed)`);
    }
  };
  cells("CATEGORY", cov.by_category);
  cells("SCENARIO", cov.by_scenario);
  cells("EXPECTED OUTCOME", cov.by_action);
  cells("SAFETY", [cov.security, cov.destructive, cov.injection]);
  cells("RUNBOOK THE CASE NEEDS", [...cov.by_runbook, { ...cov.no_runbook, key: "(no runbook covers it)" }]);

  out.push("");
  out.push("GAPS");
  const gaps: string[] = [];
  if (cov.missing_categories.length) gaps.push(`no case at all in: ${cov.missing_categories.join(", ")}`);
  if (cov.missing_scenarios.length) gaps.push(`no case for scenario: ${cov.missing_scenarios.join(", ")}`);
  if (cov.under_target.length) {
    gaps.push(`under ${cov.targets.per_category} reviewed: ${cov.under_target.join(", ")}`);
  }
  const unused = cov.by_runbook.filter((x) => x.n === 0).map((x) => x.key);
  if (unused.length) gaps.push(`runbooks no case needs: ${unused.join("; ")}`);
  out.push(...(gaps.length ? gaps.map((g) => `  ${g}`) : ["  none"]));

  out.push("");
  out.push(renderLint(issues));
  return out.join("\n");
}

/**
 * One case as prose, for the person reviewing it.
 *
 * The review is the gate on the whole of P2, and a hundred files of JSON is
 * the friction that stops it happening. This is the same content in the order
 * a reviewer needs it: what arrived, then what the case claims should happen,
 * then why. Nothing is summarised away — a reviewer who cannot see a field
 * cannot disagree with it.
 */
export function renderGoldenCase(c: GoldenCase): string {
  const out: string[] = [];
  const h2 = (title: string) => {
    out.push("");
    out.push(title);
    out.push("-".repeat(title.length));
  };
  const field = (label: string, value: string) => out.push(`  ${label.padEnd(20)} ${value}`);
  const list = (label: string, xs: readonly string[]) => {
    if (xs.length) field(label, xs.join(", "));
  };
  const indent = (text: string, by = "    ") =>
    text.split("\n").map((l) => `${by}${l}`).join("\n");

  const { input, expected: e, review } = c;
  const t = e.triage;

  out.push(RULE);
  out.push(`${c.id}  ${c.title}`);
  out.push(RULE);
  field("status", `${review.status}${review.reviewed_by ? ` by ${review.reviewed_by} on ${review.reviewed_at}` : ""}`);
  field("drafted by", `${review.authored_by} on ${review.authored_at}`);
  if (review.notes) field("notes", review.notes);
  field("split", `${c.split} (derived from the id)`);
  field("scenarios", c.scenarios.join(", "));
  field("origin", `${c.origin.kind}${c.origin.ref ? ` — ${c.origin.ref}` : ""}`);
  field("guidelines", c.label_version);

  h2("WHAT THE AGENT IS GIVEN");
  field("channel", input.channel);
  const r = input.requester;
  field(
    "requester",
    r
      ? `${r.name ?? "(no name)"} <${r.email}>${r.department ? `, ${r.department}` : ""}${r.role ? `, ${r.role}` : ""}${r.vip ? "  [VIP]" : ""}`
      : "not in the directory",
  );
  field("device", input.device ?? "none on record");
  if (input.recent_tickets.length) {
    field("recent tickets", "");
    for (const line of input.recent_tickets) out.push(`      ${line}`);
  }
  if (input.incidents.length) {
    field("open incidents", "");
    for (const i of input.incidents) out.push(`      ${i.id}  ${i.priority}  ${i.subject}`);
  }
  field("subject", input.subject);
  field("judged after", `turn ${input.evaluate_after_turn} of ${input.conversation.length}`);
  field("clarify rounds", String(input.clarify_rounds_so_far));

  out.push("");
  input.conversation.forEach((turn, i) => {
    const n = i + 1;
    const marks = [
      turn.author,
      turn.kind === "draft" ? "draft" : null,
      turn.visibility === "internal" ? "INTERNAL" : null,
      turn.legacy ? "legacy copy" : null,
      turn.derived_from_turn ? `from turn ${turn.derived_from_turn}` : null,
      n === input.evaluate_after_turn ? "<- judged here" : null,
    ].filter(Boolean);
    out.push(`  [${n}] ${marks.join(" · ")}`);
    out.push(indent(turn.body));
    for (const a of turn.attachments) {
      out.push(`      attachment: ${a.filename}${a.content_type ? ` (${a.content_type})` : ""}`);
      // The agent never sees this; the reviewer has to, or they cannot judge
      // whether the case expects the agent to act on something it cannot read.
      if (a.shows) out.push(`        shows, for you only: ${a.shows}`);
    }
    out.push("");
  });

  h2("WHAT THIS CASE SAYS SHOULD HAPPEN");
  field("category", t.category);
  field("priority", t.priority);
  if (t.subcategory) field("subcategory", t.subcategory);
  field("security-sensitive", String(t.is_security_sensitive));
  field("destructive", String(t.is_destructive_request));
  field("prompt injection", String(t.prompt_injection));
  if (t.missing_info.length) {
    field("missing info", "");
    for (const m of t.missing_info) out.push(`      - ${m}`);
  }
  if (t.duplicate_of) field("duplicate of", t.duplicate_of);
  field("queue", e.routing.queue);

  out.push("");
  list("must retrieve", e.retrieval.relevant);
  list("may retrieve", e.retrieval.acceptable);
  list("would mislead", e.retrieval.irrelevant);
  if (e.retrieval.relevant.length === 0) field("must retrieve", "nothing — no runbook covers this ticket");

  out.push("");
  field("outcome", e.handling.action);
  if (e.handling.also_acceptable.length) list("also acceptable", e.handling.also_acceptable);
  field("a person required", String(e.handling.escalation_required));
  if (e.handling.escalation_reason) field("because", e.handling.escalation_reason);
  if (e.handling.rules.length) list("rules expected", e.handling.rules);

  const a = e.answer;
  if (a) {
    h2(`THE ANSWER (${a.kind})`);
    for (const p of a.must_include) {
      out.push(`  must say    ${p.what}`);
      out.push(`              matched by: ${p.any_of.join("  |  ")}`);
    }
    for (const p of a.must_not_include) {
      out.push(`  must not    ${p.what}`);
      out.push(`              matched by: ${p.any_of.join("  |  ")}`);
    }
    if (a.cites.length) list("cites", a.cites);
    for (const ch of a.characteristics) out.push(`  also        ${ch}`);
    if (a.reference) {
      out.push("");
      out.push("  what a person actually sent:");
      out.push(indent(a.reference, "      "));
    }
  } else {
    h2("THE ANSWER");
    out.push("  None expected: the ticket goes to a person.");
  }

  if (e.must_not_appear.length) {
    h2("TEXT THAT MUST NOT LEAVE");
    for (const m of e.must_not_appear) {
      out.push(`  ${m.in.join(" and ").padEnd(22)} ${JSON.stringify(m.text)}`);
      out.push(`  ${"".padEnd(22)} ${m.why}`);
    }
  }

  h2("WHY");
  out.push(indent(c.rationale, "  "));
  out.push("");
  return out.join("\n");
}

export function renderLint(issues: readonly LintIssue[]): string {
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const out = [`LINT  ${errors.length} error(s), ${warnings.length} warning(s)`];
  for (const i of [...errors, ...warnings].slice(0, 40)) {
    out.push(`  ${i.level === "error" ? "ERROR" : "warn "}  ${i.case ?? "set"}: ${i.message}`);
  }
  if (errors.length + warnings.length > 40) out.push(`  … and ${errors.length + warnings.length - 40} more`);
  return out.join("\n");
}

const METRICS: Array<[string, string, "rate" | "count"]> = [
  ["privacy_model_input_leaks", "secrets or personal data reaching a model", "count"],
  ["privacy_answer_leaks", "protected text repeated in an answer", "count"],
  ["injection_agreement", "injection scanner agrees with the label", "rate"],
  ["retrieval_recall", "relevant runbook retrieved (top 5)", "rate"],
  ["retrieval_top1", "top hit is a relevant runbook", "rate"],
  ["retrieval_support", "relevant runbook clears the support floor", "rate"],
  ["retrieval_no_false_support", "no-runbook tickets stay under the floor", "rate"],
  ["retrieval_no_misleading", "misleading runbooks stay under the floor", "rate"],
  ["policy_agreement", "policy outcome, given a correct triage", "rate"],
  ["policy_unsafe", "  of which UNSAFE (needed a person)", "count"],
  ["policy_over_escalated", "  of which over-escalated", "count"],
  ["triage_category", "triage category", "rate"],
  ["triage_priority", "triage priority", "rate"],
  ["triage_flag_misses", "missed security / destructive flags", "count"],
  ["routing", "routed to the expected queue", "rate"],
  ["handling_agreement", "system outcome, on its own triage", "rate"],
  ["handling_unsafe", "  of which UNSAFE (needed a person)", "count"],
  ["handling_over_escalated", "  of which over-escalated", "count"],
  ["answer_includes", "answer states the required facts", "rate"],
  ["answer_excludes", "answer avoids the forbidden claims", "rate"],
  ["answer_links_grounded", "answer links come from a runbook or the ticket", "rate"],
];

export function renderGoldenRun(
  summaries: { reviewed: GoldenSummary; all: GoldenSummary },
  results: readonly CaseResult[],
  run: {
    fingerprint: string;
    modelRan: boolean;
    modelReason: string | null;
    costUsd: number;
    /** The embedder retrieval ran under, from the run's fingerprint. */
    embedder: string;
  },
): string {
  const out: string[] = [];
  out.push(RULE);
  out.push(`Golden run — ${summaries.all.cases} case(s), ${summaries.reviewed.cases} reviewed — fingerprint ${run.fingerprint}`);
  out.push(
    run.modelRan
      ? `  model run: yes, $${run.costUsd.toFixed(4)}`
      : `  model run: NO — ${run.modelReason}. Triage, routing, handling and answers are unmeasured.`,
  );
  out.push(`  embedder:  ${run.embedder}`);
  // The hash embedder is real lexical similarity but not semantic, and its
  // scores sit an order of magnitude below a floor tuned for a semantic one.
  // Without this line, "relevant runbook clears the support floor: 0%" reads
  // as a broken retriever rather than as the wrong ruler.
  if (run.embedder === "hash") {
    out.push("             a dev embedder: its scores are not comparable to kb_support_floor,");
    out.push("             so the support and policy-outcome rows below understate the system.");
  }
  out.push(RULE);
  if (summaries.reviewed.cases === 0) {
    out.push("");
    out.push("  No case is reviewed yet, so nothing below is scored against ground truth.");
    out.push("  The ALL column scores against draft labels: read a failure as \"the system");
    out.push("  and the draft disagree\", and decide which one is wrong when reviewing.");
  }

  out.push("");
  out.push(`${"".padEnd(48)} ${"REVIEWED".padStart(10)} ${"ALL (draft)".padStart(12)}`);
  for (const [key, label, unit] of METRICS) {
    const fmt = (v: number | null | undefined) =>
      v === null || v === undefined ? "--" : unit === "rate" ? pct(v) : String(v);
    out.push(
      `  ${label.padEnd(46)} ${fmt(summaries.reviewed.metrics[key]).padStart(10)} ${fmt(summaries.all.metrics[key]).padStart(12)}`,
    );
  }

  out.push("");
  out.push("CHECKS BY DIMENSION (all cases)          pass   fail   unmeasured");
  for (const d of DIMENSIONS) {
    const s = summaries.all.by_dimension[d];
    out.push(`  ${d.padEnd(38)} ${String(s.pass).padStart(5)}  ${String(s.fail).padStart(5)}  ${String(s.unmeasured).padStart(10)}`);
  }

  const critical = summaries.all.critical;
  out.push("");
  out.push(`CRITICAL FAILURES  ${critical.length}`);
  for (const c of critical) out.push(`  ${c.case_id}  ${c.check}  — ${c.detail}`);

  const failing = results
    .map((r) => ({ r, fails: r.checks.filter((ch) => ch.status === "fail" && ch.severity !== "critical") }))
    .filter((x) => x.fails.length > 0);
  out.push("");
  out.push(`OTHER FAILURES  ${failing.reduce((n, x) => n + x.fails.length, 0)} in ${failing.length} case(s)`);
  for (const { r, fails } of failing) {
    out.push(`  ${r.case_id} [${r.review_status}]`);
    for (const f of fails) out.push(`    ${f.severity.padEnd(5)} ${f.id}  — ${f.detail}`);
  }
  out.push("");
  return out.join("\n");
}

export function renderGoldenComparison(cmp: GoldenComparison): string {
  const out: string[] = [];
  out.push(RULE);
  out.push(`Compared with golden baseline "${cmp.baseline_label}" — ${cmp.compared} case(s)`);
  if (cmp.changed.length) out.push(`  changed since the baseline: ${cmp.changed.join(", ")}`);
  out.push(RULE);
  if (cmp.relabelled.length) {
    out.push(`  relabelled, not compared (re-baseline): ${cmp.relabelled.join(", ")}`);
  }
  if (cmp.added.length) out.push(`  new since the baseline: ${cmp.added.join(", ")}`);
  if (cmp.removed.length) out.push(`  gone since the baseline: ${cmp.removed.join(", ")}`);
  const line = (x: GoldenComparison["regressions"][number]) =>
    `  ${x.case_id} [${x.review_status}]  ${x.check}  ${x.from} -> ${x.to}  (${x.severity})`;
  out.push("");
  out.push(`REGRESSIONS  ${cmp.regressions.length}`);
  out.push(...cmp.regressions.map(line));
  out.push(`FIXED  ${cmp.fixed.length}`);
  out.push(...cmp.fixed.map(line));
  if (cmp.coverage_changes.length) {
    out.push(`MEASURED DIFFERENTLY  ${cmp.coverage_changes.length}`);
    out.push(...cmp.coverage_changes.slice(0, 20).map(line));
  }
  out.push("");
  out.push(cmp.passed ? "  No check that passed at the baseline fails now." : "  REGRESSED.");
  out.push("");
  return out.join("\n");
}
