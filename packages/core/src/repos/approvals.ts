import { createHash } from "node:crypto";
import { query, queryOne } from "../db.js";
import { requirePermission, type TenantContext } from "../auth/context.js";
import { getSettings } from "./businesses.js";
import { audit } from "./audit.js";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "executed"
  | "failed";

export interface ActionRequest {
  id: string;
  business_id: string;
  ticket_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  risk_tier: string;
  rationale: string;
  status: ApprovalStatus;
  requested_by: string;
  decided_by: string | null;
  decided_at: Date | null;
  result: Record<string, unknown> | null;
  error: string | null;
  /** After this, the request can no longer be approved or executed. */
  expires_at: Date | null;
  /** Hash of the arguments the approver saw. */
  args_hash: string | null;
  created_at: Date;
}

/**
 * A stable fingerprint of the arguments an approval covers.
 *
 * Keys are sorted so that two objects meaning the same thing hash the same;
 * without that, a re-serialization somewhere in the stack would invalidate a
 * perfectly good approval and the check would be quietly disabled by whoever
 * got tired of it.
 */
export function hashArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(args)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * The agent asking for permission to act.
 *
 * Takes a context rather than a `business_id` so the row cannot be filed
 * against a tenant the caller is not in. In practice the caller is the
 * pipeline's `agentContext`, which holds `action:execute` and not
 * `action:approve` — the agent may ask, and may never answer.
 */
export async function requestApproval(
  ctx: TenantContext,
  input: {
    ticket_id: string;
    tool_name: string;
    args: Record<string, unknown>;
    risk_tier: string;
    rationale: string;
  },
): Promise<ActionRequest> {
  // The deadline is stamped at creation rather than computed at read time, so
  // shortening the tenant's expiry window later cannot retroactively revive a
  // request, and lengthening it cannot retroactively extend one.
  const settings = await getSettings(ctx.businessId);

  const row = await queryOne<ActionRequest>(
    `insert into action_requests
       (business_id, ticket_id, tool_name, args, risk_tier, rationale,
        requested_by, expires_at, args_hash)
     select $1, t.id, $3, $4::jsonb, $5, $6, $7,
            now() + ($8 || ' hours')::interval, $9
       from tickets t
      where t.id = $2 and t.business_id = $1
     returning *`,
    [
      ctx.businessId,
      input.ticket_id,
      input.tool_name,
      JSON.stringify(input.args),
      input.risk_tier,
      input.rationale,
      actorLabel(ctx),
      String(settings.approval_expiry_hours),
      hashArgs(input.args),
    ],
  );
  if (!row) throw new Error("cannot request an approval against another tenant's ticket");
  return row;
}

function actorLabel(ctx: TenantContext): string {
  return ctx.actorType === "human" ? `human:${ctx.actorId ?? "unknown"}` : ctx.actorType;
}

/**
 * The queue a reviewer sees.
 *
 * Filters on the deadline as well as the status, so a request that has expired
 * but not yet been swept does not appear as actionable. The sweep tidies the
 * row; this makes the queue correct without waiting for it.
 */
export async function pendingApprovals(
  ctx: TenantContext,
): Promise<(ActionRequest & { subject: string })[]> {
  requirePermission(ctx, "ticket:read");
  return query<ActionRequest & { subject: string }>(
    `select a.*, t.subject
       from action_requests a
       join tickets t on t.id = a.ticket_id
      where a.business_id = $1
        and a.status = 'pending'
        and a.expires_at is not null
        and a.expires_at > now()
      order by a.expires_at asc`,
    [ctx.businessId],
  );
}

/** Recently expired requests, so the queue can show what lapsed unattended. */
export async function expiredApprovals(
  ctx: TenantContext,
  limit = 20,
): Promise<(ActionRequest & { subject: string })[]> {
  requirePermission(ctx, "ticket:read");
  return query<ActionRequest & { subject: string }>(
    `select a.*, t.subject
       from action_requests a
       join tickets t on t.id = a.ticket_id
      where a.business_id = $1
        and (a.status = 'expired'
             or (a.status = 'pending'
                 and (a.expires_at is null or a.expires_at <= now())))
      order by a.created_at desc
      limit $2`,
    [ctx.businessId, limit],
  );
}

export async function getApproval(
  ctx: TenantContext,
  id: string,
): Promise<ActionRequest | null> {
  requirePermission(ctx, "ticket:read");
  return queryOne<ActionRequest>(
    `select * from action_requests where id = $1 and business_id = $2`,
    [id, ctx.businessId],
  );
}

export class ApprovalExpiredError extends Error {
  readonly status = 410;
  constructor(readonly id: string) {
    super(
      "This request expired before it was approved. The situation it was raised " +
        "for may have moved on, so it has to be raised again rather than revived.",
    );
    this.name = "ApprovalExpiredError";
  }
}

/**
 * Approve or reject a queued action.
 *
 * `action:approve` is a manager permission and above — the rule is that the
 * actor who asks for an action is never the actor who grants it, and the agent
 * context deliberately does not carry this permission. The update is scoped by
 * tenant, by `status = 'pending'` and by the deadline in one statement, so two
 * reviewers racing on the same row produce one decision and one null.
 */
