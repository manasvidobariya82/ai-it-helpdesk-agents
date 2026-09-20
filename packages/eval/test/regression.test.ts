import { BusinessSettings } from "@hd/core";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  TAXONOMY,
  baselineObservations,
  casesInScope,
  compareGolden,
  compareToBaseline,
  fingerprint,
  goldenOnly,
  goldenToScored,
  lintGoldenSet,
  loadDataset,
  loadGoldenBaseline,
  loadGoldenSet,
  loadPinnedKb,
  observeOffline,
  scoreCase,
  scoreRun,
  selectSplit,
  type Baseline,
} from "@hd/eval";

/**
 * The half of "regression evaluation runs automatically" that fits in `npm
 * test`: no model calls, no database, no tokens.
 *
 * The golden set (eval/golden-set) is always present, so these always run.
 * The last test replays the deterministic part of the system over every case
 * — what reaches the model after scrubbing and redaction, the injection scan,
 * and what the decision branch does with a correct classification and the
 * retrieval the baseline recorded — and fails when a check that passed at the
 * pinned baseline fails now. Retrieval itself needs a database and is pinned
 * by golden.integration.test.ts; the model half costs money and lives in
 * `npm run eval golden -- run --baseline main`.
 *
 * The triage JSONL (production feedback exported from `triage_shadow`) is
 * checked the same way when it exists.
 */

const root = path.resolve(process.cwd());
const goldenDir = path.join(root, "eval", "golden-set");
const goldenBaselinePath = path.join(root, "eval", "baselines", "golden", "main.json");
const datasetPath = path.join(root, "eval", "datasets", "triage-golden.jsonl");
const baselinePath = path.join(root, "eval", "baselines", "main.json");

const hasDataset = fs.existsSync(datasetPath);
const hasBaseline = fs.existsSync(baselinePath);
const hasGoldenBaseline = fs.existsSync(goldenBaselinePath);

describe("golden set", () => {
  it("parses with no unreadable cases", async () => {
    const set = await loadGoldenSet(goldenDir);
    expect(set.errors).toEqual([]);
    expect(set.cases.length).toBeGreaterThan(0);

    if (hasDataset) {
      const loaded = await loadDataset(datasetPath);
      expect(loaded.errors).toEqual([]);
    }
  });

  it("labels only categories in the taxonomy, and lints clean", async () => {
    const set = await loadGoldenSet(goldenDir);
    const settings = BusinessSettings.parse(set.version.policy.settings);
    // A label outside the taxonomy is a renamed category nobody migrated or a
    // typo, and both quietly lower every per-class score. The lint also holds
    // the rules a scorer cannot: a pattern that compiles, a runbook that
    // exists, a protected string that is actually in the case.
    const errors = lintGoldenSet(set, { taxonomy: TAXONOMY, settings })
      .filter((i) => i.level === "error")
      .map((i) => `${i.case}: ${i.message}`);
    expect(errors).toEqual([]);

    if (hasDataset) {
      const loaded = await loadDataset(datasetPath);
      const unknown = new Set(
        goldenOnly(loaded.samples)
          .map((s) => s.label.category)
          .filter((c) => !TAXONOMY.includes(c)),
      );
      expect([...unknown]).toEqual([]);
    }
  });

  it("attributes every reviewed case to a person who did not draft it", async () => {
    const set = await loadGoldenSet(goldenDir);
    const unattributed = set.cases.filter(
      (c) =>
        c.review.status === "reviewed" &&
        (!c.review.reviewed_by ||
          c.review.reviewed_by.toLowerCase() === c.review.authored_by.toLowerCase()),
    );
    // The model that drafted a case cannot be its ground truth.
    expect(unattributed.map((c) => c.id)).toEqual([]);

    if (hasDataset) {
      const loaded = await loadDataset(datasetPath);
      expect(goldenOnly(loaded.samples).filter((s) => !s.labeler).map((s) => s.id)).toEqual([]);
    }
  });
});

describe("regression against the golden baseline", () => {
  it("holds on the checks that need no model and no database", async () => {
    await triageJsonlHolds();

    // The golden baseline is pinned by `npm run eval golden -- run
    // --save-baseline main`, which needs a database for retrieval and, for
    // the model half, tokens. A checkout that has never run it has no
    // baseline to regress against, which is the same situation as the triage
    // JSONL above and is handled the same way. It is not silent: `npm run
    // eval golden` prints whether a baseline is pinned, and `--baseline main`
    // fails loudly rather than passing vacuously.
    if (!hasGoldenBaseline) return;

    const set = await loadGoldenSet(goldenDir);
    const baseline = await loadGoldenBaseline(goldenBaselinePath);
    const settings = BusinessSettings.parse(baseline.settings);
    const frozen = baselineObservations(baseline);
    const kb = await loadPinnedKb(root, set.version);
    const kbCorpus = kb.docs.map((d) => d.body).join("\n").toLowerCase();
    const tenant = { id: null, ...baseline.tenant };

    const results = casesInScope(set.cases, "all").map((c) => {
      const before = frozen[c.id];
      // Retrieval as the baseline recorded it, so only this test's own stages
      // can move the decision. The model half is carried over unchanged.
      const now = observeOffline(c, { settings, tenant, hits: before?.retrieval?.hits ?? null });
      const obs = before
        ? { ...now, triage: before.triage, handling: before.handling, answer: before.answer }
        : now;
      return scoreCase(c, obs, { settings, kbCorpus });
    });

    const cmp = compareGolden(results, baseline);
    // Relabelling cases during review takes them out of the comparison. When
    // most of the set has moved, the baseline no longer describes it.
    expect(
      cmp.compared,
      `${cmp.relabelled.length} case(s) relabelled since baseline "${baseline.label}". Re-baseline: npm run eval golden -- run --save-baseline main`,
    ).toBeGreaterThanOrEqual(Math.ceil(results.length / 2));
    expect(
      cmp.regressions.map((r) => `${r.case_id} ${r.check}: ${r.from} -> ${r.to} (${r.severity})`),
    ).toEqual([]);
  });
});

/**
 * The triage JSONL's frozen predictions against its own baseline, when both
 * have been exported. Part of the regression test rather than a test of its
 * own, so a repository with no production feedback yet has nothing skipped.
 */
async function triageJsonlHolds(): Promise<void> {
  if (!hasDataset || !hasBaseline) return;
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as Baseline;
  const loaded = await loadDataset(datasetPath);
  const settings = BusinessSettings.parse({});

  const split =
    baseline.split === "train" || baseline.split === "holdout" ? baseline.split : "all";
  const samples = selectSplit(goldenOnly(loaded.samples), split);
  const scored = goldenToScored(samples, { settings });

  const report = scoreRun(scored, {
    source: "dataset",
    datasetPath,
    datasetId: loaded.dataset_id,
    split: baseline.split,
    samples: loaded.samples,
    taxonomy: TAXONOMY,
    neverAuto: settings.never_auto_categories,
    model: baseline.model,
    promptVersion: baseline.prompt_version,
  });

  const fp = fingerprint({
    model: baseline.model,
    promptVersion: baseline.prompt_version,
    taxonomy: TAXONOMY,
    settings,
  });
  const result = compareToBaseline(report, baseline, {}, fp);

  // Not comparable is a real answer, not a pass: re-baseline, do not ignore.
  if (!result.comparable) {
    throw new Error(
      `Baseline "${baseline.label}" is no longer comparable: ${result.reason}`,
    );
  }

  expect(
    result.regressions.map((r) => `${r.metric} ${r.baseline} -> ${r.current}`),
  ).toEqual([]);
}
