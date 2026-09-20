import { randomUUID } from "node:crypto";
import { query } from "./db.js";
import { systemContext, type TenantContext } from "./auth/context.js";
import { openingKey } from "./conversation-legacy.js";
import { enqueueTriage } from "./queue.js";
import { scrubSecrets } from "./redact.js";
import { getSettings } from "./repos/businesses.js";
import { appendMessage, type AttachmentInput } from "./repos/conversations.js";
import { appendEvent } from "./repos/events.js";
import { primaryAsset, upsertRequester } from "./repos/people.js";
import {
  findTicketByReferences,
  findTicketBySubjectTag,
  recordMessageId,
} from "./repos/threading.js";
import { createTicketFromMessage, setStatus } from "./repos/tickets.js";
import { InboundMessage, type Ticket } from "./types.js";

export interface IntakeResult {
  ticket: Ticket;
  created: boolean;
  /** The message threaded onto an existing ticket instead of opening one. */
  threaded: boolean;
  enqueued: boolean;
}

/**
 * The single door into the system. Email, Slack, the widget and the phone
 * transcript all normalize to InboundMessage and come through here, so
 * deduplication, threading, identity resolution, secret scrubbing and the
 * audit trail happen once rather than once per channel.
 */
export async function intakeMessage(
  ctx: TenantContext,
  raw: unknown,
): Promise<IntakeResult> {
  const msg = InboundMessage.parse(raw);
  const settings = await getSettings(ctx.businessId);

  const requester = await upsertRequester({
    business_id: ctx.businessId,
    email: msg.requester_email,
    full_name: msg.requester_name,
  });

  // --- threading ----------------------------------------------------------
  // A reply belongs on the ticket it answers. Without this, "thanks, that
  // worked" arrives as a new P3, gets triaged, and gets a runbook reply.
  const existing = await findExistingThread(ctx, msg);
  if (existing) {
    return threadOntoTicket(ctx, existing, msg, requester.id);
  }

  const asset = await primaryAsset(ctx, requester.id);

  // --- secret scrubbing ---------------------------------------------------
  // Done before insert: a plaintext password is a liability from the moment
  // the row exists, and nobody downstream needs to read it.
  let body = msg.body;
  let scrubbed = false;
  if (settings.scrub_secrets_at_rest) {
    const result = scrubSecrets(msg.body);
    body = result.text;
    scrubbed = result.redacted;
  }

  const { ticket, created } = await createTicketFromMessage(
    ctx,
    { ...msg, body },
    requester.id,
    asset?.id ?? null,
  );

  // A redelivered webhook must not re-run the pipeline or re-log intake.
  if (!created) return { ticket, created: false, threaded: false, enqueued: false };

  if (scrubbed) {
    await markScrubbed(ctx, ticket.id);
  }
  if (msg.source_message_id) {
    await recordMessageId(ticket.id, msg.source_message_id, "inbound");
  }

  await appendEvent(ctx, {
    ticket_id: ticket.id,
    actor: "user",
    kind: "note",
    payload: {
      stage: "intake",
      source: msg.source,
      source_message_id: msg.source_message_id,
      attachments: msg.attachments.map((a) => a.filename),
      secrets_scrubbed: scrubbed,
      meta: msg.meta,
    },
  });

  // The requester's words open the conversation (docs/conversation.md). The
  // ticket row keeps the body for triage and the list; the conversation keeps
  // it as said, with its attachments. Written by the system on the requester's
  // behalf, as every inbound message is.
  //
  // Not fatal. The ticket exists and has to reach triage, and the ticket row
  // still holds the words: whatever next opens the conversation copies them
  // from there (D4), and the backfill does if nothing does.
  try {
    await appendMessage(systemContext(ctx.businessId, { requestId: ctx.requestId }), ticket.id, {
      visibility: "public",
      channel: msg.source,
      body,
      idempotencyKey: openingKey(ticket.id),
      requesterId: requester.id,
      sourceMessageId: msg.source_message_id,
      occurredAt: msg.received_at,
      metadata: msg.meta,
      attachments: attachmentsOf(msg),
    });
  } catch (err) {
    await appendEvent(ctx, {
      ticket_id: ticket.id,
      actor: "system",
      kind: "error",
      payload: { stage: "conversation", error: String(err) },
    });
  }

  let enqueued = false;
  try {
    await enqueueTriage(ticket.id);
    enqueued = true;
  } catch (err) {
    // The ticket exists and is visible in the dashboard; triage can be retried.
    // Losing the job is recoverable, losing the ticket is not.
    await appendEvent(ctx, {
      ticket_id: ticket.id,
      actor: "system",
      kind: "error",
      payload: { stage: "enqueue", error: String(err) },
    });
  }

  return { ticket, created: true, threaded: false, enqueued };
}

async function findExistingThread(
  ctx: TenantContext,
  msg: InboundMessage,
): Promise<Ticket | null> {
  const meta = msg.meta as { in_reply_to?: unknown; references?: unknown };
  const refs: string[] = [];
  if (typeof meta.in_reply_to === "string") refs.push(meta.in_reply_to);
  if (typeof meta.references === "string") refs.push(...meta.references.split(/\s+/));
  if (Array.isArray(meta.references)) {
    refs.push(...meta.references.filter((r): r is string => typeof r === "string"));
  }

  const byHeader = await findTicketByReferences(ctx.businessId, refs);
  if (byHeader) return byHeader;

  // Fallback for clients that strip threading headers but keep the subject.
  return findTicketBySubjectTag(ctx.businessId, msg.subject);
}

