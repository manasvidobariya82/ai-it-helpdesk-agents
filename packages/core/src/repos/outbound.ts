import { query, queryOne } from "../db.js";
import {
  actorString,
  requirePermission,
  type TenantContext,
} from "../auth/context.js";
import { env } from "../env.js";
import { audit } from "./audit.js";

/**
 * The outbound mail queue.
 *
 * One rule shapes every function here: the row is the message. It is written
 * before anything touches the network, it carries its own status, attempt count
 * and retry clock, and every transition leaves a history row behind. A send
 * that lives only inside an `await` cannot be retried by a different worker,
 * cannot be deduplicated, cannot be shown to a human, and disappears on a
 * deploy — and the person waiting for the reply is the last to find out.
 *
 * The other rule: this layer never decides whether a message *should* be sent.
 * That is the risk gate and the autonomy dial, upstream. A transport that could
 * also grant itself permission would be a second, quieter copy of the autonomy
 * policy, which is the thing the whole design exists to prevent.
 */

export type OutboundStatus =
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "bounced"
  | "suppressed"
  | "cancelled";

export interface OutboundMessage {
  id: string;
  business_id: string;
  ticket_id: string | null;
  idempotency_key: string;
  kind: string;
  to_email: string;
  to_name: string | null;
  from_email: string;
  from_name: string | null;
  reply_to: string | null;
  subject: string;
  body: string;
  message_id: string;
  in_reply_to: string | null;
  reference_ids: string[];
  status: OutboundStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  provider: string | null;
  provider_message_id: string | null;
  last_error: string | null;
  sent_at: Date | null;
  failed_at: Date | null;
  bounce_kind: string | null;
  bounce_detail: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface OutboundEventRow {
  id: number;
  outbound_id: string;
  kind: string;
  detail: Record<string, unknown>;
  actor: string;
  created_at: Date;
}

export interface Suppression {
  id: number;
  business_id: string;
  email: string;
  reason: string;
  detail: string | null;
  outbound_id: string | null;
  created_by: string;
  created_at: Date;
}

const COLUMNS = `
  business_id, ticket_id, idempotency_key, kind, to_email, to_name,
  from_email, from_name, reply_to, subject, body, message_id, in_reply_to,
  reference_ids, max_attempts, created_by, status`;

export interface QueueOutboundInput {
  /** Null for a message that is not about one ticket. */
  ticket_id: string | null;
  kind?: string;
  to_email: string;
  to_name?: string | null;
  from_email: string;
  from_name?: string | null;
  reply_to?: string | null;
  subject: string;
  body: string;
  message_id: string;
  in_reply_to?: string | null;
  references?: string[];
  idempotency_key: string;
  max_attempts?: number;
}

export interface QueueOutboundResult {
  message: OutboundMessage;
  /** False when an identical key already existed. Nothing new was queued. */
  queued: boolean;
  /** True when the address is suppressed: recorded, never attempted. */
  suppressed: boolean;
}

/**
 * Put a message in the queue.
 *
 * Three outcomes, and all three are a row:
 *
 *   - queued, the ordinary case;
 *   - already there, because the key matched — a double-clicked Send button, a
 *     retried job or a redelivered webhook, and the answer is the existing
 *     message rather than a second copy;
 *   - suppressed, because this address has hard-bounced or complained. It is
 *     still recorded, with a status that says why nothing was attempted, so
 *     "the requester never heard back" has an answer other than silence.
 */
export async function queueOutbound(
  ctx: TenantContext,
  input: QueueOutboundInput,
): Promise<QueueOutboundResult> {
  // Sending is contacting a person outside the company. The tool gate checks
  // this too; checking it here as well means a future caller that bypasses the
  // registry does not quietly become a mail relay.
  requirePermission(ctx, "action:execute");

  const suppressed = await isSuppressed(ctx, input.to_email);
  const status: OutboundStatus = suppressed ? "suppressed" : "queued";

  const params = [
    ctx.businessId,
    input.ticket_id,
    input.idempotency_key,
    input.kind ?? "reply",
    input.to_email.trim().toLowerCase(),
    input.to_name ?? null,
    input.from_email.trim().toLowerCase(),
    input.from_name ?? null,
    input.reply_to ?? null,
    input.subject,
    input.body,
    input.message_id,
    input.in_reply_to ?? null,
    input.references ?? [],
    input.max_attempts ?? env.OUTBOUND_MAX_ATTEMPTS,
    actorString(ctx),
    status,
  ];

  // With a ticket id the insert selects from `tickets` under the tenant
  // predicate, so a ticket belonging to another business inserts nothing rather
  // than filing a message against it. Without one there is nothing to check.
  const sql = input.ticket_id
    ? `insert into outbound_messages (${COLUMNS})
       select $1, t.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::text[], $15, $16, $17::outbound_status
         from tickets t
        where t.id = $2 and t.business_id = $1
       on conflict (business_id, idempotency_key) do nothing
       returning *`
    : `insert into outbound_messages (${COLUMNS})
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::text[], $15, $16, $17::outbound_status)
       on conflict (business_id, idempotency_key) do nothing
       returning *`;

  const row = await queryOne<OutboundMessage>(sql, params);

  if (!row) {
    // Either the key already exists, or the ticket is not ours. The second is
    // the caller's bug and must not look like a successful send.
    const existing = await queryOne<OutboundMessage>(
      `select * from outbound_messages
        where business_id = $1 and idempotency_key = $2`,
      [ctx.businessId, input.idempotency_key],
    );
    if (!existing) {
      throw new Error(
        "cannot queue a message against a ticket that is not in this tenant",
      );
    }
    return { message: existing, queued: false, suppressed: existing.status === "suppressed" };
  }

  await recordOutboundEvent(ctx, row.id, suppressed ? "suppressed" : "queued", {
    to: row.to_email,
    ticket_id: row.ticket_id,
    kind: row.kind,
    ...(suppressed ? { reason: "address is on this tenant's suppression list" } : {}),
  });

  return { message: row, queued: !suppressed, suppressed };
}

/**
 * One line in a message's delivery history.
 *
 * Scoped through the parent row: an id from another tenant matches nothing, so
 * the history cannot be written into somebody else's message.
 */
export async function recordOutboundEvent(
  ctx: TenantContext,
  outboundId: string,
  kind: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await query(
    `insert into outbound_message_events (outbound_id, kind, detail, actor)
     select m.id, $2, $3::jsonb, $4
       from outbound_messages m
      where m.id = $1 and m.business_id = $5`,
    [outboundId, kind, JSON.stringify(detail), actorString(ctx), ctx.businessId],
  );
}

/**
 * Take a queued message for delivery, atomically.
 *
 * Context-free by design, and the same shape as `getTicketUnscoped`: the worker
 * holds a job id and no tenant, and the row it gets back is what names the
 * tenant every subsequent write is scoped by. The claim is one statement —
 * status, attempt counter and timestamp move together — so two workers racing
 * on the same id produce one delivery and one null, and a message can never be
 * sent twice because a read said `queued` a moment before the other worker's
 * write.
 *
 * The retry deadline is part of the predicate rather than a grace window around
 * it. A doorbell that rings early claims nothing and the sweep picks the message
 * up within its interval, which is the cheap failure; a claim that ran ahead of
 * the deadline would shorten a backoff that exists precisely because the far
 * side asked us to wait.
 */
export async function claimOutbound(id: string): Promise<OutboundMessage | null> {
  return queryOne<OutboundMessage>(
    `update outbound_messages
        set status = 'sending', attempts = attempts + 1, updated_at = now()
      where id = $1
        and status = 'queued'
        and next_attempt_at <= now()
      returning *`,
    [id],
  );
}

/**
 * Messages whose retry clock has come round, across every tenant.
 *
 * The queue in Redis is a doorbell, not the queue of record. This is what makes
 * that true: anything queued and due is picked up here whether or not its job
 * survived, so a Redis restart delays mail by one sweep instead of losing it.
 * Returns ids and attempt counts, never message content.
 */
export async function dueOutbound(
  limit = 50,
): Promise<{ id: string; attempts: number }[]> {
  return query<{ id: string; attempts: number }>(
    `select id, attempts
       from outbound_messages
      where status = 'queued' and next_attempt_at <= now()
      order by next_attempt_at asc
      limit $1`,
    [limit],
  );
}

/**
 * Return messages claimed by a worker that then died.
 *
 * `sending` is the one status no timer ever revisits: the process that owned it
 * is gone, and the row would sit there until somebody noticed. A reclaim is not
 * a retry of a known failure — we genuinely do not know whether the provider
 * accepted it — so it keeps its attempt count and says so in the history.
 */
export async function reclaimStalledOutbound(
  olderThanMinutes = 5,
): Promise<{ id: string; business_id: string; attempts: number }[]> {
  const rows = await query<{ id: string; business_id: string; attempts: number }>(
    `update outbound_messages
        set status = 'queued', next_attempt_at = now(), updated_at = now()
      where status = 'sending'
        and updated_at < now() - ($1 || ' minutes')::interval
      returning id, business_id, attempts`,
    [String(olderThanMinutes)],
  );
  for (const row of rows) {
    await query(
      `insert into outbound_message_events (outbound_id, kind, detail, actor)
       values ($1, 'reclaimed', $2::jsonb, 'system')`,
      [
        row.id,
        JSON.stringify({
          note: "claimed by a worker that stopped before reporting an outcome",
          attempts: row.attempts,
        }),
      ],
    );
  }
  return rows;
}

export async function markSent(
  ctx: TenantContext,
  id: string,
  outcome: { provider: string; providerMessageId: string | null; response: string | null },
): Promise<void> {
  await query(
    `update outbound_messages
        set status = 'sent', sent_at = now(), updated_at = now(),
            provider = $3, provider_message_id = $4, last_error = null
      where id = $1 and business_id = $2`,
    [id, ctx.businessId, outcome.provider, outcome.providerMessageId],
  );
  await recordOutboundEvent(ctx, id, "sent", {
    provider: outcome.provider,
    provider_message_id: outcome.providerMessageId,
    response: outcome.response,
  });
}

/**
 * A transient failure: back to `queued`, with the clock moved.
 *
 * Deliberately not a separate `deferred` status. A row waiting to be retried is
 * a row waiting to be sent, and one status for that means the sweep has one
 * predicate to get right rather than two. `attempts > 0` is what distinguishes
 * "not tried yet" from "tried and coming back".
 */
export async function deferOutbound(
  ctx: TenantContext,
  id: string,
  failure: { error: string; code: string | null; delayMs: number; provider: string },
): Promise<void> {
  await query(
    `update outbound_messages
        set status = 'queued', updated_at = now(), provider = $5,
            next_attempt_at = now() + ($3 || ' milliseconds')::interval,
            last_error = $4
      where id = $1 and business_id = $2`,
    [id, ctx.businessId, String(Math.round(failure.delayMs)), failure.error, failure.provider],
  );
  await recordOutboundEvent(ctx, id, "deferred", {
    error: failure.error,
    code: failure.code,
    retry_in_ms: Math.round(failure.delayMs),
    provider: failure.provider,
  });
}

/** The dead letter. Nothing retries this; a human decides what happens next. */
export async function failOutbound(
  ctx: TenantContext,
  id: string,
  failure: { error: string; code: string | null; provider: string; permanent: boolean },
): Promise<void> {
  await query(
    `update outbound_messages
        set status = 'failed', failed_at = now(), updated_at = now(),
            provider = $3, last_error = $4
      where id = $1 and business_id = $2`,
    [id, ctx.businessId, failure.provider, failure.error],
  );
  await recordOutboundEvent(ctx, id, "failed", {
    error: failure.error,
    code: failure.code,
    provider: failure.provider,
    reason: failure.permanent ? "refused permanently" : "attempts exhausted",
  });
}

/**
 * Deliberately not sent: no transport configured, or a human said stop.
 *
 * The audit row is written only for a human. A person deciding that a queued
 * reply must not go out is a governance event; the delivery loop parking a
 * message because this deployment has no transport is a configuration fact, and
 * one audit row per message about it would bury the first kind under the
 * second.
 */
export async function cancelOutbound(
  ctx: TenantContext,
  id: string,
  reason: string,
): Promise<boolean> {
  requirePermission(ctx, "action:execute");
  const row = await queryOne<{ id: string; to_email: string }>(
    `update outbound_messages
        set status = 'cancelled', updated_at = now(), last_error = $3
      where id = $1 and business_id = $2 and status in ('queued', 'sending')
      returning id, to_email`,
    [id, ctx.businessId, reason],
  );
  if (!row) return false;
  await recordOutboundEvent(ctx, id, "cancelled", { reason });

  if (ctx.actorType === "human") {
    await audit(ctx, {
      action: "notification.cancel",
      resource_type: "outbound_message",
      resource_id: id,
      new_value: { status: "cancelled", to: row.to_email },
      reason,
    });
  }
  return true;
}

/**
 * A human sends it again.
 *
 * Gives the message a fresh attempt budget rather than resetting the counter:
 * the history of what has already been tried is part of why somebody is looking
 * at this row, and erasing it would make the third manual retry look like the
 * first. A suppressed address is refused here — lifting the suppression is a
 * separate, audited decision, and doing it implicitly is how a complaint turns
 * into a second complaint.
 */
export async function retryOutbound(
  ctx: TenantContext,
  id: string,
): Promise<OutboundMessage | null> {
  requirePermission(ctx, "action:execute");

  const message = await getOutbound(ctx, id);
  if (!message) return null;
  if (await isSuppressed(ctx, message.to_email)) {
    throw new Error(
      `${message.to_email} is on this tenant's suppression list. Remove the suppression first, which is audited.`,
    );
  }

  const row = await queryOne<OutboundMessage>(
    `update outbound_messages
        set status = 'queued', next_attempt_at = now(), updated_at = now(),
            max_attempts = attempts + $3, failed_at = null
      where id = $1 and business_id = $2
        and status in ('failed', 'bounced', 'cancelled')
      returning *`,
    [id, ctx.businessId, env.OUTBOUND_MAX_ATTEMPTS],
  );
  if (!row) return null;

  await recordOutboundEvent(ctx, id, "retried", {
    previous_status: message.status,
    previous_error: message.last_error,
    attempts_so_far: message.attempts,
  });
  await audit(ctx, {
    action: "notification.retry",
    resource_type: "outbound_message",
    resource_id: id,
    old_value: { status: message.status, attempts: message.attempts },
    new_value: { status: "queued", max_attempts: row.max_attempts },
    reason: "manual retry from the console",
  });
  return row;
}

/**
 * The receiving side gave it back.
 *
 * Distinct from `failed`: the provider accepted this message, so the failure is
 * news that arrived later and by a different route. Only a message we actually
 * sent can bounce, which the status predicate enforces — a bounce webhook
 * naming a queued row is either a replay or a forgery, and either way it must
 * not move the row.
 */
export async function markBounced(
  ctx: TenantContext,
  id: string,
  bounce: { kind: "hard" | "soft" | "complaint"; detail: string | null },
): Promise<OutboundMessage | null> {
  const row = await queryOne<OutboundMessage>(
    `update outbound_messages
        set status = 'bounced', bounce_kind = $3, bounce_detail = $4,
            updated_at = now()
      where id = $1 and business_id = $2 and status in ('sent', 'bounced')
      returning *`,
    [id, ctx.businessId, bounce.kind, bounce.detail],
  );
  if (!row) return null;
  await recordOutboundEvent(
    ctx,
    id,
    bounce.kind === "complaint" ? "complained" : "bounced",
    { kind: bounce.kind, detail: bounce.detail },
  );
  return row;
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export async function getOutbound(
  ctx: TenantContext,
  id: string,
): Promise<OutboundMessage | null> {
  requirePermission(ctx, "ticket:read");
  return queryOne<OutboundMessage>(
    `select * from outbound_messages where id = $1 and business_id = $2`,
    [id, ctx.businessId],
  );
}

/**
 * The row a Message-ID belongs to.
 *
 * `message_id` is globally unique, so the tenant predicate is what stops a
 * bounce delivered to one tenant's intake from resolving another tenant's
 * message — a real risk, because the Message-ID in a DSN is quoted back by a
 * stranger's mail server and is not a secret.
 */
export async function findOutboundByMessageId(
  ctx: TenantContext,
  messageId: string,
): Promise<OutboundMessage | null> {
  return queryOne<OutboundMessage>(
    `select * from outbound_messages
      where message_id = $1 and business_id = $2`,
    [messageId.trim().replace(/^</, "").replace(/>$/, ""), ctx.businessId],
  );
}

export async function findOutboundByProviderId(
  ctx: TenantContext,
  providerMessageId: string,
): Promise<OutboundMessage | null> {
  return queryOne<OutboundMessage>(
    `select * from outbound_messages
      where provider_message_id = $1 and business_id = $2`,
    [providerMessageId, ctx.businessId],
  );
}

/** Everything we have tried to send about one ticket, newest first. */
export async function outboundForTicket(
  ctx: TenantContext,
  ticketId: string,
): Promise<OutboundMessage[]> {
  requirePermission(ctx, "ticket:read");
  return query<OutboundMessage>(
    `select m.*
       from outbound_messages m
       join tickets t on t.id = m.ticket_id
      where m.ticket_id = $1 and t.business_id = $2
      order by m.created_at desc`,
    [ticketId, ctx.businessId],
  );
}

export interface OutboundFilters {
  status?: OutboundStatus | OutboundStatus[];
  limit?: number;
}

export async function listOutbound(
  ctx: TenantContext,
  filters: OutboundFilters = {},
): Promise<OutboundMessage[]> {
  requirePermission(ctx, "ticket:read");
  const statuses = filters.status
    ? Array.isArray(filters.status)
      ? filters.status
      : [filters.status]
    : null;
  return query<OutboundMessage>(
    `select * from outbound_messages
      where business_id = $1
        and ($2::text[] is null or status::text = any($2::text[]))
      order by created_at desc
      limit $3`,
    [ctx.businessId, statuses, filters.limit ?? 50],
  );
}

/**
 * The dead-letter queue.
 *
 * A dead-letter queue nobody looks at is decoration, so this one has a page:
 * every message the system gave up on, with the error that stopped it and a
 * button that tries again.
 */
export async function deadLetters(
  ctx: TenantContext,
  limit = 50,
): Promise<(OutboundMessage & { subject_line: string | null })[]> {
  requirePermission(ctx, "ticket:read");
  return query<OutboundMessage & { subject_line: string | null }>(
    `select m.*, t.subject as subject_line
       from outbound_messages m
       left join tickets t on t.id = m.ticket_id
      where m.business_id = $1 and m.status in ('failed', 'bounced')
      order by coalesce(m.failed_at, m.updated_at) desc
      limit $2`,
    [ctx.businessId, limit],
  );
}

/**
 * Whether the requester has just been written to about this ticket.
 *
 * Used by the resolution notice to avoid the most annoying possible pair of
 * emails: a human writes "that should be fixed now, let me know", clicks
 * resolve, and the system immediately follows it with "your ticket has been
 * resolved". They already know — they are reading the sentence that told them.
 *
 * Counts only replies, not notifications, and only ones we still believe in:
 * a message that bounced or was cancelled did not tell anybody anything.
 */
export async function recentReplyExists(
  ctx: TenantContext,
  ticketId: string,
  withinMinutes: number,
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `select m.id
       from outbound_messages m
      where m.ticket_id = $1
        and m.business_id = $2
        and m.kind = 'reply'
        and m.status in ('queued', 'sending', 'sent')
        and m.created_at >= now() - ($3 || ' minutes')::interval
      limit 1`,
    [ticketId, ctx.businessId, String(withinMinutes)],
  );
  return row !== null;
}

/** The delivery history for one message. This is the notification audit trail. */
export async function outboundHistory(
  ctx: TenantContext,
  id: string,
): Promise<OutboundEventRow[]> {
  requirePermission(ctx, "ticket:read");
  return query<OutboundEventRow>(
    `select e.*
       from outbound_message_events e
       join outbound_messages m on m.id = e.outbound_id
      where e.outbound_id = $1 and m.business_id = $2
      order by e.created_at asc, e.id asc`,
    [id, ctx.businessId],
  );
}

/** Counts by status over a window, for the mail page's header. */
export async function deliveryStats(
  ctx: TenantContext,
  hours = 24,
): Promise<Record<OutboundStatus, number>> {
  requirePermission(ctx, "ticket:read");
  const rows = await query<{ status: OutboundStatus; n: number }>(
    `select status, count(*)::int as n
       from outbound_messages
      where business_id = $1 and created_at >= now() - ($2 || ' hours')::interval
      group by status`,
    [ctx.businessId, String(hours)],
  );
  const out: Record<OutboundStatus, number> = {
    queued: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    bounced: 0,
    suppressed: 0,
    cancelled: 0,
  };
  for (const row of rows) out[row.status] = row.n;
  return out;
}

// ---------------------------------------------------------------------------
// suppression
// ---------------------------------------------------------------------------

export async function isSuppressed(
  ctx: TenantContext,
  email: string,
): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    `select id from email_suppressions
      where business_id = $1 and lower(email) = lower($2)`,
    [ctx.businessId, email.trim()],
  );
  return row !== null;
}

