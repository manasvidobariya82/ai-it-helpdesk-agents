import { scrubSecrets } from "./redact.js";
import type {
  AttachmentInput,
  AuthorKind,
  LegacyOrigin,
  MessageChannel,
  MessageVisibility,
} from "./repos/conversations.js";
import type { TicketEvent } from "./types.js";

/**
 * A ticket's history from before the conversation existed, and what it becomes
 * in the conversation (D4 and C13 in docs/conversation.md).
 *
 * Pure: the backfill in `conversations.ts` reads the rows and the ids that
 * exist, and this decides what they mean. Everything here copies what the
 * record says and nothing more. Where the record does not say, such as which
 * model wrote an agent reply or which person a `human:console` actor was, the
 * copy is written as `system` and says it is a copy. It never guesses.
 */

/** The opening message's key. Shared with intake, so a ticket has one whoever writes it. */
export const openingKey = (ticketId: string): string => `opening:${ticketId}`;

/** A copied event's key. The database checks that a copy carries it (0020). */
export const legacyEventKey = (eventId: number | string): string => `legacy:event:${eventId}`;

/** The ticket row, as the backfill reads it. Times are Postgres text, so no precision is lost. */
export interface LegacyTicket {
  id: string;
  source: string;
  source_message_id: string | null;
  requester_id: string | null;
  body: string;
  attachments: unknown;
  secrets_scrubbed: boolean;
  created_at: string;
}

/** A `reply` or `draft` event, as the backfill reads it, in event-log order. */
export interface LegacyEvent {
  id: number;
  actor: string;
  kind: string;
  payload: Record<string, unknown>;
  model: string | null;
  created_at: string;
}

/**
 * The ids in this tenant that the record's references resolve to. A reference
 * that is not in here, whether deleted or belonging to another tenant, is not
 * attributed.
 */
export interface KnownIds {
  requesters: ReadonlySet<string>;
  /** Users with a membership in this tenant. */
  staff: ReadonlySet<string>;
  outbound: ReadonlySet<string>;
}

export interface LegacyMessage {
  idempotencyKey: string;
  kind: "message" | "draft";
  visibility: MessageVisibility;
  author: {
    kind: AuthorKind;
    userId: string | null;
    requesterId: string | null;
  };
  channel: MessageChannel;
  body: string;
  secretsScrubbed: boolean;
  sourceMessageId: string | null;
  /** When the record says it happened, exactly as recorded. */
  occurredAt: string;
  outboundId: string | null;
  /** A draft's model, from the event's own `model` column. Nothing else is recorded. */
  aiModel: string | null;
  aiSources: unknown[] | null;
  attachments: AttachmentInput[];
  legacy: LegacyOrigin;
}

export type LegacySkipReason =
  /** No words to copy. */
  | "no_body"
  /** A merge's copy of another ticket's event. It is copied on the ticket it came from. */
  | "merged_copy"
  /** A second record of a send that produced no second email. */
  | "same_delivery";

export interface LegacySkip {
  event_id: number;
  reason: LegacySkipReason;
}

export interface LegacyPlan {
  /** In conversation order: the opening message, then the events in log order. */
  messages: LegacyMessage[];
  skipped: LegacySkip[];
  /**
   * Set when the record is missing something that cannot be guessed, such as
   * the channel of an inbound message. Nothing is written for the ticket and a
   * person decides.
   */
  problem: string | null;
}