/**
 * A reply on an existing thread is a user event, not a new ticket.
 *
 * It deliberately does not re-enqueue triage. A requester answering a
 * clarifying question, or saying a fix did not work, is exactly the moment a
 * person should look — the reopen path never routes back to the agent.
 */
async function threadOntoTicket(
  ctx: TenantContext,
  ticket: Ticket,
  msg: InboundMessage,
  requesterId: string,
): Promise<IntakeResult> {
  if (msg.source_message_id) {
    await recordMessageId(ticket.id, msg.source_message_id, "inbound");
  }

  // The status change below is the system's response to a requester replying,
  // not a decision by whoever delivered the reply, so it runs with the system's
  // authority inside the same tenant. It used to use the caller's context, and
  // the callers are the least privileged things in the product: the portal
  // form holds `ticket:read` and `ticket:create`, and an API key is whatever
  // role it was issued with. Both threw on the reopen — after the reply had
  // already been appended — so the requester's answer sat on a ticket that
  // stayed resolved.
  const system = systemContext(ctx.businessId, { requestId: ctx.requestId });

  // The reply goes into the conversation, written by the system on the
  // requester's behalf and scrubbed there (C11). It used to be a `reply` event,
  // and its attachments were dropped. Keyed on the channel's own id, so a
  // redelivered webhook is the same message: nothing is written twice and the
  // ticket does not move twice. A channel with no id gets a key of its own.
  const { created } = await appendMessage(system, ticket.id, {
    visibility: "public",
    channel: msg.source,
    body: msg.body,
    idempotencyKey: msg.source_message_id
      ? inboundKey(msg.source, msg.source_message_id)
      : inboundKey(msg.source, randomUUID()),
    requesterId,
    sourceMessageId: msg.source_message_id,
    occurredAt: msg.received_at,
    metadata: msg.meta,
    attachments: attachmentsOf(msg),
  });
  if (!created) return { ticket, created: false, threaded: true, enqueued: false };

  const wasClosed = ["resolved", "closed"].includes(ticket.status);
  if (wasClosed) {
    await setStatus(system, ticket.id, "reopened");
    await appendEvent(ctx, {
      ticket_id: ticket.id,
      actor: "system",
      kind: "status_change",
      payload: {
        status: "reopened",
        reason: "requester replied after the ticket was resolved",
        routes_to: "human",
      },
    });
  } else if (ticket.status === "awaiting_user") {
    await setStatus(system, ticket.id, "triaged");
    // The branch above logged its transition and this one did not, which left
    // the most common resume in the product invisible on the timeline: the
    // ticket moved out of `awaiting_user`, the SLA clock restarted and the
    // deadline shifted, and the only record was a pair of columns. A replay
    // reported such a ticket as still `new`.
    await appendEvent(ctx, {
      ticket_id: ticket.id,
      actor: "system",
      kind: "status_change",
      payload: {
        status: "triaged",
        reason: "requester answered while the ticket was awaiting them",
        routes_to: "human",
      },
    });
  }

  return { ticket, created: false, threaded: true, enqueued: false };
}

/** An inbound message's key: the channel and its own id (C8). */
export const inboundKey = (source: string, sourceMessageId: string): string =>
  `inbound:${source}:${sourceMessageId}`;

function attachmentsOf(msg: InboundMessage): AttachmentInput[] {
  return msg.attachments.map((a) => ({
    filename: a.filename,
    contentType: a.content_type,
    sizeBytes: a.size_bytes,
    storageKey: a.storage_key,
  }));
}

async function markScrubbed(ctx: TenantContext, ticketId: string): Promise<void> {
  await query(
    `update tickets set secrets_scrubbed = true where id = $1 and business_id = $2`,
    [ticketId, ctx.businessId],
  );
}

/**
 * Resolve the tenant a webhook call is acting for, from its bearer token.
 *
 * This is the server-side half of "the caller never names the tenant". The
 * token is matched in SQL and the `business_id` comes back from the row, so
 * there is no code path where a body field or a query parameter can influence
 * which tenant a message lands in.
 *
 * Returns null for an unknown token rather than throwing, so the caller can
 * answer 401 without distinguishing "no such token" from "token for a deleted
 * tenant".
 */
export async function contextForIntakeToken(
  token: string | null | undefined,
): Promise<TenantContext | null> {
  if (!token || token.length < 16) return null;
  const rows = await query<{ id: string }>(
    `select id from businesses where intake_token = $1`,
    [token],
  );
  const businessId = rows[0]?.id;
  return businessId ? systemContext(businessId) : null;
}

/** Same resolution, from the address the mail was delivered to. */
export async function contextForIntakeAddress(
  address: string | null | undefined,
): Promise<TenantContext | null> {
  if (!address) return null;
  const rows = await query<{ id: string }>(
    `select id from businesses where lower(intake_address) = lower($1)`,
    [address.trim()],
  );
  const businessId = rows[0]?.id;
  return businessId ? systemContext(businessId) : null;
}
