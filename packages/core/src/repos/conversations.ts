import { randomUUID } from "node:crypto";
import type pg from "pg";
import { query, tx } from "../db.js";
import {
  AuthorizationError,
  NotFoundError,
  actorString,
  can,
  requirePermission,
  systemContext,
  type TenantContext,
} from "../auth/context.js";
import {
  legacyReferences,
  planLegacyThread,
  type LegacyEvent,
  type LegacySkip,
  type LegacyTicket,
} from "../conversation-legacy.js";
import { scrubSecrets } from "../redact.js";
import { isUuid } from "./tickets.js";

/**
 * The ticket conversation. `docs/conversation.md` is the specification, and
 * the invariants it names (C1 to C13) are cited where the code enforces them.
 *
 * This file is the only writer of `conversations`, `conversation_messages` and
 * `conversation_attachments`. Most of the rules are also enforced by the
 * database (0019, 0020), so a caller that bypassed this file would still be
 * refused. This file adds the rules the database cannot see, which are the
 * ones about who is asking.
 *
 * It writes in two ways: `appendMessage`, for anything said from now on, and
 * `backfillConversation`, which copies a ticket's history from before the
 * conversation existed (D4, C13). Both go through `writeMessage`, so a copy
 * gets the same audit event and the same checks as any other message.
 */

export type MessageKind = "message" | "draft" | "event";
export type MessageVisibility = "public" | "internal";
export type AuthorKind = "requester" | "staff" | "ai" | "system";
export type MessageChannel =
  | "email"
  | "slack"
  | "widget"
  | "phone"
  | "api"
  | "portal"
  | "console"
  | "internal";

export interface Conversation {
  id: string;
  business_id: string;
  ticket_id: string;
  kind: "primary";
  status: "open" | "locked";
  locked_reason: string | null;
  last_seq: number;
  last_message_at: Date | null;
  created_at: Date;
}

export interface ConversationAttachment {
  id: string;
  business_id: string;
  message_id: string;
  /** The order it was attached in, from 0. */
  position: number;
  filename: string;
  content_type: string | null;
  size_bytes: number | null;
  storage_key: string | null;
  sha256: string | null;
  created_at: Date;
}

/**
 * Where a copied message came from (C13). Null on every message written
 * through `appendMessage`, which has no way to set it.
 */
export interface LegacyOrigin {
  /** The ticket row (the opening message), or a `reply` or `draft` event. */
  from: "ticket" | "reply" | "draft";
  event_id: number | null;
  /** The actor the event recorded, verbatim. Null for the ticket row. */
  actor: string | null;
  /** The requester's words. Decides the side a `system` copy is shown on. */
  inbound: boolean;
}

export interface ConversationMessage {
  id: string;
  business_id: string;
  conversation_id: string;
  seq: number;
  kind: MessageKind;
  visibility: MessageVisibility;
  author_kind: AuthorKind;
  author_user_id: string | null;
  author_requester_id: string | null;
  channel: MessageChannel;
  content_type: string;
  body: string;
  secrets_scrubbed: boolean;
  idempotency_key: string;
  source_message_id: string | null;
  occurred_at: Date | null;
  derived_from_id: string | null;
  outbound_id: string | null;
  event_id: number;
  about_event_id: number | null;
  ai_model: string | null;
  ai_prompt_version: string | null;
  ai_config_version: number | null;
  ai_sources: unknown[] | null;
  metadata: Record<string, unknown>;
  legacy: LegacyOrigin | null;
  created_at: Date;
  attachments: ConversationAttachment[];
}

export interface AttachmentInput {
  filename: string;
  contentType?: string | null;
  sizeBytes?: number | null;
  storageKey?: string | null;
  sha256?: string | null;
}