const CHANNELS: readonly MessageChannel[] = [
  "email",
  "slack",
  "widget",
  "phone",
  "api",
  "portal",
  "console",
  "internal",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HUMAN_RE = /^human:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const uuidOrNull = (v: unknown): string | null =>
  typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null;

const isChannel = (v: unknown): v is MessageChannel =>
  typeof v === "string" && (CHANNELS as readonly string[]).includes(v);

const isInbound = (e: LegacyEvent): boolean => e.payload.inbound === true;

/**
 * The ids the record refers to, so the caller can ask which of them exist in
 * the tenant. Only well-formed uuids: anything else cannot resolve.
 */
export function legacyReferences(
  ticket: LegacyTicket,
  events: readonly LegacyEvent[],
): { requesters: string[]; users: string[]; outbound: string[] } {
  const requesters = new Set<string>();
  const users = new Set<string>();
  const outbound = new Set<string>();

  const requester = uuidOrNull(ticket.requester_id);
  if (requester) requesters.add(requester);
  for (const e of events) {
    const r = uuidOrNull(e.payload.requester_id);
    if (r) requesters.add(r);
    const human = HUMAN_RE.exec(e.actor);
    if (human) users.add(human[1]!.toLowerCase());
    const o = uuidOrNull(e.payload.outbound_id);
    if (o) outbound.add(o);
  }
  return {
    requesters: [...requesters],
    users: [...users],
    outbound: [...outbound],
  };
}

/**
 * Who wrote a desk-side record: a person, if the actor names one who is a
 * member of this tenant; the agent, only on a draft whose event recorded the
 * model; otherwise `system`.
 */
function deskAuthor(e: LegacyEvent, known: KnownIds, aiAllowed: boolean): LegacyMessage["author"] {
  const human = HUMAN_RE.exec(e.actor);
  const userId = human?.[1]?.toLowerCase();
  if (userId && known.staff.has(userId)) {
    return { kind: "staff", userId, requesterId: null };
  }
  if (aiAllowed && e.actor === "agent" && e.model) {
    return { kind: "ai", userId: null, requesterId: null };
  }
  return { kind: "system", userId: null, requesterId: null };
}

function requesterAuthor(id: unknown, known: KnownIds): LegacyMessage["author"] {
  const requesterId = uuidOrNull(id);
  return requesterId && known.requesters.has(requesterId)
    ? { kind: "requester", userId: null, requesterId }
    : { kind: "system", userId: null, requesterId: null };
}

function ticketAttachments(raw: unknown): AttachmentInput[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (a): a is Record<string, unknown> =>
        !!a && typeof a === "object" && typeof (a as { filename?: unknown }).filename === "string",
    )
    .map((a) => ({
      filename: a.filename as string,
      contentType: typeof a.content_type === "string" ? a.content_type : null,
      sizeBytes: typeof a.size_bytes === "number" ? a.size_bytes : null,
      storageKey: typeof a.storage_key === "string" ? a.storage_key : null,
    }));
}

/**
 * What a ticket's legacy record becomes in its conversation.
 *
 * - The ticket row is the opening message: the requester's words, public.
 * - A `reply` event with `inbound: true` is the requester's reply, public.
 * - Any other `reply` event is the desk's reply, public, sent by email.
 * - A `draft` event is an internal draft.
 * - Nothing else is copied. Notes, status changes, tool calls and the rest are
 *   the audit log, and stay there.
 *
 * A requester's words are scrubbed again (C11), which changes nothing that was
 * already scrubbed.
 */
