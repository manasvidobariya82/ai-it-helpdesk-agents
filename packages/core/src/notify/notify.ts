import {
  actorString,
  systemContext,
  type TenantContext,
} from "../auth/context.js";
import { env } from "../env.js";
import { unsubscribeUrl } from "../links.js";
import { enqueueOutbound } from "../queue.js";
import { currentBusiness, getSettings } from "../repos/businesses.js";
import { appendEvent } from "../repos/events.js";
import { ALL_KINDS, isOptedOut } from "../repos/notifications.js";
import { queueOutbound } from "../repos/outbound.js";
import { threadMessageIds } from "../repos/threading.js";
import { newMessageId, renderReply, replySubject } from "../mail/render.js";
import type { NotificationKind } from "../types.js";
import {
  NOTIFICATIONS,
  renderNotification,
  type NotificationPayload,
} from "./catalogue.js";

/**
 * Sending a notification.
 *
 * Everything hard about notifications is here, and none of it is delivery —
 * that was 0012. What this function owns is the four questions between "an
 * event happened" and "a message is queued": does this tenant send this kind,
 * does this person still want it, has it already been sent, and is there
 * anybody to send it to. Three of those four answers are "no, and say so
 * quietly", which is why the result type has a `skipped` reason rather than a
 * boolean.
 *
 * ## Why this runs as the system
 *
 * `queueOutbound` requires `action:execute`, and the people who cause
 * notifications frequently do not have it — a manager can assign a ticket and
 * cannot execute tools. That is correct: assigning is not executing. But the
 * assignment email is a consequence of an authorized action, not a second
 * privileged action by that person, so the message is queued under a system
 * context inside the same tenant and the event log records who caused it.
 *
 * The safety of that rests on this function's shape rather than on a permission
 * check: the text comes from a closed union of templates in `catalogue.ts`, and
 * every caller resolves its recipients from a tenant-scoped directory lookup.
 * There is no path here that sends arbitrary words to an arbitrary address, and
 * there must not be one — that is what `ticket.send_reply` is, and it is gated.
 */

export type NotifySkip =
  | "tenant_disabled"
  | "kind_disabled"
  | "opted_out"
  | "duplicate"
  | "suppressed";

export interface NotifyTarget {
  email: string;
  name?: string | null;
}

export interface NotifyResult {
  kind: NotificationKind;
  to: string;
  sent: boolean;
  skipped: NotifySkip | null;
  outboundId: string | null;
}

export interface NotifyInput {
  payload: NotificationPayload;
  to: NotifyTarget;
  /** The ticket this is about, for the timeline and the dedupe key. */
  ticketId: string | null;
  /**
   * Overrides the default "once per hour per person per ticket" key.
   *
   * The default is right for most kinds: it collapses a double-clicked button
   * and a retried job, and still lets a genuine second assignment tomorrow
   * produce a second email. The exceptions pass their own — an SLA warning is
   * once per clock per ticket for ever, and an approval notice is once per
   * request.
   */
  dedupeKey?: string;
}