export interface AppendMessageInput {
  /** Defaults to `message`. */
  kind?: MessageKind;
  visibility: MessageVisibility;
  channel: MessageChannel;
  body: string;
  contentType?: string;
  /**
   * The caller's name for this message (C8). A retry with the same key returns
   * the message the first call wrote. Required, so every writer has to decide
   * what makes two calls the same message.
   */
  idempotencyKey: string;
  /**
   * Write on behalf of this requester. Only a context that is neither a person
   * at the desk nor the agent may do so: intake, and the portal (C4).
   */
  requesterId?: string;
  /** The channel's own id for an inbound message, such as an email Message-ID. */
  sourceMessageId?: string | null;
  /** When the channel says it happened. Never decides the order (C2). */
  occurredAt?: Date | null;
  /** The message this one was made from, such as the draft being sent (C6). */
  derivedFromId?: string | null;
  /** The delivery row for a public message that went out. */
  outboundId?: string | null;
  /** For `kind: "event"`: the audit event this message shows. */
  aboutEventId?: number | null;
  /** Required when the agent writes, refused otherwise (C6). */
  ai?: {
    model: string;
    promptVersion?: string | null;
    configVersion?: number | null;
    /** What the words were grounded on: retrieved chunks, documents. */
    sources?: unknown[] | null;
    /**
     * What the model call cost. Written on the audit event's own columns, as
     * every other model call's is, so a ticket's cost still adds up from its
     * timeline.
     */
    usage?: {
      tokensIn?: number | null;
      tokensOut?: number | null;
      costUsd?: number | null;
      latencyMs?: number | null;
    };
  };
  metadata?: Record<string, unknown>;
  attachments?: AttachmentInput[];
}

export interface AppendMessageResult {
  message: ConversationMessage;
  /** False when the key had already been used: nothing new was written. */
  created: boolean;
}

/** A conversation that takes no more messages (C10). */
export class ConversationLockedError extends Error {
  readonly status = 409;
  constructor(readonly reason: string) {
    super(`this conversation is locked (${reason}) and takes no more messages`);
    this.name = "ConversationLockedError";
  }
}

/** An idempotency key reused for a different message (C8). */
export class IdempotencyConflictError extends Error {
  readonly status = 409;
  constructor(readonly key: string) {
    super(`idempotency key ${key} already names a different message`);
    this.name = "IdempotencyConflictError";
  }
}

interface Author {
  kind: AuthorKind;
  userId: string | null;
  requesterId: string | null;
}

/**
 * Who is writing, from the context alone (C4).
 *
 * The same rule `outbound_messages.created_by` follows: an author that a
 * caller could name would be an author a caller could forge. A person at the
 * desk is who their session says. The agent is the agent. A requester is
 * named only by intake or the portal, which is what receives their words.
 */
function authorFor(ctx: TenantContext, input: AppendMessageInput): Author {
  switch (ctx.actorType) {
    case "human":
      if (input.requesterId) {
        throw new AuthorizationError(null, "a person at the desk cannot write as a requester");
      }
      if (input.ai) {
        throw new AuthorizationError(null, "a person's message carries no model provenance");
      }
      if (!ctx.actorId) throw new AuthorizationError(null, "a person must be identified to write");
      return { kind: "staff", userId: ctx.actorId, requesterId: null };

    case "agent":
      if (input.requesterId) {
        throw new AuthorizationError(null, "the agent cannot write as a requester");
      }
      if (!input.ai?.model) {
        throw new AuthorizationError(null, "the agent's message must name the model that wrote it");
      }
      return { kind: "ai", userId: null, requesterId: null };

    default:
      if (input.ai) {
        throw new AuthorizationError(null, "only the agent's messages carry model provenance");
      }
      return input.requesterId
        ? { kind: "requester", userId: null, requesterId: input.requesterId }
        : { kind: "system", userId: null, requesterId: null };
  }
}

/**
 * Append a message to a ticket's conversation, opening the conversation if
 * this is its first.
 *
 * One transaction does all of it: the conversation's row lock, the next `seq`,
 * the audit event, the message and its attachments (C2, C7, C9). If any part
 * fails, none of it happened.
 */