export async function decideApproval(
  ctx: TenantContext,
  id: string,
  decision: "approved" | "rejected",
  opts: { reason?: string | null } = {},
): Promise<ActionRequest | null> {
  requirePermission(ctx, "action:approve");

  // The deadline is part of the `where`, not a check before it. Two reviewers
  // racing on a request that expires between them get the same answer, and
  // there is no window in which a read said "still fine" and the write
  // disagreed.
  const row = await queryOne<ActionRequest>(
    `update action_requests
        set status = $3, decided_by = $4, decided_at = now()
      where id = $1 and business_id = $2 and status = 'pending'
        and expires_at is not null and expires_at > now()
      returning *`,
    [id, ctx.businessId, decision, actorLabel(ctx)],
  );

  if (!row) {
    // Distinguish "expired" from "never existed here": the first is worth
    // telling the reviewer about, and within their own tenant the existence of
    // the row is not a secret.
    const stale = await queryOne<{ id: string; status: string }>(
      `select id, status from action_requests
        where id = $1 and business_id = $2`,
      [id, ctx.businessId],
    );
    if (stale?.status === "pending" || stale?.status === "expired") {
      await markExpired(id);
      await audit(ctx, {
        action: "approval.decide",
        resource_type: "action_request",
        resource_id: id,
        old_value: { status: "pending" },
        new_value: { status: "expired", attempted: decision },
        reason: "decided after the request had expired",
      });
      throw new ApprovalExpiredError(id);
    }
    return null;
  }

  await audit(ctx, {
    action: "approval.decide",
    resource_type: "action_request",
    resource_id: id,
    old_value: { status: "pending" },
    new_value: {
      status: decision,
      tool: row.tool_name,
      risk_tier: row.risk_tier,
      ticket_id: row.ticket_id,
    },
    reason: opts.reason ?? null,
  });

  return row;
}

async function markExpired(id: string): Promise<void> {
  await query(
    `update action_requests set status = 'expired'
      where id = $1 and status = 'pending'`,
    [id],
  );
}

/**
 * Whether this approval authorizes this exact call, right now.
 *
 * The tool registry used to unlock on `Boolean(ctx.approvalId)`, which checked
 * that an approval id was present and never that it was valid. Any non-empty
 * string ran a destructive tool.
 *
 * Four things have to hold, and each one is a way the previous check failed:
 * the row is in the caller's tenant, it was approved rather than rejected or
 * still pending, it has not expired, and the arguments are the ones the
 * approver actually saw. The last matters most — without it an approval to
 * reset one person's password is a capability to reset anybody's.
 */
export type ApprovalCheck =
  | { ok: true; request: ActionRequest }
  | { ok: false; reason: "not_found" | "not_approved" | "expired" | "args_changed" };

export async function checkApproval(
  ctx: TenantContext,
  approvalId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ApprovalCheck> {
  const row = await queryOne<ActionRequest>(
    `select * from action_requests
      where id = $1 and business_id = $2 and tool_name = $3`,
    [approvalId, ctx.businessId, toolName],
  );
  if (!row) return { ok: false, reason: "not_found" };

  if (row.status !== "approved") {
    // `executed` is included here on purpose: an approval is for one call, and
    // replaying a completed one is a second action nobody signed off.
    return { ok: false, reason: "not_approved" };
  }

  if (!row.expires_at || new Date(row.expires_at).getTime() <= Date.now()) {
    await markExpiredAfterApproval(approvalId);
    return { ok: false, reason: "expired" };
  }

  if (row.args_hash && row.args_hash !== hashArgs(args)) {
    return { ok: false, reason: "args_changed" };
  }

  return { ok: true, request: row };
}

/**
 * An approved-but-unexecuted request whose window closed.
 *
 * Kept distinct from the pending sweep because the row has a decision on it:
 * somebody said yes, and then nothing happened in time. That is worth seeing in
 * the log as its own event rather than being tidied into "expired" silently.
 */
async function markExpiredAfterApproval(id: string): Promise<void> {
  await query(
    `update action_requests set status = 'expired'
      where id = $1 and status = 'approved'`,
    [id],
  );
}

/**
 * Mark lapsed requests, and put a note on the ticket.
 *
 * Expiry is enforced at the point of use as well, so a sweep that has not run
 * cannot let a stale approval through. This exists so the queue is honest and
 * so somebody finds out that the action they asked for never happened —
 * an approval that silently lapses is indistinguishable from one that was
 * quietly denied.
 */
export async function expireApprovals(): Promise<
  { id: string; business_id: string; ticket_id: string; tool_name: string }[]
> {
  return query<{
    id: string;
    business_id: string;
    ticket_id: string;
    tool_name: string;
  }>(
    `update action_requests
        set status = 'expired'
      where status in ('pending', 'approved')
        and (expires_at is null or expires_at <= now())
      returning id, business_id, ticket_id, tool_name`,
  );
}

export async function recordApprovalOutcome(
  ctx: TenantContext,
  id: string,
  ok: boolean,
  result: unknown,
  error: string | null,
): Promise<void> {
  await query(
    `update action_requests
        set status = $3, result = $4::jsonb, error = $5
      where id = $1 and business_id = $2`,
    [id, ctx.businessId, ok ? "executed" : "failed", JSON.stringify(result ?? null), error],
  );
}

export async function logToolCall(
  ctx: TenantContext,
  input: {
    ticket_id: string | null;
    action_request_id?: string | null;
    tool_name: string;
    args: Record<string, unknown>;
    ok: boolean;
    result?: unknown;
    error?: string | null;
    latency_ms?: number | null;
  },
): Promise<void> {
  await query(
    `insert into tool_calls
       (business_id, ticket_id, action_request_id, tool_name, args, ok, result, error, latency_ms)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9)`,
    [
      ctx.businessId,
      input.ticket_id,
      input.action_request_id ?? null,
      input.tool_name,
      JSON.stringify(input.args),
      input.ok,
      JSON.stringify(input.result ?? null),
      input.error ?? null,
      input.latency_ms ?? null,
    ],
  );
}
