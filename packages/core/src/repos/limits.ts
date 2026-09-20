import { query, queryOne } from "../db.js";
import type { TenantContext } from "../auth/context.js";
import type { BusinessSettings } from "../settings.js";

/**
 * Rate limits.
 *
 * Not about cost - the spend cap covers that. This is about loops. A mail
 * server that bounces the agent's reply back to the agent, or a monitoring
 * system that opens a ticket per failed check, will otherwise run until
 * somebody notices. A per-requester ceiling turns that into ten tickets rather
 * than ten thousand.
 *
 * Hitting a limit does not drop the ticket. It parks it for a human, which is
 * the same degraded state every other failure produces.
 */

export async function recordAgentRun(
  ctx: TenantContext,
  input: { requester_id: string | null; ticket_id: string | null },
): Promise<void> {
  await query(
    `insert into agent_runs (business_id, requester_id, ticket_id) values ($1,$2,$3)`,
    [ctx.businessId, input.requester_id, input.ticket_id],
  );
}

export interface RateLimitVerdict {
  allowed: boolean;
  scope?: "requester" | "tenant";
  used?: number;
  limit?: number;
}

export async function checkRateLimit(
  ctx: TenantContext,
  requesterId: string | null,
  settings: BusinessSettings,
): Promise<RateLimitVerdict> {
  const row = await queryOne<{ tenant: number; requester: number }>(
    `select
       (select count(*) from agent_runs
         where business_id = $1 and created_at > now() - interval '1 hour')::int as tenant,
       (select count(*) from agent_runs
         where business_id = $1 and requester_id = $2
           and created_at > now() - interval '1 hour')::int as requester`,
    [ctx.businessId, requesterId],
  );

  const tenantUsed = Number(row?.tenant ?? 0);
  if (tenantUsed >= settings.max_agent_runs_per_tenant_hour) {
    return {
      allowed: false,
      scope: "tenant",
      used: tenantUsed,
      limit: settings.max_agent_runs_per_tenant_hour,
    };
  }

  const requesterUsed = Number(row?.requester ?? 0);
  if (requesterId && requesterUsed >= settings.max_agent_runs_per_requester_hour) {
    return {
      allowed: false,
      scope: "requester",
      used: requesterUsed,
      limit: settings.max_agent_runs_per_requester_hour,
    };
  }

  return { allowed: true };
}