export function planLegacyThread(
  ticket: LegacyTicket,
  events: readonly LegacyEvent[],
  known: KnownIds,
): LegacyPlan {
  const messages: LegacyMessage[] = [];
  const skipped: LegacySkip[] = [];

  const openingChannel = ticket.source;
  if (!isChannel(openingChannel)) {
    return {
      messages,
      skipped,
      problem: `the ticket's source '${ticket.source}' is not a channel`,
    };
  }
  const opening = scrubSecrets(ticket.body);
  const openingAuthor = requesterAuthor(ticket.requester_id, known);
  messages.push({
    idempotencyKey: openingKey(ticket.id),
    kind: "message",
    visibility: "public",
    author: openingAuthor,
    channel: openingChannel,
    body: opening.text,
    secretsScrubbed: ticket.secrets_scrubbed || opening.redacted,
    // Only a requester's message has a channel id of its own (0019).
    sourceMessageId: openingAuthor.kind === "requester" ? ticket.source_message_id : null,
    occurredAt: ticket.created_at,
    outboundId: null,
    aiModel: null,
    aiSources: null,
    attachments: ticketAttachments(ticket.attachments),
    legacy: { from: "ticket", event_id: null, actor: null, inbound: true },
  });

  const delivered = new Set<string>();
  for (const e of events) {
    if (e.kind !== "reply" && e.kind !== "draft") continue;
    if ("merged_from" in e.payload) {
      skipped.push({ event_id: e.id, reason: "merged_copy" });
      continue;
    }
    const body = e.payload.body;
    if (typeof body !== "string") {
      skipped.push({ event_id: e.id, reason: "no_body" });
      continue;
    }

    const base = {
      idempotencyKey: legacyEventKey(e.id),
      occurredAt: e.created_at,
      sourceMessageId: null,
      outboundId: null,
      aiModel: null,
      aiSources: null,
      attachments: [],
    };

    if (e.kind === "draft") {
      const author = deskAuthor(e, known, true);
      const sources = e.payload.sources;
      messages.push({
        ...base,
        kind: "draft",
        visibility: "internal",
        author,
        channel: "internal",
        body,
        secretsScrubbed: false,
        aiModel: author.kind === "ai" ? e.model : null,
        aiSources: author.kind === "ai" && Array.isArray(sources) ? sources : null,
        legacy: {
          from: "draft",
          event_id: e.id,
          actor: e.actor,
          inbound: false,
        },
      });
      continue;
    }

    if (isInbound(e)) {
      const channel = e.payload.source;
      if (!isChannel(channel)) {
        return {
          messages: [],
          skipped: [],
          problem: `reply event ${e.id} does not record a channel it arrived by`,
        };
      }
      const author = requesterAuthor(e.payload.requester_id, known);
      const scrub = scrubSecrets(body);
      const sourceMessageId = e.payload.source_message_id;
      messages.push({
        ...base,
        kind: "message",
        visibility: "public",
        author,
        channel,
        body: scrub.text,
        secretsScrubbed: e.payload.secrets_scrubbed === true || scrub.redacted,
        sourceMessageId:
          author.kind === "requester" && typeof sourceMessageId === "string"
            ? sourceMessageId
            : null,
        legacy: {
          from: "reply",
          event_id: e.id,
          actor: e.actor,
          inbound: true,
        },
      });
      continue;
    }

    // The desk's reply. A retried send writes a second event for the same
    // outbound row and no second email, so it is one message.
    const outbound = uuidOrNull(e.payload.outbound_id);
    if (outbound) {
      if (delivered.has(outbound)) {
        skipped.push({ event_id: e.id, reason: "same_delivery" });
        continue;
      }
      delivered.add(outbound);
    }
    messages.push({
      ...base,
      kind: "message",
      visibility: "public",
      author: deskAuthor(e, known, false),
      // `ticket.send_reply` only ever sent email.
      channel: "email",
      body,
      secretsScrubbed: false,
      outboundId: outbound && known.outbound.has(outbound) ? outbound : null,
      legacy: { from: "reply", event_id: e.id, actor: e.actor, inbound: false },
    });
  }

  return { messages, skipped, problem: null };
}

/** One entry of the thread as the event log shows it. */
export interface LegacyThreadEntry {
  event_id: number;
  from: "requester" | "desk";
  body: string;
  at: Date;
}

/**
 * The thread as it was read before the conversation: every `reply` event with
 * words, the requester's being the `inbound` ones.
 *
 * This is what the portal shows until it reads the conversation, kept here so
 * that the parity test compares the conversation with exactly what people see.
 */
export function legacyThread(
  events: readonly Pick<TicketEvent, "id" | "kind" | "payload" | "created_at">[],
): LegacyThreadEntry[] {
  return events
    .filter((e) => e.kind === "reply" && typeof e.payload.body === "string")
    .map((e) => ({
      event_id: e.id,
      from: e.payload.inbound === true ? "requester" : "desk",
      body: e.payload.body as string,
      at: new Date(e.created_at),
    }));
}
