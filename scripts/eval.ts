import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BusinessSettings,
  closePool,
  countTriagedAndLabelled,
  env,
  systemContext,
  exportableSamples,
  getSettings,
  listBusinesses,
  policyFor,
  purgeBusinessUnaudited,
  queryOne,
  reconciledSamples,
  recordEvalRun,
  routeQueue,
  type Business,
} from "@hd/core";
import { clarifyPrompt, credentialsConfigured, replyPrompt, triagePrompt } from "@hd/llm";
import { ingestDocument, retrieve } from "@hd/rag";
import {
  TAXONOMY,
  attribution,
  baselineFrom,
  baselineResults,
  caseFile,
  casesInScope,
  compareGolden,
  compareToBaseline,
  fingerprint,
  goldenCoverage,
  goldenFingerprint,
  goldenOnly,
  goldenSetId,
  GoldenBaseline,
  goldenToScored,
  loadBaseline,
  loadDataset,
  loadGoldenBaseline,
  loadGoldenSet,
  loadPinnedKb,
  lintGoldenSet,
  mergeSamples,
  observeModel,
  observeOffline,
  renderGoldenCase,
  renderGoldenComparison,
  renderGoldenCoverage,
  renderGoldenRun,
  renderLint,
  renderRegression,
  renderReport,
  replayDataset,
  replayTriage,
  reviewedCases,
  saveBaseline,
  saveDataset,
  saveGoldenBaseline,
  scoreCase,
  scoreRun,
  selectSplit,
  serializeCase,
  shadowToScored,
  storedBody,
  summarize,
  toGoldenSamples,
  toRecords,
  type CaseObservation,
  type EvalReport,
  type Fingerprint,
  type GoldenCase,
  type GoldenSample,
  type LoadedGoldenSet,
  type ScoredSample,
} from "@hd/eval";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const datasetsDir = path.join(root, "eval", "datasets");
const baselinesDir = path.join(root, "eval", "baselines");

/**
 * The evaluation CLI.
 *
 *   npm run eval score                  score the reconciled shadow records
 *   npm run eval score --dataset <f>    score the predictions frozen in a file
 *   npm run eval export                 freeze those records as review candidates
 *   npm run eval review --list          show what is waiting for review
 *   npm run eval review <id> --accept   promote a candidate to golden
 *   npm run eval replay                 re-run triage over the golden set
 *   npm run eval regress                replay + compare to the pinned baseline
 *   npm run eval golden [check|run|review]  the reviewed golden set (eval/golden-set)
 *
 * Flags: --tenant <name|id>  --days N  --split train|holdout|all
 *        --dataset <file>  --json <file>  --limit N  --concurrency N
 *        --baseline <name>  --save-baseline <name>  --record
 *        --labeler <who>  --label-version <v>  --accept  --reject  --list
 *
 * `score` is free and reads only the database (or a file). `replay` and
 * `regress` spend tokens. `regress` is the one to wire into CI.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "score";
  const flags = parseFlags(argv.slice(1));

  switch (command) {
    case "score":
      await cmdScore(flags);
      break;
    case "export":
      await cmdExport(flags);
      break;
    case "replay":
      await cmdReplay(flags);
      break;
    case "regress":
      await cmdReplay({ ...flags, baseline: flags.baseline ?? "main" });
      break;
    case "review":
      await cmdReview(flags, argv.slice(1));
      break;
    case "baseline":
      await cmdBaseline(flags, argv.slice(1));
      break;
    case "golden":
      await cmdGolden(flags, argv.slice(1));
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error(
        "Usage: npm run eval [score|export|review|replay|regress|baseline|golden] [flags]",
      );
      process.exitCode = 2;
  }

  await closePool();
}

// --- score ---------------------------------------------------------------

/**
 * Score what shadow mode already recorded.
 *
 * No model calls: these are the agent's own predictions against the labels
 * humans supplied when they corrected or confirmed a classification. It is the
 * cheapest honest answer to "is the confidence number meaningful", and it is
 * available today because the table has been filling since phase 2.
 */
async function cmdScore(flags: Flags): Promise<void> {
  const business = await resolveTenant(flags.tenant);
  const settings = await getSettings(business.id);

  // `--dataset` scores the predictions frozen in a golden file instead of the
  // live table: free, offline, and reproducible six weeks from now, which the
  // shadow table is not once new tickets land in it.
  if (flags.dataset) {
    await scoreDataset(flags, business, settings);
    return;
  }

  const rows = await reconciledSamples(systemContext(business.id), {
    ...(flags.days !== null ? { days: flags.days } : {}),
    ...(flags.promptVersion ? { promptVersion: flags.promptVersion } : {}),
    ...(flags.limit !== null ? { limit: flags.limit } : {}),
  });

  if (rows.length === 0) {
    console.log(
      [
        "",
        `No reconciled shadow records for ${business.name}.`,
        "",
        "The table fills when a human corrects or confirms a classification in",
        "the console. Until then there is nothing to calibrate against, and any",
        "threshold in settings is still a guess.",
        "",
      ].join("\n"),
    );
    return;
  }

  const attr = attribution(rows);
  const outcome = await countTriagedAndLabelled(systemContext(business.id), {
    ...(flags.days !== null ? { days: flags.days } : {}),
  });
  const fp = fingerprint({
    model: attr.model,
    promptVersion: attr.promptVersion,
    taxonomy: TAXONOMY,
    settings,
  });
  const scored = shadowToScored(rows, { settings });
  const report = scoreRun(scored, {
    ...scoreOptions(settings),
    source: "shadow",
    split: "all",
    model: attr.model,
    promptVersion: attr.promptVersion,
    outcomeCoverage: outcome,
    regressionAutomated: await baselineExists(flags.baseline ?? "main"),
  });

  console.log(renderReport(report));
  if (attr.mixed) {
    console.log(
      [
        "NOTE  These rows span more than one model or prompt version, so the",
        "      numbers above are an average over versions. Pass --prompt-version",
        "      to score one, or use `replay` against a frozen dataset to compare",
        "      two versions on identical input.",
        "",
      ].join("\n"),
    );
  }

  await maybeWriteJson(flags.json, report);
  await maybeRecord(flags, business, report, scored, fp);
  await maybeCompare(flags, report, fp);
  if (!report.passed) process.exitCode = 1;
}

