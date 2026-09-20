import { createHash, randomUUID } from "node:crypto";
import { subjectTag } from "../repos/threading.js";

/**
 * Turning a reply into a message.
 *
 * Everything here is pure. The rendered message is computed once, at queue
 * time, and stored on the row — so a retry three hours later sends the same
 * words, from the same address, with the same Message-ID, rather than
 * re-rendering against configuration that has since changed. "The requester
 * received a slightly different reply on the second attempt" is not a bug
 * anybody would enjoy diagnosing.
 *
 * The body is never decorated. A signature is already part of the draft a human
 * reviewed — appending anything here would mean the thing that was reviewed and
 * the thing that was sent are two different texts.
 */

export interface OutboundDraft {
  toEmail: string;
  toName: string | null;
  fromEmail: string;
  fromName: string | null;
  replyTo: string | null;
  subject: string;
  body: string;
  /** Without angle brackets; the header gets them back in `toRfc822`. */
  messageId: string;
  inReplyTo: string | null;
  references: string[];
}

/**
 * A Message-ID we mint, so an inbound bounce or reply quoting it resolves back
 * to the row that sent it.
 *
 * The left-hand side is a uuid rather than the ticket id: the ticket id is
 * already in the subject tag, and a Message-ID travels through other people's
 * infrastructure and log files. One per message, unguessable, and unique
 * whatever the clock does.
 */
export function newMessageId(domain: string): string {
  return `${randomUUID()}@${domain.replace(/^@/, "")}`;
}

/**
 * The subject a reply goes out with.
 *
 * `Re:` once, and the `[NG-1a2b3c4d]` tag once. The tag is the fallback
 * threading key for clients that strip `In-Reply-To` and `References`, which is
 * most of the ones that matter, so it has to survive a reply-to-a-reply — and
 * it must not accumulate on every round trip.
 */
export function replySubject(subject: string, ticketId: string): string {
  const tag = subjectTag(ticketId);
  const bare = subject.replace(/\s*\[[A-Z]{2}-[0-9a-f]{8}\]\s*/g, " ").trim();
  const stripped = bare.replace(/^((re|fw|fwd)\s*:\s*)+/i, "").trim();
  const base = stripped || "(no subject)";
  return `Re: ${base} ${tag}`;
}

/**
 * The idempotency key for a reply.
 *
 * The same words on the same ticket are the same message. That is what makes a
 * double-clicked Send button, a re-run pipeline and a redelivered webhook
 * produce one email instead of three, and it is a deliberate trade: a verbatim
 * repeat — the same nudge sent twice, word for word — is treated as a
 * redelivery. A caller that genuinely means to say the same thing twice passes
 * its own key.
 */
export function replyIdempotencyKey(
  kind: string,
  ticketId: string,
  body: string,
): string {
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 32);
  return `${kind}:${ticketId}:${digest}`;
}

export interface RenderReplyInput {
  ticketId: string;
  subject: string;
  body: string;
  toEmail: string;
  toName?: string | null;
  /** The tenant's own address, where its mail arrives. */
  intakeAddress?: string | null;
  fallbackFrom: string;
  fromName: string;
  messageIdDomain: string;
  /** Message-IDs already on this thread, newest last. */
  threadMessageIds?: string[];
}

export function renderReply(input: RenderReplyInput): OutboundDraft {
  // We send from the address we receive on, where the tenant has one. That is
  // not cosmetic: a reply to a `no-reply@` sender is a support request nobody
  // reads, and threading only closes the loop if the answer to our answer
  // arrives back in the same tenant's intake.
  const from = normalizeAddress(input.intakeAddress) ?? normalizeAddress(input.fallbackFrom)!;
  const thread = (input.threadMessageIds ?? [])
    .map(stripAngles)
    .filter(Boolean);
  const inReplyTo = thread.length > 0 ? thread[thread.length - 1]! : null;

  return {
    toEmail: normalizeAddress(input.toEmail)!,
    toName: input.toName?.trim() || null,
    fromEmail: from,
    fromName: input.fromName.trim() || null,
    replyTo: from,
    subject: replySubject(input.subject, input.ticketId),
    body: input.body,
    messageId: newMessageId(input.messageIdDomain),
    inReplyTo,
    // References carries the whole thread, oldest first, and is capped: a long
    // conversation must not grow a header until a receiving server rejects it.
    references: thread.slice(-10),
  };
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim().toLowerCase() || null;
}

function stripAngles(value: string): string {
  return value.trim().replace(/^</, "").replace(/>$/, "");
}

/**
 * RFC 5322 text for one message.
 *
 * Used by the spool transport, and by anything that wants to show exactly what
 * would have gone out. The SMTP and API transports hand the provider the parts
 * and let it compose, because a hand-rolled MIME encoder is a supply of bugs
 * that only ever show up in somebody else's mail client.
 */
export function toRfc822(draft: OutboundDraft, date = new Date()): string {
  const headers: [string, string][] = [
    ["Date", date.toUTCString()],
    ["From", formatAddress(draft.fromEmail, draft.fromName)],
    ["To", formatAddress(draft.toEmail, draft.toName)],
    ["Subject", encodeHeader(draft.subject)],
    ["Message-ID", `<${draft.messageId}>`],
    ["MIME-Version", "1.0"],
    ["Content-Type", 'text/plain; charset="utf-8"'],
    ["Content-Transfer-Encoding", "8bit"],
    // Auto-replies are the classic way two helpdesks talk to each other all
    // night. Saying so in the headers is how the other side's `isAutoReply`
    // check — which is the same check as ours — knows not to answer.
    ["Auto-Submitted", "auto-generated"],
    ["X-Auto-Response-Suppress", "All"],
  ];
  if (draft.replyTo) headers.push(["Reply-To", draft.replyTo]);
  if (draft.inReplyTo) headers.push(["In-Reply-To", `<${draft.inReplyTo}>`]);
  if (draft.references.length > 0) {
    headers.push(["References", draft.references.map((r) => `<${r}>`).join(" ")]);
  }

  const head = headers.map(([k, v]) => `${k}: ${v}`).join("\r\n");
  const body = draft.body.replace(/\r?\n/g, "\r\n");
  return `${head}\r\n\r\n${body}\r\n`;
}

function formatAddress(email: string, name: string | null): string {
  if (!name) return email;
  return `${encodeHeader(name, true)} <${email}>`;
}

/**
 * RFC 2047 for anything that is not plain ASCII.
 *
 * A raw UTF-8 subject is accepted by most servers and mangled by enough of them
 * that "Zurück" arriving as mojibake is a support ticket about the support
 * system.
 */
function encodeHeader(value: string, quoteIfPlain = false): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(clean)) {
    return quoteIfPlain && /[",:;<>@]/.test(clean)
      ? `"${clean.replace(/"/g, '\\"')}"`
      : clean;
  }
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}