/**
 * Stop writing to an address.
 *
 * Per tenant, deliberately. A shared suppression list would mean one customer's
 * departed employee stops receiving another customer's mail, which is both
 * wrong and a disclosure: it tells the second company something about the
 * first.
 */
export async function suppressAddress(
  ctx: TenantContext,
  input: {
    email: string;
    reason: "hard_bounce" | "complaint" | "manual";
    detail?: string | null;
    outbound_id?: string | null;
  },
): Promise<void> {
  requirePermission(ctx, "action:execute");
  const email = input.email.trim().toLowerCase();
  const inserted = await queryOne<{ id: number }>(
    `insert into email_suppressions
       (business_id, email, reason, detail, outbound_id, created_by)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (business_id, lower(email)) do nothing
     returning id`,
    [
      ctx.businessId,
      email,
      input.reason,
      input.detail ?? null,
      input.outbound_id ?? null,
      actorString(ctx),
    ],
  );
  if (!inserted) return;

  await audit(ctx, {
    action: "notification.suppress",
    resource_type: "email_address",
    resource_id: email,
    new_value: { reason: input.reason, detail: input.detail ?? null },
    reason: `no further mail will be sent to ${email}`,
  });
}

/**
 * Write to them again.
 *
 * Audited, and the reason is not optional in practice: the address is on the
 * list because a mail server said the mailbox is gone or a person said they did
 * not want our mail, and overriding either is a decision somebody should be
 * able to be asked about later.
 */
export async function unsuppressAddress(
  ctx: TenantContext,
  email: string,
  reason: string,
): Promise<boolean> {
  requirePermission(ctx, "action:execute");
  const row = await queryOne<Suppression>(
    `delete from email_suppressions
      where business_id = $1 and lower(email) = lower($2)
      returning *`,
    [ctx.businessId, email.trim()],
  );
  if (!row) return false;

  await audit(ctx, {
    action: "notification.unsuppress",
    resource_type: "email_address",
    resource_id: row.email,
    old_value: { reason: row.reason, detail: row.detail, since: row.created_at },
    new_value: { suppressed: false },
    reason,
  });
  return true;
}

export async function listSuppressions(
  ctx: TenantContext,
  limit = 100,
): Promise<Suppression[]> {
  requirePermission(ctx, "ticket:read");
  return query<Suppression>(
    `select * from email_suppressions
      where business_id = $1
      order by created_at desc
      limit $2`,
    [ctx.businessId, limit],
  );
}