export async function appendMessage(
  ctx: TenantContext,
  ticketId: string,
  input: AppendMessageInput,
): Promise<AppendMessageResult> {
  const author = authorFor(ctx, input);
  // A requester adds to their own ticket, which is what the portal and intake
  // are allowed to do. Anybody else writing is working the ticket.
  requirePermission(ctx, author.kind === "requester" ? "ticket:create" : "ticket:update");
  // Writing what you could not read back would be a way to leave notes the
  // writer is not meant to see the rest of (C5).
  if (input.visibility === "internal") requirePermission(ctx, "ticket_internal:read");
  if (!isUuid(ticketId)) throw new NotFoundError("ticket");

  const kind = input.kind ?? "message";
  // A requester's words are scrubbed before the row exists (C11). Intake
  // already does this for the ticket body, and a reply is no less likely to
  // carry the password somebody was asked not to send.
  const scrub = author.kind === "requester" ? scrubSecrets(input.body) : null;
  const body = scrub?.text ?? input.body;

  try {
    return await tx(async (client) => {
      const conversation = await lockPrimary(client, ctx, ticketId);

      // Under the lock, so two retries of one message see each other.
      const existing = await messageByKey(client, ctx, input.idempotencyKey);
      if (existing) {
        if (
          existing.conversation_id !== conversation.id ||
          existing.body !== body ||
          existing.kind !== kind ||
          existing.visibility !== input.visibility ||
          existing.author_kind !== author.kind ||
          existing.author_user_id !== author.userId ||
          existing.author_requester_id !== author.requesterId
        ) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        return { message: await withAttachments(client, existing), created: false };
      }

      if (conversation.status === "locked") {
        throw new ConversationLockedError(conversation.locked_reason ?? "locked");
      }

      // A conversation opens with its ticket's history (D4). A ticket from
      // before the conversation existed has it in `ticket_events`, and the
      // backfill refuses to copy it once anything later is in the
      // conversation (C2). So the first write copies it, before itself, and
      // no order of deploy, backfill and traffic can strand a ticket's
      // history. For a ticket that has none, this finds nothing. When the
      // write is the opening message itself, the ticket row is not copied as
      // one.
      if (conversation.last_seq === 0) {
        const history = await copyLegacy(
          client,
          systemContext(ctx.businessId, { requestId: ctx.requestId }),
          ticketId,
          conversation,
          { dryRun: false, except: input.idempotencyKey },
        );
        // Refused means the record is missing something that cannot be
        // guessed. What is being said now is still written, and the timeline
        // says why the history is not in the conversation, where the backfill
        // will report it too.
        if (history.refused) {
          await client.query(
            `insert into ticket_events (ticket_id, actor, kind, payload)
             values ($1, 'system', 'note', $2::jsonb)`,
            [
              ticketId,
              JSON.stringify({ stage: "conversation_history", refused: history.refused }),
            ],
          );
        }
      }

      if (input.aboutEventId != null) {
        const about = await client.query(
          `select 1 from ticket_events where id = $1 and ticket_id = $2`,
          [input.aboutEventId, ticketId],
        );
        if (about.rowCount === 0) throw new NotFoundError("ticket_event");
      }

      const { rows: seqRows } = await client.query<{ last_seq: number }>(
        `update conversations
            set last_seq = last_seq + 1, last_message_at = now()
          where id = $1 and business_id = $2
          returning last_seq`,
        [conversation.id, ctx.businessId],
      );
      const seq = seqRows[0]!.last_seq;

      const message = await writeMessage(client, ctx, ticketId, conversation.id, seq, {
        actor: author.kind === "requester" ? "user" : actorString(ctx),
        kind,
        visibility: input.visibility,
        author,
        channel: input.channel,
        contentType: input.contentType ?? "text/plain",
        body,
        secretsScrubbed: scrub?.redacted ?? false,
        idempotencyKey: input.idempotencyKey,
        sourceMessageId: input.sourceMessageId ?? null,
        occurredAt: input.occurredAt ?? null,
        derivedFromId: input.derivedFromId ?? null,
        outboundId: input.outboundId ?? null,
        aboutEventId: input.aboutEventId ?? null,
        ai: input.ai
          ? {
              model: input.ai.model,
              promptVersion: input.ai.promptVersion ?? null,
              configVersion: input.ai.configVersion ?? null,
              sources: input.ai.sources ?? null,
              usage: input.ai.usage ?? null,
            }
          : null,
        metadata: input.metadata ?? {},
        attachments: input.attachments ?? [],
        legacy: null,
      });

      return { message, created: true };
    });
  } catch (err) {
    // Two first writes of one key to two different conversations: each took
    // its own lock, so the unique index is what met them (C8).
    if (isUniqueViolation(err, "conversation_messages_idempotency")) {
      throw new IdempotencyConflictError(input.idempotencyKey);
    }
    throw err;
  }
}

