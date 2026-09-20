import { query, queryOne } from "./db.js";
import { requirePermission, type TenantContext } from "./auth/context.js";

export interface HeadlineMetrics {
  total: number;
  open: number;
  /** Closed with no human touch. */
  deflection_rate: number;
  escalation_rate: number;
  /** Agent-resolved tickets the user reopened. Watch this one hardest. */
  false_resolve_rate: number;
  median_first_response_minutes: number | null;
  median_resolution_hours: number | null;
}

/**
 * The headline numbers for one tenant.
 *
 * Gated on `analytics:read` and scoped from the context. Aggregates are worth
 * scoping as carefully as rows: "how many tickets did they close last month"
 * is competitive intelligence even though it names nobody.
 */
export async function headlineMetrics(
  ctx: TenantContext,
  days = 30,
): Promise<HeadlineMetrics> {
  requirePermission(ctx, "analytics:read");
  const row = await queryOne<Record<string, number | null>>(
    `with scoped as (
       select * from tickets
        where business_id = $1 and created_at > now() - ($2 || ' days')::interval
     )
     select
       (select count(*) from scoped)::int as total,
       (select count(*) from scoped where status not in ('resolved','closed'))::int as open,
       (select count(*) from scoped
         where resolution_path in ('auto_reply','auto_action')
           and status in ('resolved','closed')
           and assigned_to is null)::int as deflected,
       (select count(*) from scoped where resolution_path = 'escalated')::int as escalated,
       (select count(*) from scoped
         where resolution_path in ('auto_reply','auto_action') and reopened_count > 0)::int as false_resolved,
       (select count(*) from scoped where resolution_path in ('auto_reply','auto_action'))::int as agent_handled,
       (select percentile_cont(0.5) within group (
          order by extract(epoch from (first_response_at - created_at)) / 60)
          from scoped where first_response_at is not null) as p50_first_response_min,
       (select percentile_cont(0.5) within group (
          order by extract(epoch from (resolved_at - created_at)) / 3600)
          from scoped where resolved_at is not null) as p50_resolution_hours`,
    [ctx.businessId, String(days)],
  );

  const total = Number(row?.total ?? 0);
  const agentHandled = Number(row?.agent_handled ?? 0);
  const div = (a: number, b: number) => (b === 0 ? 0 : a / b);

  return {
    total,
    open: Number(row?.open ?? 0),
    deflection_rate: div(Number(row?.deflected ?? 0), total),
    escalation_rate: div(Number(row?.escalated ?? 0), total),
    false_resolve_rate: div(Number(row?.false_resolved ?? 0), agentHandled),
    median_first_response_minutes:
      row?.p50_first_response_min == null ? null : Number(row.p50_first_response_min),
    median_resolution_hours:
      row?.p50_resolution_hours == null ? null : Number(row.p50_resolution_hours),
  };
}

export interface CategoryVolume {
  category: string | null;
  n: number;
  deflected: number;
  escalated: number;
  mean_confidence: number | null;
}

export async function volumeByCategory(
  ctx: TenantContext,
  days = 30,
): Promise<CategoryVolume[]> {
  requirePermission(ctx, "analytics:read");
  return query<CategoryVolume>(
    `select category,
            count(*)::int as n,
            count(*) filter (where resolution_path in ('auto_reply','auto_action'))::int as deflected,
            count(*) filter (where resolution_path = 'escalated')::int as escalated,
            avg(triage_confidence) as mean_confidence
       from tickets
      where business_id = $1 and created_at > now() - ($2 || ' days')::interval
      group by 1
      order by n desc`,
    [ctx.businessId, String(days)],
  );
}

export async function spendByDay(
  ctx: TenantContext,
  days = 14,
): Promise<{ day: string; cost_usd: number; calls: number }[]> {
  requirePermission(ctx, "analytics:read");
  return query<{ day: string; cost_usd: number; calls: number }>(
    `select to_char(created_at::date, 'YYYY-MM-DD') as day,
            sum(cost_usd)::numeric as cost_usd,
            count(*)::int as calls
       from llm_usage
      where business_id = $1 and created_at > now() - ($2 || ' days')::interval
      group by 1 order by 1`,
    [ctx.businessId, String(days)],
  );
}