/** Score a frozen golden file against the predictions recorded inside it. */
async function scoreDataset(
  flags: Flags,
  business: Business,
  settings: BusinessSettings,
): Promise<void> {
  const file = flags.dataset!;
  const loaded = await loadDatasetOrExplain(file);
  if (!loaded) return;
  reportDatasetErrors(loaded.errors, file);

  const samples = selectSplit(goldenOnly(loaded.samples), flags.split);
  const scored = goldenToScored(samples, { settings });

  if (scored.length === 0) {
    console.error(
      `No reviewed sample in split "${flags.split}" of ${file} carries a recorded prediction to score.`,
    );
    process.exitCode = 1;
    return;
  }

  const models = new Set(samples.map((x) => x.recorded?.model).filter(Boolean));
  const prompts = new Set(
    samples.map((x) => x.recorded?.prompt_version).filter(Boolean),
  );
  const model = models.size === 1 ? [...models][0]! : null;
  const promptVersion = prompts.size === 1 ? [...prompts][0]! : null;

  const fp = fingerprint({ model, promptVersion, taxonomy: TAXONOMY, settings });
  const report = scoreRun(scored, {
    ...scoreOptions(settings),
    source: "dataset",
    datasetPath: file,
    datasetId: loaded.dataset_id,
    split: flags.split,
    samples: loaded.samples,
    model,
    promptVersion,
    regressionAutomated: await baselineExists(flags.baseline ?? "main"),
  });

  console.log(renderReport(report));
  await maybeWriteJson(flags.json, report);
  await maybeRecord(flags, business, report, scored, fp);
  await maybeCompare(flags, report, fp);
  if (!report.passed) process.exitCode = 1;
}

// --- export --------------------------------------------------------------

/**
 * Freeze reconciled records into a golden JSONL file.
 *
 * Existing samples are never overwritten: a label somebody reviewed by hand
 * outranks whatever the database says today, and the split is derived from the
 * ticket id so adding samples never reshuffles the holdout.
 */
async function cmdExport(flags: Flags): Promise<void> {
  const business = await resolveTenant(flags.tenant);
  const file = flags.dataset ?? path.join(datasetsDir, "triage-golden.jsonl");

  const settings = await getSettings(business.id);
  const rows = await exportableSamples(systemContext(business.id), {
    ...(flags.days !== null ? { days: flags.days } : {}),
    ...(flags.limit !== null ? { limit: flags.limit } : {}),
  });
  const incoming = toGoldenSamples(rows, {
    holdoutPct: flags.holdoutPct,
    settings,
    ...(flags.labelVersion ? { labelVersion: flags.labelVersion } : {}),
  });

  const existing = await loadDatasetIfPresent(file);
  const { merged, added, skipped } = mergeSamples(existing, incoming, {
    holdoutPct: flags.holdoutPct,
  });
  const saved = await saveDataset(file, merged);

  const reconstructed = merged.filter(
    (s) => s.input.fidelity === "reconstructed",
  ).length;
  const unlabelledSafety = merged.filter(
    (s) =>
      s.label.is_security_sensitive === null &&
      s.label.is_destructive_request === null,
  ).length;

  const reviewed = goldenOnly(merged);
  const candidates = merged.filter((s) => s.status === "candidate");

  console.log("");
  console.log(`Wrote ${saved.path}`);
  console.log(`  ${saved.n} rows (${added} added, ${skipped} already present)`);
  console.log(`  dataset id ${saved.dataset_id} — computed from reviewed samples only`);
  console.log(
    `  ${reviewed.length} reviewed (golden) · ${candidates.length} awaiting review · ${merged.length - reviewed.length - candidates.length} rejected`,
  );
  console.log(
    `  ${reviewed.filter((s) => s.split === "holdout").length} holdout / ${reviewed.filter((s) => s.split === "train").length} train, of the reviewed set`,
  );
  if (candidates.length > 0) {
    console.log("");
    console.log(
      "  New rows land as candidates, not as ground truth. A console correction",
    );
    console.log(
      "  is somebody disagreeing with the agent while working their queue; it is",
    );
    console.log(
      "  evidence, and it is wrong often enough that a set built by trusting all",
    );
    console.log(
      "  of them measures agreement with a busy colleague. Review them with:",
    );
    console.log("");
    console.log("    npm run eval review -- --list");
    console.log("    npm run eval review -- <ticket-id> --accept --labeler you@example.com");
  }
  if (reconstructed > 0) {
    console.log(
      `  ${reconstructed} sample(s) have reconstructed context — they predate prompt capture,`,
    );
    console.log(
      "    so a replay difference on those may be the context, not the prompt.",
    );
  }
  if (unlabelledSafety > 0) {
    console.log(
      `  ${unlabelledSafety} sample(s) carry no human security/destructive label.`,
    );
    console.log(
      "    The safety gate stays `unmeasured` until they are labelled by hand.",
    );
  }
  console.log("");
}

