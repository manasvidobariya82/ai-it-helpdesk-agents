/**
 * Reading a bounce.
 *
 * Two formats arrive, and both are somebody else's machine talking about our
 * message: a delivery status notification (RFC 3464), which is a mail server
 * saying it could not deliver; and an abuse report (RFC 5965), which is a
 * mailbox provider saying a person pressed "this is spam". They mean different
 * things and both end the conversation with that address.
 *
 * The parsing is pure text, on purpose. It runs on the raw message, takes no
 * dependency on the mail library the intake path happens to use, and is
 * therefore testable against a file — which matters, because every real bounce
 * this system will ever see is a file somebody forwarded from an inbox.
 *
 * The important distinction is permanence. A 5.x.x status is the far side
 * saying stop; a 4.x.x status, or `Action: delayed`, is the far side saying it
 * is still trying. Treating a delay notice as a failure would close a ticket's
 * reply as undeliverable while the mail was still in flight, which is worse
 * than not reading it at all.
 */

export interface ParsedBounce {
  kind: "hard" | "soft" | "complaint";
  /** The address that failed, lowercased, or null if the report omits it. */
  recipient: string | null;
  /** RFC 3463 status, e.g. `5.1.1`. Null on reports that carry no status. */
  status: string | null;
  /** What the receiving server actually said, where it said anything. */
  diagnostic: string | null;
  /** The Message-ID of ours this is about, without angle brackets. */
  originalMessageId: string | null;
  /** `failed` | `delayed` | `delivered` | `relayed` | `expanded`, if present. */
  action: string | null;
}

export interface BounceEnvelope {
  /** Who the message is from, where the caller knows. */
  from?: string | null;
  subject?: string | null;
}

/**
 * A bounce or complaint, or null if this is ordinary mail.
 *
 * Null is the common case and has to be cheap: every inbound message goes
 * through here before it becomes a ticket.
 *
 * Note what it takes to be believed. A real report declares itself in a
 * `Content-Type` — `multipart/report`, `message/delivery-status`,
 * `message/feedback-report` — and that is enough on its own. Bare DSN fields in
 * a body are not, because a requester can type `Final-Recipient: rfc822;
 * someone@example.com` into a support request, and a parser that accepted it
 * would let anyone suppress anyone else's address by describing a bounce. Those
 * need the envelope to corroborate: a mailer-daemon sender, or one of the
 * subjects mail servers actually use.
 */
export function parseDeliveryStatus(
  raw: string,
  envelope: BounceEnvelope = {},
): ParsedBounce | null {
  const text = unfold(raw);

  const isComplaint = /content-type:\s*message\/feedback-report/i.test(text);
  const declared =
    isComplaint ||
    /content-type:\s*(multipart\/report|message\/delivery-status)/i.test(text);
  const hasDsnFields = /^final-recipient:/im.test(text);

  if (!declared && !(hasDsnFields && looksLikeMailerReport(envelope))) return null;

  const status = field(text, "Status");
  const action = field(text, "Action")?.toLowerCase() ?? null;
  const diagnostic = field(text, "Diagnostic-Code");

  return {
    kind: isComplaint ? "complaint" : classifyDsn(status, action),
    recipient: recipientOf(text, isComplaint),
    status: status ?? null,
    diagnostic: diagnostic ?? null,
    originalMessageId: originalMessageId(text),
    action,
  };
}

/**
 * Whether the envelope is one a mail server would have put on a report.
 *
 * Used only to corroborate DSN fields found in a body with no declared report
 * content type. It is a heuristic and is treated as one: it can never turn an
 * ordinary message into a bounce on its own, and its job is to stop a
 * requester's prose from being read as a delivery failure.
 */
export function looksLikeMailerReport(envelope: BounceEnvelope): boolean {
  const from = (envelope.from ?? "").trim().toLowerCase();
  const subject = (envelope.subject ?? "").trim().toLowerCase();

  if (from === "" || from === "<>") return true;
  if (/^(mailer-daemon|postmaster|mailer|no-?reply|bounce[s]?)[@+]/.test(from)) return true;
  if (/^"?mail delivery (system|subsystem)"?/.test(from)) return true;

  return /^(undeliverable|delivery status notification|returned mail|mail delivery failed|delivery failure|undelivered mail returned to sender|abuse report)/.test(
    subject,
  );
}

/**
 * Permanent unless something says otherwise.
 *
 * The order matters: a report can carry `Action: failed` alongside a 4.x.x
 * status, which happens when a server gives up after its own retries. The
 * status is the more specific statement, so it wins — but `delayed` with no
 * status at all is still a delay.
 */
function classifyDsn(status: string | null, action: string | null): "hard" | "soft" {
  if (status?.startsWith("4")) return "soft";
  if (status?.startsWith("5")) return "hard";
  if (action === "delayed") return "soft";
  return "hard";
}

function recipientOf(text: string, isComplaint: boolean): string | null {
  const candidates = isComplaint
    ? ["Original-Rcpt-To", "Original-Recipient", "Final-Recipient"]
    : ["Final-Recipient", "Original-Recipient", "Original-Rcpt-To"];

  for (const name of candidates) {
    const value = field(text, name);
    if (!value) continue;
    // `rfc822; user@example.com` — the address type prefix is optional in
    // practice and present in most real reports.
    const address = value.includes(";") ? value.split(";").slice(1).join(";") : value;
    const cleaned = address.trim().replace(/^</, "").replace(/>$/, "").toLowerCase();
    if (cleaned.includes("@")) return cleaned;
  }
  return null;
}

/**
 * Which of our messages this is about.
 *
 * Preference order is deliberate. `Original-Message-ID` is the report telling
 * us directly. Failing that, a DSN attaches the original message, so the first
 * `Message-ID` after the attachment boundary is ours — note that the DSN's
 * *own* Message-ID appears earlier in the file, which is why this looks for the
 * attached part rather than the first match. `In-Reply-To` and `References` are
 * the last resort, used by reports that attach nothing.
 */
function originalMessageId(text: string): string | null {
  const direct = field(text, "Original-Message-ID");
  if (direct) return stripAngles(direct);

  const attachment = text.search(/content-type:\s*(message\/rfc822|text\/rfc822-headers)/i);
  if (attachment !== -1) {
    const embedded = field(text.slice(attachment), "Message-ID");
    if (embedded) return stripAngles(embedded);
  }

  const inReplyTo = field(text, "In-Reply-To");
  if (inReplyTo) return stripAngles(inReplyTo);

  const references = field(text, "References");
  if (references) {
    const ids = references.split(/\s+/).filter(Boolean);
    const last = ids[ids.length - 1];
    if (last) return stripAngles(last);
  }
  return null;
}

/** First occurrence of a header or DSN field, case-insensitive. */
function field(text: string, name: string): string | null {
  const escaped = name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
  const match = text.match(new RegExp(`^${escaped}:[ \\t]*(.*)$`, "im"));
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/**
 * Header folding, undone.
 *
 * A `Diagnostic-Code` long enough to matter is always folded, and a field
 * parser that reads only the first physical line reports half a reason.
 */
function unfold(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ");
}

function stripAngles(value: string): string {
  return value.trim().replace(/^</, "").replace(/>$/, "").trim();
}
