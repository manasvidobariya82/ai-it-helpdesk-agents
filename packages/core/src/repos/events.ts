import { query } from "../db.js";
import { requirePermission, type TenantContext } from "../auth/context.js";
import type { EventKind, TicketEvent } from "../types.js";

export interface AppendEventInput {
  ticket_id: string;
  actor: string; // 'agent' | 'user' | 'human:<id>' | 'system'
  kind: EventKind;
  payload: Record<string, unknown>;
  model?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cost_usd?: number | null;
  latency_ms?: number | null;
}

/**
 * The event log is append-only on purpose. There is no update and no delete
 * here, and there should never be one: the log is the only honest answer to
 * "why did the agent close this ticket?" three months after the fact.
 *
 * `ticket_events` carries no `business_id` of its own — it inherits the
 * ticket's — so the tenant predicate is a subquery rather than a column
 * comparison. An id from another tenant inserts nothing, because the `select`
 * feeding the `insert` returns no row.
 */
export async function appendEvent(
  ctx: TenantContext,
  e: AppendEventInput,
): Promise<void> {
  // Words go in the conversation now (docs/conversation.md). `reply` and
  // `draft` events are the record from before it, which the backfill copies
  // in order and refuses to copy after anything later. So a new one would be
  // stranded, and nothing may write one.
  if (e.kind === "reply" || e.kind === "draft") {
    throw new Error(
      `a ${e.kind} is written to the conversation with appendMessage, not to the event log`,
    );
  }
  await query(
    `insert into ticket_events
       (ticket_id, actor, kind, payload, model, tokens_in, tokens_out, cost_usd, latency_ms)
     select t.id, $2, $3, $4::jsonb, $5, $6, $7, $8, $9
       from tickets t
      where t.id = $1 and t.business_id = $10`,
    [
      e.ticket_id,
      e.actor,
      e.kind,
      JSON.stringify(e.payload),
      e.model ?? null,
      e.tokens_in ?? null,
      e.tokens_out ?? null,
      e.cost_usd ?? null,
      e.latency_ms ?? null,
      ctx.businessId,
    ],
  );
}

/**
 * The thread for one ticket.
 *
 * Joined to `tickets` so the tenant predicate applies. Returns an empty list
 * for a ticket in another tenant, which is the same thing the caller sees for
 * a ticket that does not exist.
 */
export async function eventsFor(
  ctx: TenantContext,
  ticketId: string,
): Promise<TicketEvent[]> {
  requirePermission(ctx, "ticket:read");
  return query<TicketEvent>(
    `select e.*
       from ticket_events e
       join tickets t on t.id = e.ticket_id
      where e.ticket_id = $1 and t.business_id = $2
      order by e.created_at asc, e.id asc`,
    [ticketId, ctx.businessId],
  );
}

export async function latestEventOfKind(
  ctx: TenantContext,
  ticketId: string,
  kind: EventKind,
): Promise<TicketEvent | null> {
  requirePermission(ctx, "ticket:read");
  const rows = await query<TicketEvent>(
    `select e.*
       from ticket_events e
       join tickets t on t.id = e.ticket_id
      where e.ticket_id = $1 and e.kind = $2 and t.business_id = $3
      order by e.created_at desc, e.id desc limit 1`,
    [ticketId, kind, ctx.businessId],
  );
  return rows[0] ?? null;
}