interface MessageRow {
  /** The `ticket_events` actor of the write. */
  actor: string;
  kind: MessageKind;
  visibility: MessageVisibility;
  author: Author;
  channel: MessageChannel;
  contentType: string;
  body: string;
  secretsScrubbed: boolean;
  idempotencyKey: string;
  sourceMessageId: string | null;
  /** A Date, or Postgres text when the time is copied from another row. */
  occurredAt: Date | string | null;
  derivedFromId: string | null;
  outboundId: string | null;
  aboutEventId: number | null;
  ai: {
    model: string;
    promptVersion: string | null;
    configVersion: number | null;
    sources: unknown[] | null;
    usage?: NonNullable<AppendMessageInput["ai"]>["usage"] | null;
  } | null;
  metadata: Record<string, unknown>;
  attachments: AttachmentInput[];
  legacy: LegacyOrigin | null;
}

/**
 * Write one message at `seq`: its audit event, the row and its attachments.
 *
 * The caller holds the conversation's lock and has chosen the seq, in the
 * transaction `client` belongs to (C2). Every message goes through here, so C7
 * and C9 have one implementation.
 */
async function writeMessage(
  client: pg.PoolClient,
  ctx: TenantContext,
  ticketId: string,
  conversationId: string,
  seq: number,
  row: MessageRow,
): Promise<ConversationMessage> {
  const id = randomUUID();

  // The audit record of the append (C7). It points at the message and
  // carries no body: the words live in one place, and the timeline says
  // that they were written, by whom, and where. A copy also says what it was
  // copied from.
  const usage = row.ai?.usage ?? null;
  const { rows: eventRows } = await client.query<{ id: number }>(
    `insert into ticket_events
       (ticket_id, actor, kind, payload, model, tokens_in, tokens_out, cost_usd, latency_ms)
     values ($1, $2, 'message', $3::jsonb, $4, $5, $6, $7, $8)
     returning id`,
    [
      ticketId,
      row.actor,
      JSON.stringify({
        stage: "conversation",
        message_id: id,
        conversation_id: conversationId,
        seq,
        kind: row.kind,
        visibility: row.visibility,
        author_kind: row.author.kind,
        channel: row.channel,
        attachments: row.attachments.length,
        derived_from_id: row.derivedFromId,
        outbound_id: row.outboundId,
        ...(row.legacy
          ? { legacy: { from: row.legacy.from, event_id: row.legacy.event_id } }
          : {}),
      }),
      usage ? row.ai!.model : null,
      usage?.tokensIn ?? null,
      usage?.tokensOut ?? null,
      usage?.costUsd ?? null,
      usage?.latencyMs ?? null,
    ],
  );

  const { rows } = await client.query<Omit<ConversationMessage, "attachments">>(
    `insert into conversation_messages
       (id, business_id, conversation_id, seq, kind, visibility,
        author_kind, author_user_id, author_requester_id, channel,
        content_type, body, secrets_scrubbed, idempotency_key,
        source_message_id, occurred_at, derived_from_id, outbound_id,
        event_id, about_event_id, ai_model, ai_prompt_version,
        ai_config_version, ai_sources, metadata, legacy)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16::timestamptz, $17, $18, $19, $20, $21, $22, $23, $24::jsonb,
             $25::jsonb, $26::jsonb)
     returning *`,
    [
      id,
      ctx.businessId,
      conversationId,
      seq,
      row.kind,
      row.visibility,
      row.author.kind,
      row.author.userId,
      row.author.requesterId,
      row.channel,
      row.contentType,
      row.body,
      row.secretsScrubbed,
      row.idempotencyKey,
      row.sourceMessageId,
      row.occurredAt,
      row.derivedFromId,
      row.outboundId,
      eventRows[0]!.id,
      row.aboutEventId,
      row.ai?.model ?? null,
      row.ai?.promptVersion ?? null,
      row.ai?.configVersion ?? null,
      row.ai?.sources ? JSON.stringify(row.ai.sources) : null,
      JSON.stringify(row.metadata),
      row.legacy ? JSON.stringify(row.legacy) : null,
    ],
  );

  // Part of the message: same transaction, same tenant (C9).
  const stored: ConversationAttachment[] = [];
  for (const [position, a] of row.attachments.entries()) {
    const { rows: att } = await client.query<ConversationAttachment>(
      `insert into conversation_attachments
         (business_id, message_id, position, filename, content_type, size_bytes,
          storage_key, sha256)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning *`,
      [
        ctx.businessId,
        id,
        position,
        a.filename,
        a.contentType ?? null,
        a.sizeBytes ?? null,
        a.storageKey ?? null,
        a.sha256 ?? null,
      ],
    );
    stored.push(att[0]!);
  }

  return { ...rows[0]!, attachments: stored };
}

