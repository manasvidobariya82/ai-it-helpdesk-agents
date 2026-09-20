import { query, queryOne } from "../db.js";
import { requirePermission, type TenantContext } from "../auth/context.js";

/**
 * The audit log for everything that is not a ticket event.
 *
 * `ticket_events` answers "why did the agent close this ticket". It cannot
 * answer "who widened a category's autonomy on Friday afternoon", because that
 * change belongs to no ticket. This does.
 *
 * Append-only. There is an insert and two reads in this file and there should
 * never be an update or a delete: an audit trail somebody can edit is a
 * narrative.
 */

export type AuditAction =
  | "auth.sign_in"
  | "auth.sign_out"
  | "auth.sign_in_failed"
  | "auth.tenant_switch"
  | "config.update"
  | "config.autonomy_change"
  | "config.rollback"
  | "config.change_proposed"
  | "config.change_approved"
  | "config.change_rejected"
  | "user.invite"
  | "user.role_change"
  | "user.deactivate"
  | "approval.decide"
  | "action.execute"
  | "ticket.update"
  | "ticket.assign"
  | "ticket.merge"
  | "kb.publish"
  | "credentials.update"
  | "credentials.read"
  // Outbound mail. Retrying and cancelling a message are operator decisions
  // about contacting a person; suppressing and un-suppressing an address decide
  // whether that person can be contacted at all, which is the one of the four
  // that somebody may have to answer for.
  | "notification.retry"
  | "notification.cancel"
  | "notification.suppress"
  | "notification.unsuppress"
  // Consent. An opt-out is somebody saying "stop", and an opt-in is somebody
  // else deciding they did not mean it — the second is the one worth being able
  // to ask about later.
  | "notification.optout"
  | "notification.optin"
  // Inbound credentials. Issuing one grants a machine the authority of a role,
  // which is the kind of thing an incident review asks about by name.
  | "api_key.create"
  | "api_key.revoke"
  | "authz.denied";

export interface AuditEntry {
  action: AuditAction;
  resource_type: string;
  resource_id?: string | null;
  /**
   * The specific attribute that moved, where one did.
   *
   * Split from `resource_id` because they answer different questions.
   * `resource_id` is which row; `field` is which part of it. Keeping them apart
   * is what lets an investigation ask for every change to
   * `category_policies.vpn.confidence_threshold` without knowing or caring
   * which resource carried it.
   */
  field?: string | null;
  old_value?: unknown;
  new_value?: unknown;
  reason?: string | null;
  /**
   * Context for whoever reads this row later: the risk classification, the
   * impact sentence, which version it produced. Never branched on.
   */
  metadata?: unknown;
  /** The configuration version this change produced, for settings changes. */
  config_version?: number | null;
}

/**
 * Write one audit row from a tenant context.
 *
 * The actor fields are denormalized deliberately: an audit row has to stay
 * readable after the user is deleted, and has to record the role as it was at
 * the time rather than as it is now.
 */
export async function audit(ctx: TenantContext, entry: AuditEntry): Promise<void> {
  await query(
    `insert into audit_events
       (business_id, actor_id, actor_type, actor_email, actor_role, action,
        resource_type, resource_id, field, old_value, new_value, reason,
        request_id, session_id, ip, user_agent, metadata, config_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,
             $17::jsonb,$18)`,
    [
      ctx.businessId,
      ctx.actorId,
      ctx.actorType,
      ctx.actorEmail,
      ctx.role,
      entry.action,
      entry.resource_type,
      entry.resource_id ?? null,
      entry.field ?? null,
      entry.old_value === undefined ? null : JSON.stringify(entry.old_value),
      entry.new_value === undefined ? null : JSON.stringify(entry.new_value),
      entry.reason ?? null,
      ctx.requestId,
      ctx.sessionId,
      ctx.ip,
      ctx.userAgent,
      entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
      entry.config_version ?? null,
    ],
  );
}

/**
 * Audit an authentication event, which by definition has no tenant context yet.
 *
 * A failed sign-in is worth more than a successful one: it is the only record
 * that somebody tried.
 */