// --- replay --------------------------------------------------------------

async function cmdReplay(flags: Flags): Promise<void> {
  const file = flags.dataset ?? path.join(datasetsDir, "triage-golden.jsonl");
  const loaded = await loadDatasetOrExplain(file);
  if (!loaded) return;
  reportDatasetErrors(loaded.errors, file);

  const business = await resolveTenant(flags.tenant);
  const settings = await getSettings(business.id);
  // Only reviewed samples are replayed. Scoring a model against candidates is
  // scoring it against the last person who clicked "save correction".
  const samples = selectSplit(goldenOnly(loaded.samples), flags.split);

  if (samples.length === 0) {
    const candidates = loaded.samples.filter((x) => x.status === "candidate").length;
    console.error(
      candidates > 0
        ? `No reviewed samples in split "${flags.split}" of ${file}. ${candidates} candidate(s) are waiting for review — see \`npm run eval review -- --list\`.`
        : `No samples in split "${flags.split}" of ${file}.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log(
    `Replaying ${samples.length} sample(s) from ${path.basename(file)} (${flags.split}) against ${flags.model ?? env.TRIAGE_MODEL}.`,
  );
  console.log("This spends tokens. Ctrl-C now if that was not the intent.");
  console.log("");

  const run = await replayDataset(samples, {
    businessId: business.id,
    concurrency: flags.concurrency,
    ...(flags.model ? { model: flags.model } : {}),
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) {
        process.stdout.write(`\r  ${done}/${total}`);
      }
    },
  });
  process.stdout.write("\n\n");

  // The replay returns fresh predictions; the teams they imply come from the
  // same routing table the live path uses.
  const scored: ScoredSample[] = run.scored.map((x) => ({
    ...x,
    predicted: {
      ...x.predicted,
      team: routeQueueFor(x.predicted.category, x.predicted.priority, settings),
    },
  }));

  const fp = fingerprint({
    model: run.model,
    promptVersion: run.prompt_version,
    taxonomy: TAXONOMY,
    settings,
  });

  const report = scoreRun(scored, {
    ...scoreOptions(settings),
    source: "replay",
    datasetPath: file,
    datasetId: loaded.dataset_id,
    split: flags.split,
    samples: loaded.samples,
    model: run.model,
    promptVersion: run.prompt_version,
    regressionAutomated: await baselineExists(flags.baseline ?? "main"),
  });

  console.log(renderReport(report));
  console.log(
    `SPEND  $${run.cost_usd.toFixed(4)} over ${run.scored.length} call(s), ${run.tokens_in} in / ${run.tokens_out} out.`,
  );
  if (run.failures.length > 0) {
    console.log(
      `FAILED ${run.failures.length} sample(s) — excluded from the scores, not counted as misses:`,
    );
    for (const f of run.failures.slice(0, 5)) console.log(`  ${f.id}: ${f.error}`);
  }
  if (run.reconstructed > 0) {
    console.log(
      `NOTE   ${run.reconstructed} sample(s) replayed with reconstructed context.`,
    );
  }
  console.log("");

  await maybeWriteJson(flags.json, report);
  await maybeRecord(flags, business, report, scored, fp);
  await maybeCompare(flags, report, fp);
  if (!report.passed) process.exitCode = 1;
}

// --- review --------------------------------------------------------------

/**
 * Promote candidates into the golden set, one at a time and on purpose.
 *
 * This is the step the brief calls "keep a reviewed golden set separate from
 * production feedback", and it is deliberately a command rather than a flag on
 * the export: a set you can fill in one keystroke is a set nobody reads.
 */
async function cmdReview(flags: Flags, rest: readonly string[]): Promise<void> {
  const file = flags.dataset ?? path.join(datasetsDir, "triage-golden.jsonl");
  const loaded = await loadDatasetOrExplain(file);
  if (!loaded) return;
  reportDatasetErrors(loaded.errors, file);

  const ids = rest.filter((a) => !a.startsWith("--") && !isFlagValue(rest, a));

  if (flags.list || ids.length === 0) {
    const candidates = loaded.samples.filter((x) => x.status === "candidate");
    console.log("");
    console.log(
      `${goldenOnly(loaded.samples).length} reviewed · ${candidates.length} awaiting review · ${loaded.samples.filter((x) => x.status === "rejected").length} rejected`,
    );
    console.log("");
    for (const c of candidates.slice(0, flags.limit ?? 25)) {
      const agreed =
        c.recorded && c.recorded.category === c.label.category ? "agreed" : "CORRECTED";
      console.log(
        `  ${c.id}  ${agreed.padEnd(9)} agent=${c.recorded?.category ?? "?"}@${c.recorded?.confidence.toFixed(2) ?? "?"} -> human=${c.label.category}/${c.label.priority}`,
      );
      console.log(`      ${c.input.subject}`);
    }
    if (candidates.length === 0) {
      console.log("  Nothing waiting. Run `npm run eval export` to pull in new records.");
    }
    console.log("");
    console.log("  Accept:  npm run eval review -- <id> --accept --labeler you@example.com");
    console.log("  Reject:  npm run eval review -- <id> --reject --note 'label is wrong'");
    console.log("");
    return;
  }

  if (!flags.accept && !flags.reject) {
    console.error("Pass --accept or --reject. Reviewing is a decision, not a default.");
    process.exitCode = 2;
    return;
  }
  if (flags.accept && !flags.labeler) {
    // An unattributed label is one nobody can ask about later.
    console.error("Pass --labeler <who>. A reviewed label needs a reviewer.");
    process.exitCode = 2;
    return;
  }

  const now = new Date().toISOString();
  const wanted = new Set(ids);
  let touched = 0;
  const updated: GoldenSample[] = loaded.samples.map((x) => {
    if (!wanted.has(x.id)) return x;
    touched += 1;
    return {
      ...x,
      status: flags.accept ? ("reviewed" as const) : ("rejected" as const),
      labeler: flags.labeler ?? x.labeler,
      reviewed_at: now,
      label_version: flags.labelVersion ?? x.label_version,
      note: flags.note ?? x.note,
      ...(flags.category || flags.priority || flags.team
        ? {
            label: {
              ...x.label,
              ...(flags.category ? { category: flags.category } : {}),
              ...(flags.priority
                ? { priority: flags.priority as GoldenSample["label"]["priority"] }
                : {}),
              ...(flags.team ? { team: flags.team } : {}),
            },
          }
        : {}),
    };
  });

  if (touched === 0) {
    console.error(`No sample in ${file} matched: ${ids.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const saved = await saveDataset(file, updated);
  console.log("");
  console.log(
    `${flags.accept ? "Accepted" : "Rejected"} ${touched} sample(s). ${goldenOnly(updated).length} reviewed in total.`,
  );
  console.log(`  dataset id is now ${saved.dataset_id} — re-baseline before comparing.`);
  console.log("");
}

// --- baseline ------------------------------------------------------------

async function cmdBaseline(flags: Flags, rest: readonly string[]): Promise<void> {
  const name = rest.find((a) => !a.startsWith("--")) ?? "current";
  const file = path.join(baselinesDir, `${name}.json`);

  if (!flags.save) {
    console.error(
      [
        "",
        "`baseline` with no --save compares a fresh run against a stored one,",
        "which means it needs a run. Use:",
        "",
        `  npm run eval replay -- --baseline ${name}`,
        "",
        "or pin the current numbers with:",
        "",
        `  npm run eval score -- --save-baseline ${name}`,
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }

  const business = await resolveTenant(flags.tenant);
  const settings = await getSettings(business.id);
  const rows = await reconciledSamples(systemContext(business.id), {
    ...(flags.days !== null ? { days: flags.days } : {}),
  });
  const attr = attribution(rows);
  const report = scoreRun(shadowToScored(rows, { settings }), {
    ...scoreOptions(settings),
    source: "shadow",
    split: "all",
    model: attr.model,
    promptVersion: attr.promptVersion,
  });

  await saveBaseline(
    file,
    baselineFrom(
      report,
      name,
      fingerprint({
        model: attr.model,
        promptVersion: attr.promptVersion,
        taxonomy: TAXONOMY,
        settings,
      }),
    ),
  );
  console.log(`\nBaseline "${name}" written to ${file}\n`);
}

async function maybeCompare(
  flags: Flags,
  report: EvalReport,
  fp: Fingerprint | null,
): Promise<void> {
  if (flags.saveBaseline) {
    const file = path.join(baselinesDir, `${flags.saveBaseline}.json`);
    await saveBaseline(file, baselineFrom(report, flags.saveBaseline, fp));
    console.log(`Baseline "${flags.saveBaseline}" written to ${file}\n`);
  }
  if (!flags.baseline) return;

  const file = path.join(baselinesDir, `${flags.baseline}.json`);
  let baseline;
  try {
    baseline = await loadBaseline(file);
  } catch {
    console.error(
      [
        "",
        `No baseline at ${file}.`,
        "",
        "Pin the current numbers first, then compare later runs against them:",
        "",
        `  npm run eval replay -- --save-baseline ${flags.baseline}`,
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }

  const result = compareToBaseline(report, baseline, {}, fp);
  console.log(renderRegression(result));
  if (!result.passed) process.exitCode = 1;
}

/** Score options every command shares, so the policy is applied identically. */
function scoreOptions(settings: BusinessSettings) {
  return {
    taxonomy: TAXONOMY,
    neverAuto: settings.never_auto_categories,
    currentThresholdFor: (category: string) =>
      policyFor(settings, category).confidence_threshold,
  };
}

/** Mirrors the pipeline routing so a replayed prediction gets a team. */
function routeQueueFor(
  category: string,
  priority: string,
  settings: BusinessSettings,
): string {
  return routeQueue(category, priority as never, settings);
}

async function baselineExists(name: string): Promise<boolean> {
  try {
    await fs.access(path.join(baselinesDir, `${name}.json`));
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist the run, so the threshold question can be asked over more data than
 * one run holds. Opt-in: a CLI people run while tuning should not quietly fill
 * a table with half-finished experiments.
 */
async function maybeRecord(
  flags: Flags,
  business: Business,
  report: EvalReport,
  scored: readonly ScoredSample[],
  fp: Fingerprint | null,
): Promise<void> {
  if (!flags.record) return;

  const runId = await recordEvalRun(
    systemContext(business.id),
    {
      source: report.source,
      dataset_path: report.dataset.path,
      dataset_id: report.dataset.dataset_id,
      split: report.dataset.split,
      model_version: report.model,
      prompt_version: report.prompt_version,
      fingerprint: fp?.hash ?? null,
      n: report.n,
      category_accuracy: report.category.overall.accuracy,
      category_macro_f1: report.category.macro_f1,
      priority_accuracy: report.priority.overall.accuracy,
      team_accuracy: report.team.overall.accuracy,
      ece: report.calibration.ece,
      brier: report.calibration.brier,
      false_routing_rate: report.routing.recommended.false_routing_rate,
      coverage: report.routing.recommended.coverage,
      correction_rate:
        report.category.overall.accuracy === null
          ? null
          : 1 - report.category.overall.accuracy,
      safety_misses: report.safety.misses.length,
      passed: report.passed,
      report,
    },
    toRecords(scored, report, { tenant: business.id }),
  );

  console.log(`Run ${runId} recorded with ${report.n} result row(s).\n`);
}

// --- golden --------------------------------------------------------------

const goldenDir = path.join(root, "eval", "golden-set");
const goldenBaselinesDir = path.join(baselinesDir, "golden");

/**
 * The reviewed golden set (eval/golden-set): whole-behaviour cases, one per
 * file, reviewed by a person before they count.
 *
 *   npm run eval golden                         lint and coverage; no database
 *   npm run eval golden -- run                  run the system over every case
 *   npm run eval golden -- run --offline        the free half only, even with a key
 *   npm run eval golden -- review               what is waiting for review
 *   npm run eval golden -- review <id>...       read those cases as prose
 *   npm run eval golden -- review <id>... --accept --reviewer you@example.com
 *   npm run eval golden -- review <id> --changes --note "why"
 *   npm run eval golden -- review <id> --reject --note "why"
 *
 * `run` takes --save-baseline <name>, --baseline <name>, --json <file> and
 * --tenant. It indexes the pinned runbooks into a scratch tenant, removed
 * afterwards, so a run does not depend on what the live index has learned
 * since the set was written.
 */
async function cmdGolden(flags: Flags, rest: readonly string[]): Promise<void> {
  const positional = rest.filter((a) => !a.startsWith("--") && !isFlagValue(rest, a));
  const sub = positional[0] ?? "check";
  switch (sub) {
    case "check":
      await goldenCheck(flags);
      break;
    case "run":
      await goldenRun(flags);
      break;
    case "review":
      await goldenReview(flags, positional.slice(1));
      break;
    default:
      console.error(`Unknown golden command: ${sub}. Use check, run or review.`);
      process.exitCode = 2;
  }
}

async function loadGoldenOrExplain(): Promise<LoadedGoldenSet | null> {
  const set = await loadGoldenSet(goldenDir);
  if (set.errors.length > 0) {
    console.error(`\n${set.errors.length} case file(s) in ${goldenDir} did not load:`);
    for (const e of set.errors) console.error(`  ${e.file}: ${e.message}`);
    console.error("");
    process.exitCode = 1;
    return null;
  }
  return set;
}

async function goldenCheck(flags: Flags): Promise<void> {
  const set = await loadGoldenOrExplain();
  if (!set) return;
  // Lint against default routing when no tenant is named, so the check runs
  // with no database at all.
  const settings = flags.tenant
    ? await getSettings((await resolveTenant(flags.tenant)).id)
    : BusinessSettings.parse(set.version.policy.settings);
  const issues = lintGoldenSet(set, { taxonomy: TAXONOMY, settings });
  const kb = await loadPinnedKb(root, set.version);

  console.log("");
  console.log(renderGoldenCoverage(goldenCoverage(set, TAXONOMY), issues));
  if (kb.drift.length) {
    console.log("");
    console.log("RUNBOOKS CHANGED SINCE THE SET PINNED THEM — retrieval labels may be stale:");
    for (const d of kb.drift) console.log(`  ${d}`);
  }

  // A regression gate nobody has pinned is a gate that passes by having
  // nothing to compare against. Say so here rather than letting the test
  // that skips it be the only record.
  console.log("");
  const baselineFile = path.join(goldenBaselinesDir, "main.json");
  const pinned = await fs
    .readFile(baselineFile, "utf8")
    .then((raw) => GoldenBaseline.parse(JSON.parse(raw)))
    .catch(() => null);
  console.log(
    pinned
      ? `BASELINE  "${pinned.label}" taken ${pinned.created_at} over ${pinned.results.length} case(s), ${pinned.golden_set.reviewed} reviewed` +
          (pinned.model_run.ran ? "" : `\n          model half not measured: ${pinned.model_run.reason}`)
      : "BASELINE  none pinned — nothing regresses against anything yet.\n          Pin one: npm run eval golden -- run --save-baseline main",
  );
  console.log("");
  if (issues.some((i) => i.level === "error")) process.exitCode = 1;
}

async function goldenRun(flags: Flags): Promise<void> {
  const set = await loadGoldenOrExplain();
  if (!set) return;
  const business = await resolveTenant(flags.tenant);
  const settings = await getSettings(business.id);
  const issues = lintGoldenSet(set, { taxonomy: TAXONOMY, settings });
  if (issues.some((i) => i.level === "error")) {
    console.error(`\n${renderLint(issues)}\n\nFix the errors before running: a case that cannot be scored honestly is not scored.\n`);
    process.exitCode = 1;
    return;
  }

  const kb = await loadPinnedKb(root, set.version);
  if (kb.drift.length) {
    console.warn("\nRunbooks changed since the set pinned them; retrieval labels may be stale:");
    for (const d of kb.drift) console.warn(`  ${d}`);
  }

  const modelReason = flags.offline
    ? "--offline"
    : credentialsConfigured()
      ? null
      : "no model credentials (ANTHROPIC_API_KEY is unset)";
  const tenant = { id: business.id, name: business.name, type: business.type };
  const cases = casesInScope(set.cases, "all");

  console.log("");
  console.log(
    `Running ${cases.length} golden case(s) against ${business.name}${modelReason ? `, offline: ${modelReason}` : `, with ${env.TRIAGE_MODEL} (this spends tokens)`}.`,
  );

  // A scratch tenant holding exactly the pinned runbooks. The live index grows
  // with every writeback, and a retrieval label written against six runbooks
  // is not a label for sixty.
  const scratch = await queryOne<{ id: string }>(
    `insert into businesses (name, type, settings) values ($1, $2, $3::jsonb) returning id`,
    [`golden-eval-${Date.now()}`, business.type, JSON.stringify(settings)],
  );
  const observations: CaseObservation[] = [];
  let costUsd = 0;
  try {
    const index = systemContext(scratch!.id, { requestId: "golden-eval" });
    for (const doc of kb.docs) {
      await ingestDocument(index, {
        title: doc.title,
        content: doc.body,
        origin: "runbook",
        categories: doc.categories,
        sourceUrl: `file://${path.join(root, set.version.kb.dir, doc.file)}`,
      });
    }
    const search = (text: string, category: string) =>
      retrieve(index, { queryText: text, categories: [category], limit: 5 });

    let done = 0;
    for (const c of cases) {
      const body = storedBody(c, settings);
      const hits = (await search(`${c.input.subject}\n${body}`, c.expected.triage.category)).map((h) => ({
        title: h.doc_title,
        score: Number(h.score.toFixed(4)),
      }));
      let obs = observeOffline(c, { settings, tenant, hits });
      if (!modelReason) {
        const modelled = await observeModel(c, obs, {
          settings,
          tenant,
          retrieve: search,
          triage: (input) => replayTriage(input, { businessId: business.id, purpose: "eval_golden" }),
        });
        obs = modelled.observation;
        costUsd += modelled.costUsd;
      }
      observations.push(obs);
      done += 1;
      if (done % 10 === 0 || done === cases.length) process.stdout.write(`\r  ${done}/${cases.length}`);
    }
    process.stdout.write("\n");
  } finally {
    await purgeBusinessUnaudited(scratch!.id);
  }

  const kbCorpus = kb.docs.map((d) => d.body).join("\n").toLowerCase();
  const byId = new Map(observations.map((o) => [o.case_id, o]));
  const results = cases.map((c) => scoreCase(c, byId.get(c.id)!, { settings, kbCorpus }));
  const summaries = {
    reviewed: summarize(results.filter((r) => r.review_status === "reviewed"), "reviewed"),
    all: summarize(results, "all"),
  };
  const embedder =
    env.EMBEDDING_PROVIDER === "openai" ? `openai:${env.EMBEDDING_MODEL}` : env.EMBEDDING_PROVIDER;
  const fp = goldenFingerprint({
    setId: goldenSetId(cases),
    kbHash: kb.hash,
    embedder,
    settings,
    triage: modelReason ? "not run" : `${env.TRIAGE_MODEL} ${triagePrompt.name}@${triagePrompt.version}`,
    draft: modelReason
      ? "not run"
      : `${env.DRAFT_MODEL} ${replyPrompt.name}@${replyPrompt.version} ${clarifyPrompt.name}@${clarifyPrompt.version}`,
  });

  console.log(
    renderGoldenRun(summaries, results, {
      fingerprint: fp.hash,
      modelRan: !modelReason,
      modelReason,
      costUsd,
      embedder,
    }),
  );

  if (flags.json) {
    await fs.mkdir(path.dirname(flags.json), { recursive: true });
    await fs.writeFile(flags.json, `${JSON.stringify({ summaries, results, observations }, null, 2)}\n`, "utf8");
    console.log(`Report written to ${flags.json}\n`);
  }

  if (flags.saveBaseline) {
    const file = path.join(goldenBaselinesDir, `${flags.saveBaseline}.json`);
    await saveGoldenBaseline(file, {
      kind: "golden",
      label: flags.saveBaseline,
      created_at: new Date().toISOString(),
      golden_set: {
        version: set.version.version,
        label_version: set.version.label_version,
        set_id: goldenSetId(cases),
        cases: cases.length,
        reviewed: reviewedCases(cases).length,
      },
      tenant: { name: business.name, type: business.type },
      settings: settings as unknown as Record<string, unknown>,
      fingerprint: fp,
      model_run: { ran: !modelReason, reason: modelReason, cost_usd: Number(costUsd.toFixed(6)) },
      observations: Object.fromEntries(observations.map((o) => [o.case_id, o])),
      results: baselineResults(results),
      summary: summaries,
    });
    console.log(`Golden baseline "${flags.saveBaseline}" written to ${file}\n`);
  }

  if (flags.baseline) {
    const file = path.join(goldenBaselinesDir, `${flags.baseline}.json`);
    let baseline;
    try {
      baseline = await loadGoldenBaseline(file);
    } catch {
      console.error(`\nNo golden baseline at ${file}. Pin one with --save-baseline ${flags.baseline}.\n`);
      process.exitCode = 2;
      return;
    }
    const cmp = compareGolden(results, baseline, fp);
    console.log(renderGoldenComparison(cmp));
    if (!cmp.passed) process.exitCode = 1;
  }
}

/**
 * Promote, send back or reject cases, one decision at a time.
 *
 * Accepting records who reviewed the case and when, and nothing else: a
 * reviewer who disagrees with a label edits the file, and the edit shows in
 * the diff next to their name. The lint runs on the result before anything is
 * written, so an acceptance by the case's own author, or by something that is
 * not a person, never reaches the file.
 */
async function goldenReview(flags: Flags, ids: readonly string[]): Promise<void> {
  const set = await loadGoldenOrExplain();
  if (!set) return;

  if (ids.length === 0) {
    const cov = goldenCoverage(set, TAXONOMY);
    console.log("");
    console.log(
      `${cov.by_status.reviewed} reviewed · ${cov.by_status.draft} draft · ${cov.by_status.needs_changes} needs changes · ${cov.by_status.rejected} rejected`,
    );
    console.log("");
    for (const c of set.cases.filter((x) => x.review.status === "draft" || x.review.status === "needs_changes")) {
      const t = c.expected.triage;
      console.log(
        `  ${c.id}  ${c.review.status.padEnd(13)} ${c.split.padEnd(7)} ${t.category}/${t.priority} -> ${c.expected.handling.action}`,
      );
      console.log(`      ${c.title}`);
    }
    console.log("");
    console.log("  Read one — npm run eval golden -- review <id> — then decide:");
    console.log("    npm run eval golden -- review <id> --accept --reviewer you@example.com");
    console.log("    npm run eval golden -- review <id> --changes --note 'what is wrong'");
    console.log("    npm run eval golden -- review <id> --reject --note 'why it does not belong'");
    console.log("");
    console.log(`  The guidelines the labels follow are ${path.join(goldenDir, "README.md")}.`);
    console.log("");
    return;
  }

  const unknownIds = ids.filter((id) => !set.cases.some((c) => c.id === id));
  if (unknownIds.length) {
    console.error(`No case ${unknownIds.join(", ")} in ${goldenDir}.`);
    process.exitCode = 1;
    return;
  }

  const decisions = [flags.accept, flags.changes, flags.reject].filter(Boolean).length;
  // Naming a case without a decision is how a reviewer reads it. Only a
  // decision needs to be unambiguous, so the check for one moves below this.
  if (decisions === 0) {
    for (const c of set.cases.filter((x) => ids.includes(x.id))) {
      console.log("");
      console.log(renderGoldenCase(c));
    }
    console.log("  Disagree? Edit the expectation in the file, then accept it: the edit is");
    console.log("  the record, and it shows in the diff next to your name.");
    console.log("");
    console.log(`    npm run eval golden -- review ${ids.join(" ")} --accept --reviewer you@example.com`);
    console.log(`    npm run eval golden -- review ${ids[0]} --changes --note 'what is wrong'`);
    console.log("");
    return;
  }
  if (decisions !== 1) {
    console.error("Pass exactly one of --accept, --changes or --reject. Reviewing is a decision, not a default.");
    process.exitCode = 2;
    return;
  }
  const reviewer = flags.reviewer ?? flags.labeler;
  if (!reviewer) {
    console.error("Pass --reviewer <you@example.com>. A reviewed label needs a reviewer somebody can ask.");
    process.exitCode = 2;
    return;
  }

  const wanted = new Set(ids);
  const now = new Date().toISOString();
  const status = flags.accept ? "reviewed" : flags.changes ? "needs_changes" : "rejected";
  const updated = set.cases.map((c) =>
    wanted.has(c.id)
      ? {
          ...c,
          review: {
            ...c.review,
            status,
            reviewed_by: reviewer,
            reviewed_at: now,
            notes: flags.note ?? c.review.notes,
          } as GoldenCase["review"],
        }
      : c,
  );

  const settings = BusinessSettings.parse(set.version.policy.settings);
  const problems = lintGoldenSet({ version: set.version, cases: updated }, { taxonomy: TAXONOMY, settings }).filter(
    (i) => i.level === "error" && i.case !== null && wanted.has(i.case),
  );
  if (problems.length) {
    console.error("\nNot written. Resolve these first:");
    for (const p of problems) console.error(`  ${p.case}: ${p.message}`);
    console.error("");
    process.exitCode = 1;
    return;
  }

  for (const c of updated.filter((x) => wanted.has(x.id))) {
    await fs.writeFile(caseFile(goldenDir, c.id), serializeCase(c), "utf8");
  }
  console.log("");
  console.log(`Marked ${ids.length} case(s) ${status}. ${reviewedCases(updated).length} reviewed in total.`);
  console.log("  Expectations are unchanged, so a baseline taken before this review still compares.");
  console.log("");
}

// --- plumbing ------------------------------------------------------------

interface Flags {
  tenant: string | null;
  days: number | null;
  limit: number | null;
  split: "train" | "holdout" | "all";
  dataset: string | null;
  json: string | null;
  model: string | null;
  promptVersion: string | null;
  baseline: string | null;
  saveBaseline: string | null;
  save: boolean;
  record: boolean;
  concurrency: number;
  holdoutPct: number;
  // review
  list: boolean;
  accept: boolean;
  reject: boolean;
  labeler: string | null;
  labelVersion: string | null;
  note: string | null;
  category: string | null;
  priority: string | null;
  team: string | null;
  // golden
  offline: boolean;
  changes: boolean;
  reviewer: string | null;
}

/** Flag values must not be mistaken for positional ids. */
function isFlagValue(argv: readonly string[], value: string): boolean {
  const i = argv.indexOf(value);
  return i > 0 && argv[i - 1]!.startsWith("--");
}

function parseFlags(argv: readonly string[]): Flags {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return null;
    return argv[i + 1] ?? null;
  };
  const num = (name: string): number | null => {
    const v = get(name);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const split = get("split");
  return {
    tenant: get("tenant"),
    days: num("days"),
    limit: num("limit"),
    split: split === "train" || split === "holdout" ? split : "all",
    dataset: get("dataset"),
    json: get("json"),
    model: get("model"),
    promptVersion: get("prompt-version"),
    baseline: get("baseline"),
    saveBaseline: get("save-baseline"),
    save: argv.includes("--save"),
    record: argv.includes("--record"),
    concurrency: num("concurrency") ?? 4,
    holdoutPct: num("holdout-pct") ?? 30,
    list: argv.includes("--list"),
    accept: argv.includes("--accept"),
    reject: argv.includes("--reject"),
    labeler: get("labeler"),
    labelVersion: get("label-version"),
    note: get("note"),
    category: get("category"),
    priority: get("priority"),
    team: get("team"),
    offline: argv.includes("--offline"),
    changes: argv.includes("--changes"),
    reviewer: get("reviewer"),
  };
}

async function resolveTenant(nameOrId: string | null): Promise<Business> {
  const businesses = await listBusinesses();
  if (businesses.length === 0) {
    console.error("No tenant. Run: npm run db:migrate && npm run db:seed");
    process.exit(1);
  }
  if (!nameOrId) return businesses[0]!;

  const match = businesses.find(
    (b) => b.id === nameOrId || b.name.toLowerCase() === nameOrId.toLowerCase(),
  );
  if (!match) {
    console.error(
      `No tenant "${nameOrId}". Known: ${businesses.map((b) => b.name).join(", ")}`,
    );
    process.exit(1);
  }
  return match;
}

/** A missing dataset is a workflow step somebody skipped, not a stack trace. */
async function loadDatasetOrExplain(file: string) {
  try {
    return await loadDataset(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    console.error(
      [
        "",
        `No dataset at ${file}.`,
        "",
        "Build one from the reconciled shadow records first:",
        "",
        "  npm run eval export",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return null;
  }
}

async function loadDatasetIfPresent(file: string) {
  try {
    const loaded = await loadDataset(file);
    reportDatasetErrors(loaded.errors, file);
    return loaded.samples;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function reportDatasetErrors(
  errors: ReadonlyArray<{ line: number; message: string }>,
  file: string,
): void {
  if (errors.length === 0) return;
  // Never silent: a dataset that quietly drops malformed lines is a dataset
  // whose size you cannot trust, and size is a gate.
  console.error(`\n${errors.length} unreadable line(s) in ${file}:`);
  for (const e of errors.slice(0, 5)) console.error(`  line ${e.line}: ${e.message}`);
  console.error("");
}

async function maybeWriteJson(file: string | null, report: EvalReport): Promise<void> {
  if (!file) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Report written to ${file}\n`);
}

main().catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});