/**
 * The ticket's primary conversation, created if it has none, and locked until
 * the caller's transaction ends.
 *
 * A merged ticket gets no new conversation. Merging locks the one it has
 * (`lockConversation`), and one merged before conversations existed has none,
 * so the insert is skipped and the append is refused (C10).
 */
async function lockPrimary(
  client: pg.PoolClient,
  ctx: TenantContext,
  ticketId: string,
): Promise<Conversation> {
  const { rowCount } = await client.query(
    `select 1 from tickets where id = $1 and business_id = $2`,
    [ticketId, ctx.businessId],
  );
  if (rowCount === 0) throw new NotFoundError("ticket");

  await client.query(
    `insert into conversations (business_id, ticket_id)
     select t.business_id, t.id
       from tickets t
      where t.id = $1 and t.business_id = $2 and t.merged_into_id is null
     on conflict (ticket_id) where kind = 'primary' do nothing`,
    [ticketId, ctx.businessId],
  );
  const { rows } = await client.query<Conversation>(
    `select * from conversations
      where ticket_id = $1 and business_id = $2 and kind = 'primary'
      for update`,
    [ticketId, ctx.businessId],
  );
  if (!rows[0]) throw new ConversationLockedError("merged");
  return rows[0];
}

async function messageByKey(
  client: pg.PoolClient,
  ctx: TenantContext,
  key: string,
): Promise<Omit<ConversationMessage, "attachments"> | null> {
  const { rows } = await client.query<Omit<ConversationMessage, "attachments">>(
    `select * from conversation_messages where business_id = $1 and idempotency_key = $2`,
    [ctx.businessId, key],
  );
  return rows[0] ?? null;
}

async function withAttachments(
  client: pg.PoolClient,
  message: Omit<ConversationMessage, "attachments">,
): Promise<ConversationMessage> {
  const { rows } = await client.query<ConversationAttachment>(
    `select * from conversation_attachments
      where message_id = $1 and business_id = $2
      order by position`,
    [message.id, message.business_id],
  );
  return { ...message, attachments: rows };
}

/**
 * Lock a ticket's conversation, inside the caller's transaction (C10).
 *
 * An upsert rather than an update, so a ticket with no conversation yet gets a
 * locked one. That also closes the race with a first append: whichever of the
 * two inserts first, the other waits on the unique index, and the append then
 * finds the conversation locked or the lock finds the append committed.
 */
export async function lockConversation(
  client: pg.PoolClient,
  ctx: TenantContext,
  ticketId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `insert into conversations (business_id, ticket_id, status, locked_reason)
     select t.business_id, t.id, 'locked', $3
       from tickets t
      where t.id = $1 and t.business_id = $2
     on conflict (ticket_id) where kind = 'primary'
     do update set status = 'locked', locked_reason = excluded.locked_reason`,
    [ticketId, ctx.businessId, reason],
  );
}

/** The ticket's primary conversation, or null before its first message. */
export async function conversationFor(
  ctx: TenantContext,
  ticketId: string,
): Promise<Conversation | null> {
  requirePermission(ctx, "ticket:read");
  if (!isUuid(ticketId)) return null;
  const rows = await query<Conversation>(
    `select * from conversations
      where ticket_id = $1 and business_id = $2 and kind = 'primary'`,
    [ticketId, ctx.businessId],
  );
  return rows[0] ?? null;
}

/**
 * A ticket's conversation in order, with attachments.
 *
 * What comes back depends on who asks, and the caller cannot widen it (C5): a
 * context without `ticket_internal:read`, which is the portal, gets the public
 * messages only. A ticket in another tenant reads as an empty conversation,
 * the same as a ticket that does not exist.
 */