export async function auditAnonymous(entry: {
  action: AuditAction;
  business_id?: string | null;
  actor_email?: string | null;
  actor_id?: string | null;
  resource_type: string;
  resource_id?: string | null;
  reason?: string | null;
  request_id?: string | null;
  session_id?: string | null;
  ip?: string | null;
  user_agent?: string | null;
  new_value?: unknown;
}): Promise<void> {
  await query(
    `insert into audit_events
       (business_id, actor_id, actor_type, actor_email, actor_role, action,
        resource_type, resource_id, new_value, reason, request_id, session_id,
        ip, user_agent)
     values ($1,$2,'human',$3,null,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
    [
      entry.business_id ?? null,
      entry.actor_id ?? null,
      entry.actor_email ?? null,
      entry.action,
      entry.resource_type,
      entry.resource_id ?? null,
      entry.new_value === undefined ? null : JSON.stringify(entry.new_value),
      entry.reason ?? null,
      entry.request_id ?? null,
      entry.session_id ?? null,
      entry.ip ?? null,
      entry.user_agent ?? null,
    ],
  );
}

export interface AuditRow {
  id: number;
  business_id: string | null;
  field?: string | null;
  metadata?: unknown;
  config_version?: number | null;
  actor_id: string | null;
  actor_type: string;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  old_value: unknown;
  new_value: unknown;
  reason: string | null;
  request_id: string | null;
  session_id: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
}

export interface AuditFilters {
  action?: string;
  /** Several actions at once, for the console's grouped filters. */
  actions?: string[];
  resourceType?: string;
  resourceId?: string;
  /** Exact settings key, e.g. `category_policies.vpn.confidence_threshold`. */
  field?: string;
  /** Prefix match on the field, e.g. `category_policies` for every category. */
  fieldPrefix?: string;
  actorId?: string;
  actorEmail?: string;
  configVersion?: number;
  since?: Date;
  until?: Date;
  /** Free text across reason, field, resource id and actor email. */
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * Read the audit trail for the caller's tenant.
 *
 * Scoped from the context, never from a parameter, and gated on `audit:read` —
 * the log records who did what, which is exactly the sort of thing an ordinary
 * agent account should not be browsing.
 */
/**
 * Turn a filter object into a `where` clause and its parameters.
 *
 * Shared by the listing and the count so the two can never disagree about what
 * a filter means — a paginator whose count comes from a different predicate
 * than its rows is a paginator that lies at the last page.
 */
function buildFilter(
  ctx: TenantContext,
  filters: AuditFilters,
): { where: string; params: unknown[] } {
  const params: unknown[] = [ctx.businessId];
  const where = [`business_id = $1`];

  const eq = (value: unknown, sql: (i: number) => string) => {
    params.push(value);
    where.push(sql(params.length));
  };

  if (filters.action) eq(filters.action, (i) => `action = $${i}`);
  if (filters.actions?.length) {
    eq(filters.actions, (i) => `action = any($${i}::text[])`);
  }
  if (filters.resourceType) eq(filters.resourceType, (i) => `resource_type = $${i}`);
  if (filters.resourceId) eq(filters.resourceId, (i) => `resource_id = $${i}`);
  if (filters.field) eq(filters.field, (i) => `field = $${i}`);
  if (filters.fieldPrefix) {
    eq(filters.fieldPrefix, (i) => `(field = $${i} or field like $${i} || '.%')`);
  }
  if (filters.actorId) eq(filters.actorId, (i) => `actor_id = $${i}`);
  if (filters.actorEmail) {
    eq(filters.actorEmail, (i) => `lower(actor_email) = lower($${i})`);
  }
  if (filters.configVersion !== undefined) {
    eq(filters.configVersion, (i) => `config_version = $${i}`);
  }
  if (filters.since) eq(filters.since, (i) => `created_at >= $${i}`);
  if (filters.until) eq(filters.until, (i) => `created_at <= $${i}`);
  if (filters.search) {
    eq(
      `%${filters.search}%`,
      (i) =>
        `(reason ilike $${i} or field ilike $${i} or resource_id ilike $${i} ` +
        `or actor_email ilike $${i} or action ilike $${i})`,
    );
  }

  return { where: where.join(" and "), params };
}

export async function listAudit(
  ctx: TenantContext,
  filters: AuditFilters = {},
): Promise<AuditRow[]> {
  requirePermission(ctx, "audit:read");
  const { where, params } = buildFilter(ctx, filters);

  params.push(filters.limit ?? 100);
  const limitIdx = params.length;
  params.push(filters.offset ?? 0);
  const offsetIdx = params.length;

  return query<AuditRow>(
    `select * from audit_events
      where ${where}
      order by created_at desc, id desc
      limit $${limitIdx} offset $${offsetIdx}`,
    params,
  );
}

/** How many rows a filter matches, so the console can page without guessing. */
export async function countAudit(
  ctx: TenantContext,
  filters: AuditFilters = {},
): Promise<number> {
  requirePermission(ctx, "audit:read");
  const { where, params } = buildFilter(ctx, filters);
  const row = await queryOne<{ n: number }>(
    `select count(*)::int as n from audit_events where ${where}`,
    params,
  );
  return Number(row?.n ?? 0);
}

/** The configuration history for one tenant, which is the governance question. */
export async function configHistory(
  ctx: TenantContext,
  limit = 50,
): Promise<AuditRow[]> {
  requirePermission(ctx, "audit:read");
  return query<AuditRow>(
    `select * from audit_events
      where business_id = $1
        and action in ('config.update', 'config.autonomy_change', 'config.rollback',
                       'config.change_proposed', 'config.change_approved',
                       'config.change_rejected', 'credentials.update')
      order by created_at desc, id desc
      limit $2`,
    [ctx.businessId, limit],
  );
}

