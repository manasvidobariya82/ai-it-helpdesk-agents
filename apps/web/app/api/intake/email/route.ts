import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  applyBounce,
  contextForIntakeAddress,
  contextForIntakeToken,
  env,
  intakeMessage,
  listBusinesses,
  parseDeliveryStatus,
  systemContext,
} from "@hd/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Inbound email webhook (Postmark / SendGrid inbound parse, or anything that
 * can POST JSON).
 *
 * Providers retry on any non-2xx, so this endpoint has to be idempotent, and
 * it is: dedupe happens on (source, source_message_id) at the database level.
 * A redelivery returns 200 with `duplicate: true` rather than a second ticket.
 *
 * The tenant is resolved from the credential the caller presents, not from the
 * body. This endpoint used to accept `business_id` in its JSON and authenticate
 * the whole thing with one deployment-wide secret, which meant any integration
 * holding that secret could file tickets into any tenant — the server-to-server
 * form of `GET /tickets?business_id=123`. A per-tenant token removes the
 * parameter rather than validating it.
 */

const Payload = z
  .object({
    from: z.email(),
    from_name: z.string().nullish(),
    subject: z.string().default("(no subject)"),
    body: z.string().default(""),
    message_id: z.string().nullish(),
    /** The headers a reply carries, so it joins its ticket instead of opening one. */
    in_reply_to: z.string().nullish(),
    references: z.union([z.string(), z.array(z.string())]).nullish(),
    received_at: z.coerce.date().optional(),
    attachments: z
      .array(
        z.object({
          filename: z.string(),
          content_type: z.string().nullish(),
          size_bytes: z.number().int().nonnegative().nullish(),
        }),
      )
      .default([]),
  })
  // Postmark's field names, accepted as-is so the hook can be pointed here directly.
  .or(
    z.object({
      From: z.string(),
      FromName: z.string().nullish(),
      Subject: z.string().nullish(),
      TextBody: z.string().nullish(),
      HtmlBody: z.string().nullish(),
      MessageID: z.string().nullish(),
      Date: z.string().nullish(),
      Headers: z
        .array(z.object({ Name: z.string(), Value: z.string() }))
        .nullish(),
    }),
  );

export async function POST(request: Request): Promise<NextResponse> {
  // Per-tenant token first; the shared secret is the legacy single-tenant path
  // and resolves to the only business there is.
  const tenant = await resolveTenant(request);
  if (!tenant) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = Payload.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const normalized = normalize(parsed.data);

  /*
   * A bounce is not a ticket.
   *
   * Providers that forward everything to one inbound hook forward delivery
   * status notifications too, and the old behaviour — drop it as an auto-reply
   * — lost the only notice that a reply never arrived. Reading it here costs a
   * regex on the body and turns a dropped message into a suppression, a ticket
   * event and a status a human can see.
   */
  const bounce = parseDeliveryStatus(normalized.body, {
    from: normalized.from,
    subject: normalized.subject,
  });
  if (bounce) {
    const outcome = await applyBounce(tenant, bounce);
    return NextResponse.json({
      bounce: bounce.kind,
      recipient: bounce.recipient,
      matched_message: outcome.matched?.id ?? null,
      applied: outcome.applied,
      suppressed: outcome.suppressed,
    });
  }

  try {
    const result = await intakeMessage(tenant, {
      source: "email",
      source_message_id: normalized.message_id,
      requester_email: normalized.from,
      requester_name: normalized.from_name,
      subject: normalized.subject,
      body: normalized.body,
      attachments: normalized.attachments,
      received_at: normalized.received_at,
      meta: {
        via: "webhook",
        in_reply_to: normalized.in_reply_to,
        references: normalized.references,
      },
    });

    return NextResponse.json({
      ticket_id: result.ticket.id,
      duplicate: !result.created,
      queued: result.enqueued,
    });
  } catch (err) {
    console.error("[intake] webhook failed", err);
    return NextResponse.json({ error: "intake failed" }, { status: 500 });
  }
}