export async function messagesFor(
  ctx: TenantContext,
  ticketId: string,
): Promise<ConversationMessage[]> {
  requirePermission(ctx, "ticket:read");
  if (!isUuid(ticketId)) return [];
  const internal = can(ctx, "ticket_internal:read");

  const messages = await query<Omit<ConversationMessage, "attachments">>(
    `select m.*
       from conversation_messages m
       join conversations c on c.id = m.conversation_id and c.business_id = m.business_id
      where c.ticket_id = $1 and c.business_id = $2 and c.kind = 'primary'
        and ($3::boolean or m.visibility = 'public')
      order by m.seq`,
    [ticketId, ctx.businessId, internal],
  );
  if (messages.length === 0) return [];

  const attachments = await query<ConversationAttachment>(
    `select * from conversation_attachments
      where message_id = any($1::uuid[]) and business_id = $2
      order by position`,
    [messages.map((m) => m.id), ctx.businessId],
  );
  const byMessage = new Map<string, ConversationAttachment[]>();
  for (const a of attachments) {
    byMessage.set(a.message_id, [...(byMessage.get(a.message_id) ?? []), a]);
  }
  return messages.map((m) => ({ ...m, attachments: byMessage.get(m.id) ?? [] }));
}

/** One entry of a thread, as every reader shows it. */
export interface ThreadEntry extends ConversationMessage {
  /** Whose side the words are from, including a copy whose author is `system`. */
  from: "requester" | "desk";
  /**
   * When it was said. For a copy, the time its legacy record gives. For any
   * other message, when it was written here, not what a channel claimed.
   */
  at: Date;
}

export function threadEntry(m: ConversationMessage): ThreadEntry {
  return {
    ...m,
    from: m.author_kind === "requester" || m.legacy?.inbound === true ? "requester" : "desk",
    at: new Date(m.legacy && m.occurred_at ? m.occurred_at : m.created_at),
  };
}

/**
 * The thread, for anybody who shows one: the console, the portal, a summary.
 *
 * The one reader. It reads the conversation and nothing else, and a copied
 * message is on the same footing as any other, so no consumer has to know
 * whether a ticket is older than the conversation. Visibility is
 * `messagesFor`'s (C5): the portal gets the public messages only.
 */
export async function threadFor(ctx: TenantContext, ticketId: string): Promise<ThreadEntry[]> {
  return (await messagesFor(ctx, ticketId)).map(threadEntry);
}

export interface BackfillResult {
  ticketId: string;
  /** Copies written, or that would be written in a dry run. */
  written: number;
  /** Copies the conversation already had. */
  present: number;
  /** Legacy records not copied, and why. */
  skipped: LegacySkip[];
  /** Why nothing was written, when the ticket was refused. */
  refused: string | null;
  dryRun: boolean;
}

/** Thrown inside the transaction so that a refused ticket is left as it was. */
class BackfillRefused extends Error {
  constructor(readonly result: BackfillResult) {
    super(result.refused ?? "refused");
  }
}

interface CopyResult {
  written: number;
  present: number;
  skipped: LegacySkip[];
  refused: string | null;
}

/**
 * Copy into a conversation what its ticket's legacy record holds and the
 * conversation does not (D4, C13), in the record's order.
 *
 * The caller holds the conversation's lock, or passes null in a dry run
 * before one exists, and `ctx` is the system's: a copy is written as the
 * people the record names, which no other context may do. `except` is a key
 * the caller is about to write itself, which is the opening message when
 * intake opens a new ticket's conversation.
 *
 * Nothing is written when the answer is `refused`: a record missing something
 * that cannot be guessed, a key another conversation already holds, or a copy
 * that would land after something later than itself (C2).
 */
