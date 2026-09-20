import { createHash } from "node:crypto";
import { simpleParser, type ParsedMail } from "mailparser";
import type { InboundMessage } from "@hd/core";

/**
 * Email normalizer.
 *
 * Email is the easiest channel to start with and the messiest to parse. Three
 * things earn their place here: a stable message id for idempotency, quoted
 * history stripped before the body reaches a model, and auto-replies dropped
 * before they become tickets.
 */
export interface NormalizeOptions {
  /** Fallback when the message carries no Message-ID header. */
  fallbackId?: string;
}

export async function normalizeEml(
  raw: Buffer | string,
  opts: NormalizeOptions,
): Promise<InboundMessage | null> {
  const parsed = await simpleParser(raw);
  return normalizeParsed(parsed, opts, typeof raw === "string" ? raw : raw.toString("utf8"));
}

export function normalizeParsed(
  parsed: ParsedMail,
  opts: NormalizeOptions,
  rawText?: string,
): InboundMessage | null {
  if (isAutoReply(parsed)) return null;

  const from = parsed.from?.value?.[0];
  const email = from?.address?.trim().toLowerCase();
  if (!email) return null;

  const body = stripQuotedHistory(parsed.text ?? htmlToText(parsed.html || "")).trim();
  const subject = (parsed.subject ?? "(no subject)").trim() || "(no subject)";

  const messageId =
    parsed.messageId?.trim() ||
    opts.fallbackId ||
    `sha256:${createHash("sha256").update(rawText ?? `${email}${subject}${body}`).digest("hex")}`;

  return {
    source: "email",
    source_message_id: messageId,
    requester_email: email,
    requester_name: from?.name?.trim() || null,
    subject,
    body: body || "(empty message)",
    attachments: (parsed.attachments ?? []).map((a) => ({
      filename: a.filename ?? "attachment",
      content_type: a.contentType ?? null,
      size_bytes: a.size ?? null,
      storage_key: null,
    })),
    received_at: parsed.date ?? new Date(),
    meta: {
      in_reply_to: parsed.inReplyTo ?? null,
      references: parsed.references ?? null,
      to: parsed.to && "text" in parsed.to ? parsed.to.text : null,
    },
  };
}

/**
 * Out-of-office and bounce loops are the classic way a helpdesk inbox turns
 * into a thousand tickets overnight.
 */
export function isAutoReply(parsed: ParsedMail): boolean {
  const headers = parsed.headers;
  const autoSubmitted = String(headers.get("auto-submitted") ?? "").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (headers.get("x-autoreply") || headers.get("x-autorespond")) return true;
  if (String(headers.get("precedence") ?? "").toLowerCase() === "bulk") return true;
  const subject = (parsed.subject ?? "").toLowerCase();
  return /^(out of office|automatic reply|auto:|undeliverable|delivery status notification)/.test(
    subject,
  );
}

/**
 * Cut the thread history. Everything below the first quote marker is context
 * the agent already has in the ticket record, and feeding it back inflates
 * every prompt on a long thread.
 */
export function stripQuotedHistory(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const markers = [
    /^\s*-{2,}\s*Original Message\s*-{2,}/i,
    /^\s*On .+ wrote:\s*$/,
    /^\s*From:\s.+$/,
    /^\s*_{5,}\s*$/,
    /^\s*-{5,}\s*$/,
    /^\s*Sent from my /i,
  ];
  const cut = lines.findIndex((line) => markers.some((m) => m.test(line)));
  const kept = cut === -1 ? lines : lines.slice(0, cut);
  return kept
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