/**
 * Work out which tenant this call is acting for, or refuse.
 *
 * Three ways in, in decreasing order of preference:
 *
 *   1. `x-intake-token` — a per-tenant bearer credential. The tenant comes out
 *      of the database row the token matches.
 *   2. The deployment-wide `INTAKE_WEBHOOK_SECRET` plus the delivered-to
 *      address, for providers that forward the envelope recipient to one
 *      shared webhook URL. The secret proves the caller is the provider; the
 *      address picks the tenant.
 *   3. The shared secret alone, which is only honoured when there is exactly
 *      one tenant. On a multi-tenant deployment it cannot name a tenant, so it
 *      is refused rather than guessing.
 *
 * The delivered-to address is never a credential on its own. It is the
 * tenant's support address — printed in signatures and on the intranet — and
 * accepting it without the secret let anybody who knew it file tickets into
 * that tenant, thread onto its tickets, and post bounces that suppress its
 * requesters' addresses.
 */
async function resolveTenant(request: Request) {
  const token = request.headers.get("x-intake-token");
  if (token) return contextForIntakeToken(token);

  if (!sharedSecretOk(request)) return null;

  const deliveredTo = request.headers.get("x-delivered-to");
  if (deliveredTo) {
    const byAddress = await contextForIntakeAddress(deliveredTo);
    if (byAddress) return byAddress;
  }

  const businesses = await listBusinesses();
  if (businesses.length !== 1) {
    // Refusing here is the point. Falling back to "the first business" is how
    // a second tenant silently starts receiving another company's mail.
    console.error(
      "[intake] shared secret used on a multi-tenant deployment; " +
        "send x-intake-token instead (businesses.intake_token)",
    );
    return null;
  }
  return systemContext(businesses[0]!.id, { requestId: "intake:webhook" });
}

function sharedSecretOk(request: Request): boolean {
  const header =
    request.headers.get("x-intake-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  const expected = env.INTAKE_WEBHOOK_SECRET;
  // An empty secret would match a request that sends no header at all.
  if (!expected || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Normalized {
  from: string;
  from_name: string | null;
  subject: string;
  body: string;
  message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  received_at: Date;
  attachments: {
    filename: string;
    content_type: string | null;
    size_bytes: number | null;
    storage_key: null;
  }[];
}

function normalize(data: z.infer<typeof Payload>): Normalized {
  if ("From" in data) {
    const header = (name: string) =>
      data.Headers?.find((h) => h.Name.toLowerCase() === name)?.Value ?? null;
    return {
      from: extractAddress(data.From),
      from_name: data.FromName ?? null,
      subject: data.Subject?.trim() || "(no subject)",
      body: (data.TextBody ?? stripHtml(data.HtmlBody ?? "")).trim() || "(empty message)",
      message_id: data.MessageID ?? null,
      in_reply_to: header("in-reply-to"),
      references: splitReferences(header("references")),
      received_at: parseDate(data.Date),
      attachments: [],
    };
  }
  return {
    from: data.from,
    from_name: data.from_name ?? null,
    subject: data.subject.trim() || "(no subject)",
    body: data.body.trim() || "(empty message)",
    message_id: data.message_id ?? null,
    in_reply_to: data.in_reply_to ?? null,
    references: Array.isArray(data.references)
      ? data.references
      : splitReferences(data.references ?? null),
    received_at: data.received_at ?? new Date(),
    attachments: data.attachments.map((a) => ({
      filename: a.filename,
      content_type: a.content_type ?? null,
      size_bytes: a.size_bytes ?? null,
      storage_key: null,
    })),
  };
}

function splitReferences(value: string | null): string[] {
  return value ? value.split(/\s+/).filter(Boolean) : [];
}

/**
 * A `Date` header that does not parse is not a reason to refuse the mail: the
 * schema would reject the Invalid Date, and a 500 here is a provider retry loop
 * that never succeeds.
 */
function parseDate(value: string | null | undefined): Date {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
}

function extractAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim().toLowerCase();
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}