async function copyLegacy(
  client: pg.PoolClient,
  ctx: TenantContext,
  ticketId: string,
  conversation: Conversation | null,
  opts: { dryRun: boolean; except?: string },
): Promise<CopyResult> {
  const done = (
    written: number,
    present: number,
    skipped: LegacySkip[],
    refused: string | null = null,
  ): CopyResult => ({ written, present, skipped, refused });

  // Times as text: a Date would drop the microseconds, and a copy's time is
  // exactly what its record says or it is not the record's.
  const { rows: tickets } = await client.query<LegacyTicket>(
    `select id, source, source_message_id, requester_id, body, attachments,
            secrets_scrubbed, created_at::text as created_at
       from tickets where id = $1 and business_id = $2`,
    [ticketId, ctx.businessId],
  );
  const ticket = tickets[0];
  if (!ticket) throw new NotFoundError("ticket");

  const { rows: events } = await client.query<LegacyEvent>(
    `select id, actor, kind, payload, model, created_at::text as created_at
       from ticket_events
      where ticket_id = $1 and kind in ('reply', 'draft')
      order by created_at, id`,
    [ticketId],
  );

  // Every reference resolves inside this tenant or not at all (C3).
  const refs = legacyReferences(ticket, events);
  const existingIds = async (sql: string, ids: string[]) =>
    ids.length === 0
      ? new Set<string>()
      : new Set(
          (await client.query<{ id: string }>(sql, [ctx.businessId, ids])).rows.map((r) => r.id),
        );
  const plan = planLegacyThread(ticket, events, {
    requesters: await existingIds(
      `select id from requesters where business_id = $1 and id = any($2::uuid[])`,
      refs.requesters,
    ),
    staff: await existingIds(
      `select user_id as id from memberships
        where business_id = $1 and user_id = any($2::uuid[])`,
      refs.users,
    ),
    outbound: await existingIds(
      `select id from outbound_messages where business_id = $1 and id = any($2::uuid[])`,
      refs.outbound,
    ),
  });
  if (plan.problem) return done(0, 0, plan.skipped, plan.problem);
  const wanted = plan.messages.filter((m) => m.idempotencyKey !== opts.except);

  // Under the lock, so a concurrent run sees what this one wrote.
  const { rows: existing } = await client.query<{
    idempotency_key: string;
    conversation_id: string;
  }>(
    `select idempotency_key, conversation_id from conversation_messages
      where business_id = $1 and idempotency_key = any($2::text[])`,
    [ctx.businessId, wanted.map((m) => m.idempotencyKey)],
  );
  if (existing.some((m) => m.conversation_id !== conversation?.id)) {
    return done(0, 0, plan.skipped, "a legacy record's key is already used by another conversation");
  }
  const have = new Set(existing.map((m) => m.idempotency_key));
  const missing = wanted.filter((m) => !have.has(m.idempotencyKey));
  if (missing.length === 0 || !conversation) return done(missing.length, have.size, plan.skipped);

  // Nothing may land after something later than itself (C2). A copy's time
  // is its record's, and any other message's is when it was written here.
  const { rows: order } = await client.query<{ ok: boolean | null }>(
    `select (select max(case when legacy is null then created_at else occurred_at end)
               from conversation_messages where conversation_id = $1)
            <= (select min(t) from unnest($2::timestamptz[]) t) as ok`,
    [conversation.id, missing.map((m) => m.occurredAt)],
  );
  if (order[0]?.ok === false) {
    return done(
      0,
      have.size,
      plan.skipped,
      "the conversation already holds messages later than a legacy record not yet in it",
    );
  }
  if (opts.dryRun) return done(missing.length, have.size, plan.skipped);

  let seq = conversation.last_seq;
  for (const m of missing) {
    seq += 1;
    await writeMessage(client, ctx, ticketId, conversation.id, seq, {
      // The system wrote the copy, now. Who said the words is the author.
      actor: actorString(ctx),
      kind: m.kind,
      visibility: m.visibility,
      author: m.author,
      channel: m.channel,
      contentType: "text/plain",
      body: m.body,
      secretsScrubbed: m.secretsScrubbed,
      idempotencyKey: m.idempotencyKey,
      sourceMessageId: m.sourceMessageId,
      occurredAt: m.occurredAt,
      derivedFromId: null,
      outboundId: m.outboundId,
      aboutEventId: null,
      ai: m.aiModel
        ? { model: m.aiModel, promptVersion: null, configVersion: null, sources: m.aiSources }
        : null,
      metadata: {},
      attachments: m.attachments,
      legacy: m.legacy,
    });
  }
  await client.query(
    `update conversations set last_seq = $2, last_message_at = now() where id = $1`,
    [conversation.id, seq],
  );
  conversation.last_seq = seq;
  return done(missing.length, have.size, plan.skipped);
}

/**
 * Copy a ticket's history from before the conversation into it (D4, C13).
 *
 * `planLegacyThread` decides what the record means, and `copyLegacy` writes
 * what is not there yet, in the record's order, under the conversation's
 * lock. So it can run any number of times, concurrently, and a run writes only
 * what earlier runs did not: the key of every copy comes from its record (C8).
 * The first write to a conversation copies the same way (`appendMessage`), so
 * this is what reaches the tickets nobody writes to again.
 *
 * It refuses the ticket rather than write out of order. If the conversation
 * already holds something later than a record not yet copied, appending the
 * copy would put it after words that came after it (C2), so nothing is
 * written and the result says why. The same goes for a record missing
 * something that cannot be guessed. A ticket is never partly copied.
 *
 * A merged ticket's conversation is locked (C10), and this still writes to
 * it: it records what was said before the lock, and adds nothing new. Only the
 * system may run it, because it writes as the people the record names.
 */
