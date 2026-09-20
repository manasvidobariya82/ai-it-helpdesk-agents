import fs from "node:fs/promises";
import path from "node:path";
import type { Mail, NodemailerError, SMTPPoolOptions, SMTPPoolSentMessageInfo } from "nodemailer";
import { env } from "../env.js";
import { toRfc822, type OutboundDraft } from "./render.js";

/**
 * The transports, and the one distinction that matters.
 *
 * Every failure a mail transport can produce is either worth trying again or
 * not, and nothing else about it changes what this system does. A 421 from a
 * greylisting server and a 550 for a mailbox that no longer exists look almost
 * identical in a log line and are opposite instructions: retry the first,
 * suppress the second and tell a human. So the two error classes below are the
 * interface, and each provider's job is to map its own vocabulary onto them.
 *
 * Getting that mapping wrong in the safe direction means a few wasted retries.
 * Getting it wrong in the other direction means giving up on mail that would
 * have gone through, which is why anything unrecognised is transient.
 */

export interface DeliveryOutcome {
  /** The provider's id for the accepted message, where it gives one. */
  providerMessageId: string | null;
  /** Whatever it said, for the delivery history. */
  response: string | null;
}

/** Worth trying again. The attempt counter and the backoff decide when. */
export class TransientDeliveryError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "TransientDeliveryError";
  }
}

/**
 * Not worth trying again.
 *
 * `suppress` is set when the failure is a statement about the address rather
 * than about this message — a mailbox that does not exist, or a recipient the
 * provider has already decided not to deliver to. Those go on the suppression
 * list, because spending five retries per message rediscovering a dead mailbox
 * is how a sender's reputation gets ruined.
 */
export class PermanentDeliveryError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
    readonly suppress: "hard_bounce" | "complaint" | null = null,
  ) {
    super(message);
    this.name = "PermanentDeliveryError";
  }
}

export interface MailTransport {
  readonly name: string;
  send(draft: OutboundDraft): Promise<DeliveryOutcome>;
}

/**
 * The configured transport, or null for "this deployment does not send".
 *
 * Null is a real answer rather than an error: a deployment can legitimately
 * decide that nothing leaves, and the delivery loop records that decision on
 * the message instead of retrying its way to a dead letter.
 */
export function transportFor(
  provider: typeof env.OUTBOUND_EMAIL_PROVIDER = env.OUTBOUND_EMAIL_PROVIDER,
): MailTransport | null {
  switch (provider) {
    case "none":
      return null;
    case "spool":
      return spoolTransport();
    case "smtp":
      return smtpTransport();
    case "postmark":
      return postmarkTransport();
  }
}

// ---------------------------------------------------------------------------
// spool — the development transport
// ---------------------------------------------------------------------------

/**
 * Writes the real message to a folder and reports success.
 *
 * This is not a mock. It renders the same headers, runs through the same queue,
 * claim, retry and status machinery, and produces a file you can open in a mail
 * client. The only thing it does not do is hand the message to a stranger's
 * server, which is exactly the property a developer's machine should have.
 *
 * The status on the row says `spool`, so nothing downstream can mistake a
 * spooled message for a delivered one.
 */
