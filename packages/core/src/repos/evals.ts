import { query, queryOne, tx } from "../db.js";
import { requirePermission, type TenantContext } from "../auth/context.js";

/**
 * Evaluation runs and their per-ticket rows.
 *
 * Insert-only, in one transaction: a run whose summary landed and whose rows
 * did not is a run that lies about its own sample size.
 */

export interface EvalRunInput {
  source: string;
  dataset_path: string | null;
  dataset_id: string | null;
  split: string;
  model_version: string | null;
  prompt_version: string | null;
  fingerprint: string | null;
  n: number;
  category_accuracy: number | null;
  category_macro_f1: number | null;
  priority_accuracy: number | null;
  team_accuracy: number | null;
  ece: number | null;
  brier: number | null;
  false_routing_rate: number | null;
  coverage: number | null;
  correction_rate: number | null;
  safety_misses: number;
  passed: boolean;
  report: unknown;
}

export interface EvalResultInput {
  ticket_id: string;
  confidence: number;
  confidence_bucket: string;
  category: string;
  predicted_category: string;
  actual_category: string;
  correct: boolean;
  predicted_priority: string;
  actual_priority: string;
  priority_correct: boolean;
  predicted_team: string | null;
  actual_team: string | null;
  team_correct: boolean | null;
  would_auto_route: boolean;
  model_version: string | null;
  prompt_version: string | null;
  evaluation_timestamp: string;
}

/**
 * Store one scored evaluation run and its per-sample results.
 *
 * The tenant comes from the context rather than from `run.business_id`, so a
 * run cannot be filed against a business the caller is not acting in — an eval
 * row in the wrong tenant is a number somebody later cites to justify turning
 * autonomy up.
 */
export async function recordEvalRun(
  ctx: TenantContext,
  run: EvalRunInput,
  results: readonly EvalResultInput[],
): Promise<string> {
  return tx(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `insert into eval_runs
         (business_id, source, dataset_path, dataset_id, split, model_version,
          prompt_version, fingerprint, n, category_accuracy, category_macro_f1,
          priority_accuracy, team_accuracy, ece, brier, false_routing_rate,
          coverage, correction_rate, safety_misses, passed, report)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       returning id`,
      [
        ctx.businessId,
        run.source,
        run.dataset_path,
        run.dataset_id,
        run.split,
        run.model_version,
        run.prompt_version,
        run.fingerprint,
        run.n,
        run.category_accuracy,
        run.category_macro_f1,
        run.priority_accuracy,
        run.team_accuracy,
        run.ece,
        run.brier,
        run.false_routing_rate,
        run.coverage,
        run.correction_rate,
        run.safety_misses,
        run.passed,
        JSON.stringify(run.report),
      ],
    );
    const runId = inserted.rows[0]!.id;

    // One multi-row insert rather than a statement per ticket: a 250-sample
    // run is 250 round trips otherwise, and this is called from a CLI that
    // people will run in a loop while tuning.
    for (let i = 0; i < results.length; i += 200) {
      const chunk = results.slice(i, i + 200);
      const values: unknown[] = [];
      const rows = chunk.map((r, j) => {
        const b = j * 17;
        values.push(
          runId,
          ctx.businessId,
          // A replayed sample may carry a synthetic id rather than a uuid.
          isUuid(r.ticket_id) ? r.ticket_id : null,
          r.confidence,
          r.confidence_bucket,
          r.category,
          r.predicted_category,
          r.actual_category,
          r.correct,
          r.predicted_priority,
          r.actual_priority,
          r.priority_correct,
          r.predicted_team,
          r.actual_team,
          r.team_correct,
          r.would_auto_route,
          r.evaluation_timestamp,
        );
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14},$${b + 15},$${b + 16},$${b + 17})`;
      });

      await client.query(
        `insert into eval_results
           (run_id, business_id, ticket_id, confidence, confidence_bucket, category,
            predicted_category, actual_category, correct, predicted_priority,
            actual_priority, priority_correct, predicted_team, actual_team,
            team_correct, would_auto_route, evaluation_timestamp)
         values ${rows.join(",")}`,
        values as never[],
      );
    }

    // model_version and prompt_version are the same for every row in a run, so
    // they are set once rather than shipped 250 times over the wire.
    await client.query(
      `update eval_results set model_version = $2, prompt_version = $3 where run_id = $1`,
      [runId, run.model_version, run.prompt_version],
    );

    return runId;
  });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

export interface EvalRunSummary {
  id: string;
  source: string;
  split: string;
  dataset_id: string | null;
  model_version: string | null;
  prompt_version: string | null;
  fingerprint: string | null;
  n: number;
  category_accuracy: number | null;
  ece: number | null;
  false_routing_rate: number | null;
  coverage: number | null;
  safety_misses: number;
  passed: boolean;
  created_at: Date;
}

export async function recentEvalRuns(
  ctx: TenantContext,
  limit = 20,
): Promise<EvalRunSummary[]> {
  requirePermission(ctx, "analytics:read");
  return query<EvalRunSummary>(
    `select id, source, split, dataset_id, model_version, prompt_version,
            fingerprint, n, category_accuracy, ece, false_routing_rate,
            coverage, safety_misses, passed, created_at
       from eval_runs
      where business_id = $1
      order by created_at desc
      limit $2`,
    [ctx.businessId, limit],
  );
}

/** The most recent run for a given fingerprint, for the regression gate. */
export async function latestRunForFingerprint(
  ctx: TenantContext,
  fingerprint: string,
): Promise<EvalRunSummary | null> {
  requirePermission(ctx, "analytics:read");
  return queryOne<EvalRunSummary>(
    `select id, source, split, dataset_id, model_version, prompt_version,
            fingerprint, n, category_accuracy, ece, false_routing_rate,
            coverage, safety_misses, passed, created_at
       from eval_runs
      where business_id = $1 and fingerprint = $2
      order by created_at desc
      limit 1`,
    [ctx.businessId, fingerprint],
  );
}

export interface ThresholdCell {
  category: string;
  confidence_bucket: string;
  n: number;
  correct: number;
  accuracy: number;
}

/**
 * Accuracy by category and bucket across every stored run.
 *
 * The literal form of "which categories can safely operate at which confidence
 * threshold", asked over more data than any single run holds.
 */
export async function accuracyByCategoryBucket(
  ctx: TenantContext,
  opts: { promptVersion?: string; since?: Date } = {},
): Promise<ThresholdCell[]> {
  requirePermission(ctx, "analytics:read");
  return query<ThresholdCell>(
    `select category,
            confidence_bucket,
            count(*)::int as n,
            sum(case when correct then 1 else 0 end)::int as correct,
            avg(case when correct then 1.0 else 0.0 end)::float8 as accuracy
       from eval_results
      where business_id = $1
        and ($2::text is null or prompt_version = $2)
        and ($3::timestamptz is null or evaluation_timestamp >= $3)
      group by category, confidence_bucket
      order by category, confidence_bucket`,
    [ctx.businessId, opts.promptVersion ?? null, opts.since ?? null],
  );
}