export async function backfillConversation(
  ctx: TenantContext,
  ticketId: string,
  opts: { dryRun?: boolean } = {},
): Promise<BackfillResult> {
  if (ctx.actorType !== "system") {
    throw new AuthorizationError(null, "only the system copies a ticket's history");
  }
  // These also keep the portal out: its context is `system` too, without them.
  requirePermission(ctx, "ticket:update");
  requirePermission(ctx, "ticket_internal:read");
  if (!isUuid(ticketId)) throw new NotFoundError("ticket");

  const dryRun = opts.dryRun ?? false;
  try {
    return await tx(async (client) => {
      const { rows: tickets } = await client.query<{ merged_into_id: string | null }>(
        `select merged_into_id from tickets where id = $1 and business_id = $2`,
        [ticketId, ctx.businessId],
      );
      if (!tickets[0]) throw new NotFoundError("ticket");

      // The conversation, locked from here to the commit. A merged ticket's is
      // opened locked, as `lockConversation` would have.
      if (!dryRun) {
        const merged = tickets[0].merged_into_id !== null;
        await client.query(
          `insert into conversations (business_id, ticket_id, status, locked_reason)
           values ($1, $2, $3, $4)
           on conflict (ticket_id) where kind = 'primary' do nothing`,
          [ctx.businessId, ticketId, merged ? "locked" : "open", merged ? "merged" : null],
        );
      }
      const { rows: conversations } = await client.query<Conversation>(
        `select * from conversations
          where ticket_id = $1 and business_id = $2 and kind = 'primary'
          ${dryRun ? "" : "for update"}`,
        [ticketId, ctx.businessId],
      );

      const copied = await copyLegacy(client, ctx, ticketId, conversations[0] ?? null, {
        dryRun,
      });
      const result: BackfillResult = { ticketId, ...copied, dryRun };
      // Rolled back, so a refused ticket does not keep a conversation this
      // run gave it.
      if (copied.refused) throw new BackfillRefused(result);
      return result;
    });
  } catch (err) {
    if (err instanceof BackfillRefused) return err.result;
    throw err;
  }
}

export interface ConversationState {
  messages: number;
  public: number;
  internal: number;
  lastSeq: number;
  lastPublicAt: Date | null;
  lastPublicAuthor: AuthorKind | null;
  /**
   * Whose turn it is on the public thread. The desk owes an answer after the
   * requester wrote, and the requester after the desk did. Null before anybody
   * has written publicly. Notes, drafts and events do not take a turn.
   */
  awaiting: "desk" | "requester" | null;
}

/**
 * What a conversation's state is, derived from its messages (C12).
 *
 * Derived rather than stored, so there is nothing to keep in step: the
 * messages are append-only, and this is a fold over them. Pure, so it is
 * checked without a database. A copy counts by the side and the time its
 * record gives (C13), as `threadEntry` shows it.
 */
export function conversationState(
  messages: readonly (Pick<
    ConversationMessage,
    "seq" | "kind" | "visibility" | "author_kind" | "created_at"
  > &
    Partial<Pick<ConversationMessage, "legacy" | "occurred_at">>)[],
): ConversationState {
  const ordered = [...messages].sort((a, b) => a.seq - b.seq);
  const spoken = ordered.filter((m) => m.kind === "message" && m.visibility === "public");
  const last = spoken.at(-1) ?? null;
  const fromRequester = last?.author_kind === "requester" || last?.legacy?.inbound === true;
  return {
    messages: ordered.length,
    public: ordered.filter((m) => m.visibility === "public").length,
    internal: ordered.filter((m) => m.visibility === "internal").length,
    lastSeq: ordered.at(-1)?.seq ?? 0,
    lastPublicAt: last
      ? new Date(last.legacy && last.occurred_at ? last.occurred_at : last.created_at)
      : null,
    lastPublicAuthor: last?.author_kind ?? null,
    awaiting: !last ? null : fromRequester ? "desk" : "requester",
  };
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === "23505" && e.constraint === constraint;
}