export function spoolTransport(dir = env.OUTBOUND_SPOOL_DIR): MailTransport {
  return {
    name: "spool",
    async send(draft) {
      const target = path.resolve(dir);
      try {
        await fs.mkdir(target, { recursive: true });
        const file = `${new Date().toISOString().replace(/[:.]/g, "-")}-${draft.messageId.split("@")[0]}.eml`;
        await fs.writeFile(path.join(target, file), toRfc822(draft), "utf8");
        return { providerMessageId: `spool:${file}`, response: `written to ${target}` };
      } catch (err) {
        // A full or unwritable disk is a local problem that may clear, and the
        // message is already safely in the database either way.
        throw new TransientDeliveryError(
          `spool write failed: ${err instanceof Error ? err.message : String(err)}`,
          "ESPOOL",
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// smtp
// ---------------------------------------------------------------------------

/**
 * SMTP through nodemailer.
 *
 * The transport object is built once and reused: a connection pool is the
 * difference between a worker that can drain a backlog and one that opens a TCP
 * connection and a TLS handshake per message.
 */
let smtpRef: MailTransport | null = null;

export function smtpTransport(): MailTransport {
  if (smtpRef) return smtpRef;

  smtpRef = {
    name: "smtp",
    async send(draft) {
      const transporter = await smtpPool();
      try {
        const info = await transporter.sendMail({
          from: draft.fromName
            ? { name: draft.fromName, address: draft.fromEmail }
            : draft.fromEmail,
          to: draft.toName
            ? { name: draft.toName, address: draft.toEmail }
            : draft.toEmail,
          replyTo: draft.replyTo ?? undefined,
          subject: draft.subject,
          text: draft.body,
          messageId: `<${draft.messageId}>`,
          inReplyTo: draft.inReplyTo ? `<${draft.inReplyTo}>` : undefined,
          references: draft.references.map((r) => `<${r}>`),
          headers: {
            "Auto-Submitted": "auto-generated",
            "X-Auto-Response-Suppress": "All",
          },
        });
        // An accepted envelope with a rejected recipient is a failure, and
        // nodemailer reports it as a success with an empty `accepted`.
        if (info.rejected && info.rejected.length > 0) {
          throw new PermanentDeliveryError(
            `recipient rejected: ${info.rejected.join(", ")}`,
            "EENVELOPE",
            "hard_bounce",
          );
        }
        return {
          providerMessageId: info.messageId ?? null,
          response: info.response ?? null,
        };
      } catch (err) {
        if (
          err instanceof PermanentDeliveryError ||
          err instanceof TransientDeliveryError
        ) {
          throw err;
        }
        throw classifySmtpError(err);
      }
    },
  };
  return smtpRef;
}

let poolRef: Mail<SMTPPoolSentMessageInfo> | null = null;

/**
 * Imported lazily, so a deployment on another transport never loads the
 * library at all.
 */
async function smtpPool(): Promise<Mail<SMTPPoolSentMessageInfo>> {
  if (poolRef) return poolRef;
  const { createTransport } = await import("nodemailer");
  const options: SMTPPoolOptions & { pool: true } = env.SMTP_URL
    ? { url: env.SMTP_URL, pool: true, maxConnections: 3 }
    : {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        // Refuse to fall back to plaintext on a port that advertised STARTTLS.
        // Credentials on the wire are worse than an undelivered ticket reply.
        requireTLS: !env.SMTP_SECURE,
        auth:
          env.SMTP_USER && env.SMTP_PASSWORD
            ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
            : undefined,
        pool: true,
        maxConnections: 3,
      };
  poolRef = createTransport(options);
  return poolRef;
}

/**
 * SMTP reply codes, mapped.
 *
 * 5xx is the sending side being told to stop; 4xx is being told to come back.
 * The three 55x codes below are statements about the mailbox, so they also
 * suppress the address — everything else 5xx is permanent for this message
 * only, because a message refused for its size or its content says nothing
 * about whether the person still works there.
 */
export function classifySmtpError(
  err: unknown,
): TransientDeliveryError | PermanentDeliveryError {
  const e = (err ?? {}) as NodemailerError;
  const message = e.message ?? String(err);
  const code = e.code ?? null;
  const status = typeof e.responseCode === "number" ? e.responseCode : null;

  if (code === "EAUTH") {
    // Credentials are wrong. Retrying four more times will not fix them, and a
    // dead letter with "535 authentication failed" on it is a clearer page for
    // whoever is on call than a queue that drains slowly for two hours.
    return new PermanentDeliveryError(`SMTP auth rejected: ${message}`, code);
  }

  if (status !== null && status >= 500) {
    const suppress = [550, 551, 553].includes(status) ? "hard_bounce" : null;
    return new PermanentDeliveryError(message, String(status), suppress);
  }
  if (status !== null && status >= 400) {
    return new TransientDeliveryError(message, String(status));
  }

  // Connection-level failures, timeouts, and anything unrecognised. Transient
  // by default: the safe direction to be wrong in is the one that tries again.
  return new TransientDeliveryError(message, code);
}

// ---------------------------------------------------------------------------
// postmark
// ---------------------------------------------------------------------------

/**
 * Postmark's transactional API, over `fetch`.
 *
 * Chosen as the HTTP provider because the inbound webhook already speaks
 * Postmark's payload shape, so a deployment can point both directions at one
 * account. No SDK: it is one POST, and an SDK here would be a dependency whose
 * only job is to build a JSON body.
 */
export function postmarkTransport(): MailTransport {
  return {
    name: "postmark",
    async send(draft) {
      const token = env.POSTMARK_SERVER_TOKEN;
      if (!token) {
        throw new PermanentDeliveryError(
          "POSTMARK_SERVER_TOKEN is not set, so the postmark transport cannot send.",
          "ECONFIG",
        );
      }

      const headers: { Name: string; Value: string }[] = [
        { Name: "Auto-Submitted", Value: "auto-generated" },
        { Name: "X-Auto-Response-Suppress", Value: "All" },
        { Name: "Message-ID", Value: `<${draft.messageId}>` },
      ];
      if (draft.inReplyTo) {
        headers.push({ Name: "In-Reply-To", Value: `<${draft.inReplyTo}>` });
      }
      if (draft.references.length > 0) {
        headers.push({
          Name: "References",
          Value: draft.references.map((r) => `<${r}>`).join(" "),
        });
      }

      let response: Response;
      try {
        response = await fetch("https://api.postmarkapp.com/email", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Postmark-Server-Token": token,
          },
          body: JSON.stringify({
            From: draft.fromName
              ? `${draft.fromName} <${draft.fromEmail}>`
              : draft.fromEmail,
            To: draft.toName ? `${draft.toName} <${draft.toEmail}>` : draft.toEmail,
            ReplyTo: draft.replyTo ?? undefined,
            Subject: draft.subject,
            TextBody: draft.body,
            MessageStream: "outbound",
            Headers: headers,
          }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        throw new TransientDeliveryError(
          `postmark unreachable: ${err instanceof Error ? err.message : String(err)}`,
          "ENETWORK",
        );
      }

      const payload = (await response.json().catch(() => null)) as {
        MessageID?: string;
        ErrorCode?: number;
        Message?: string;
        SubmittedAt?: string;
      } | null;

      if (response.ok && payload?.ErrorCode === 0) {
        return {
          providerMessageId: payload.MessageID ?? null,
          response: payload.SubmittedAt ?? "accepted",
        };
      }
      throw classifyPostmarkError(response.status, payload);
    },
  };
}

/**
 * Postmark's `ErrorCode` is more specific than its HTTP status, so it wins
 * where both are present.
 *
 * 406 is the one worth naming: the recipient is inactive, meaning Postmark has
 * already recorded a hard bounce or a complaint for that address and is
 * refusing on our behalf. Treating it as anything but a suppression would mean
 * discovering the same fact once per message forever.
 */
export function classifyPostmarkError(
  status: number,
  payload: { ErrorCode?: number; Message?: string } | null,
): TransientDeliveryError | PermanentDeliveryError {
  const message = payload?.Message ?? `postmark returned ${status}`;
  const errorCode = payload?.ErrorCode ?? null;

  if (errorCode === 406) {
    return new PermanentDeliveryError(message, "406", "hard_bounce");
  }
  if (errorCode === 300 || errorCode === 400) {
    // Invalid email address, or a malformed request. Both are ours to fix.
    return new PermanentDeliveryError(message, String(errorCode));
  }
  if (errorCode === 10 || errorCode === 401) {
    return new PermanentDeliveryError(`postmark rejected the token: ${message}`, String(errorCode));
  }
  if (status === 401 || status === 403) {
    return new PermanentDeliveryError(`postmark rejected the token: ${message}`, String(status));
  }
  if (status === 429 || status >= 500) {
    return new TransientDeliveryError(message, String(status));
  }
  if (errorCode === 405) {
    // Sending on this server is paused — an operator switched it off, and it
    // is reasonable to expect them to switch it back on.
    return new TransientDeliveryError(message, "405");
  }
  return new PermanentDeliveryError(message, errorCode === null ? String(status) : String(errorCode));
}

/**
 * Exponential backoff with full jitter, capped.
 *
 * Attempt 1 waits a minute, then four, sixteen, sixty-four; five attempts span
 * a little over two hours. Jitter matters more than the curve: a provider
 * outage queues every message in the system behind the same clock, and without
 * it they all come back at the same instant and knock the provider over again
 * the moment it recovers.
 */
export function retryDelayMs(attempt: number, random = Math.random): number {
  const base = Math.min(60_000 * Math.pow(4, Math.max(0, attempt - 1)), 6 * 3600_000);
  // Full jitter, floored at a quarter of the base so a retry is never
  // effectively immediate.
  return Math.round(base * (0.25 + 0.75 * random()));
}