export async function notify(
  ctx: TenantContext,
  input: NotifyInput,
): Promise<NotifyResult> {
  const kind = input.payload.kind;
  const spec = NOTIFICATIONS[kind];
  const to = input.to.email.trim().toLowerCase();
  const result = (
    sent: boolean,
    skipped: NotifySkip | null,
    outboundId: string | null = null,
  ): NotifyResult => ({ kind, to, sent, skipped, outboundId });

  const settings = await getSettings(ctx.businessId);
  if (!settings.notifications.enabled) return result(false, "tenant_disabled");
  if (settings.notifications[spec.setting] === false) {
    return result(false, "kind_disabled");
  }
  if (await isOptedOut(ctx, to, kind)) return result(false, "opted_out");

  const rendered = renderNotification(input.payload);
  const business = await currentBusiness(ctx);
  const from = business.intake_address ?? env.OUTBOUND_FROM_ADDRESS;

  // A notification is queued by the system, for the reasons in the comment at
  // the top of this file. The actor who caused it is recorded on the ticket.
  const sender = systemContext(ctx.businessId, {
    requestId: ctx.requestId ?? `notify:${kind}`,
  });

  const draft =
    spec.audience === "requester" && input.ticketId
      ? // Threaded onto the conversation the requester is already having, so
        // the notice arrives where everything else about this ticket is.
        renderReply({
          ticketId: input.ticketId,
          subject: rendered.subject,
          body: rendered.body,
          toEmail: to,
          toName: input.to.name ?? null,
          intakeAddress: business.intake_address,
          fallbackFrom: env.OUTBOUND_FROM_ADDRESS,
          fromName: env.OUTBOUND_FROM_NAME,
          messageIdDomain: env.OUTBOUND_MESSAGE_ID_DOMAIN,
          threadMessageIds: await threadMessageIds(ctx, input.ticketId),
        })
      : {
          toEmail: to,
          toName: input.to.name ?? null,
          fromEmail: from,
          fromName: env.OUTBOUND_FROM_NAME,
          // Staff mail replies to the intake address on purpose: the subject
          // carries the ticket tag, so a reply threads onto the ticket instead
          // of landing in a mailbox nobody reads.
          replyTo: from,
          subject: rendered.subject,
          body: withFooter(ctx, rendered.body, kind, to),
          messageId: newMessageId(env.OUTBOUND_MESSAGE_ID_DOMAIN),
          inReplyTo: null,
          references: [] as string[],
        };

  const { message, queued, suppressed } = await queueOutbound(sender, {
    ticket_id: input.ticketId,
    kind: `notify:${kind}`,
    to_email: draft.toEmail,
    to_name: draft.toName,
    from_email: draft.fromEmail,
    from_name: draft.fromName,
    reply_to: draft.replyTo,
    subject: draft.subject,
    body: draft.body,
    message_id: draft.messageId,
    in_reply_to: draft.inReplyTo,
    references: draft.references,
    idempotency_key: input.dedupeKey ?? defaultKey(kind, input.ticketId, to),
  });

  if (suppressed) return result(false, "suppressed", message.id);
  if (!queued) return result(false, "duplicate", message.id);

  // The row is the queue of record; the job only makes it prompt.
  await enqueueOutbound(message.id).catch(() => {});

  if (input.ticketId) {
    await appendEvent(ctx, {
      ticket_id: input.ticketId,
      actor: actorString(ctx),
      kind: "note",
      payload: {
        stage: "notification",
        notification: kind,
        to,
        outbound_id: message.id,
      },
    });
  }

  return result(true, null, message.id);
}

/**
 * Several recipients, one at a time.
 *
 * Sequential rather than parallel: each call writes a row and an event, and a
 * queue of forty concurrent inserts to save eight milliseconds is a trade
 * nobody asked for. The results are returned in full so the caller can say on
 * the ticket that nobody was told.
 */
export async function notifyAll(
  ctx: TenantContext,
  input: Omit<NotifyInput, "to"> & { to: NotifyTarget[] },
): Promise<NotifyResult[]> {
  const out: NotifyResult[] = [];
  for (const target of input.to) {
    out.push(await notify(ctx, { ...input, to: target }));
  }
  return out;
}

/**
 * One per person, per ticket, per hour.
 *
 * The hour is the interesting part. Without a time component the key would
 * collapse a genuine second assignment next week into the first one and send
 * nothing; with a finer one, a double-clicked button sends twice. An hour is
 * long enough to cover a retry storm and short enough that a real repeat gets
 * through.
 */
function defaultKey(
  kind: NotificationKind,
  ticketId: string | null,
  to: string,
): string {
  const hour = new Date().toISOString().slice(0, 13);
  return `${kind}:${ticketId ?? "none"}:${to}:${hour}`;
}

/**
 * The footer, on staff mail only.
 *
 * Two links, because "stop these" and "stop everything" are different
 * intentions and a single link forces the second one on somebody who meant the
 * first. Neither needs a login: the token is signed and names the tenant, the
 * address and the kind, which is the only way this works for people who do not
 * have a console account.
 *
 * Requester notifications get no footer. A resolution notice is a reply on
 * their own ticket, the escape hatch is "reply to this email", and offering
 * somebody an unsubscribe link for messages about their own support request
 * would be an invitation to stop hearing from us mid-problem.
 */
function withFooter(
  ctx: TenantContext,
  body: string,
  kind: NotificationKind,
  to: string,
): string {
  const one = unsubscribeUrl({ businessId: ctx.businessId, email: to, kind });
  const all = unsubscribeUrl({
    businessId: ctx.businessId,
    email: to,
    kind: ALL_KINDS,
  });
  return [
    body,
    "",
    "—",
    `Stop ${NOTIFICATIONS[kind].label} emails: ${one}`,
    `Stop all notifications: ${all}`,
  ].join("\n");
}

/** The subject a requester-facing notice would arrive with, for tests and previews. */
export function notificationSubjectFor(
  payload: NotificationPayload,
  ticketId: string,
): string {
  const rendered = renderNotification(payload);
  return NOTIFICATIONS[payload.kind].audience === "requester"
    ? replySubject(rendered.subject, ticketId)
    : rendered.subject;
}
