import { NextResponse } from "next/server";
import { z } from "zod";
import {
  applyBounce,
  contextForIntakeToken,
  findOutboundByMessageId,
  findOutboundByProviderId,
  recordOutboundEvent,
  type ParsedBounce,
  type TenantContext,
} from "@hd/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Delivery events from the mail provider: bounces, complaints, deliveries.
 *
 * The SMTP deployment learns about failures as mail — a delivery status
 * notification arriving at the intake address, handled there. An API provider
 * tells you over HTTP instead, and this is that door.
 *
 * Authenticated per tenant with the same credential the inbound hook uses, and
 * for the same reason: the tenant has to come from the credential. A bounce
 * names one of our Message-IDs, and a Message-ID is not a secret — it has
 * travelled through a stranger's mail server by definition. An endpoint that
 * resolved the message without a tenant predicate would let anyone who has ever
 * received one of our emails mark another tenant's mail as bounced, or suppress
 * an address they have no relationship with.
 *
 * Providers retry on any non-2xx, so nothing here is destructive on a
 * redelivery: marking an already-bounced message bounced changes nothing, and
 * suppressing an already-suppressed address inserts nothing.
 */

const Postmark = z.object({
  RecordType: z.enum([
    "Bounce",
    "SpamComplaint",
    "Delivery",
    "SubscriptionChange",
    "Open",
    "Click",
  ]),
  /** HardBounce, SoftBounce, Transient, SpamNotification, ... */
  Type: z.string().nullish(),
  TypeCode: z.number().nullish(),
  Email: z.string().nullish(),
  Recipient: z.string().nullish(),
  MessageID: z.string().nullish(),
  Description: z.string().nullish(),
  Details: z.string().nullish(),
  DeliveredAt: z.string().nullish(),
  BouncedAt: z.string().nullish(),
});

/** A provider-neutral shape, for anything that is not Postmark. */
const Generic = z.object({
  event: z.enum(["bounce", "complaint", "delivery"]),
  /** `hard` or `soft`; ignored for the other two events. */
  kind: z.enum(["hard", "soft"]).nullish(),
  email: z.string().nullish(),
  message_id: z.string().nullish(),
  status: z.string().nullish(),
  detail: z.string().nullish(),
});

export async function POST(request: Request): Promise<NextResponse> {
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

  const postmark = Postmark.safeParse(json);
  if (postmark.success) return handle(tenant, fromPostmark(postmark.data));

  const generic = Generic.safeParse(json);
  if (generic.success) return handle(tenant, fromGeneric(generic.data));

  return NextResponse.json(
    { error: "unrecognised delivery event", issues: generic.error.issues },
    { status: 422 },
  );
}

type Event =
  | { type: "bounce"; bounce: ParsedBounce }
  | { type: "delivery"; messageId: string | null; recipient: string | null; detail: string | null }
  | { type: "ignored"; recordType: string };

async function handle(tenant: TenantContext, event: Event): Promise<NextResponse> {
  if (event.type === "ignored") {
    // Opens and clicks are not delivery facts and this system does not track
    // them. Answering 200 stops the provider retrying something we will never
    // want.
    return NextResponse.json({ ignored: event.recordType });
  }

  if (event.type === "delivery") {
    const message = await resolveMessage(tenant, event.messageId);
    if (!message) return NextResponse.json({ matched: null });
    // A `delivered` event is the receiving server's acceptance, which is one
    // step further than our `sent` — the provider's acceptance. It is recorded
    // as history rather than as a status, because there is no state the rest of
    // the system would treat differently, and an eighth status nothing branches
    // on is a status that rots.
    await recordOutboundEvent(tenant, message.id, "delivered", {
      recipient: event.recipient,
      detail: event.detail,
    });
    return NextResponse.json({ matched: message.id, applied: "delivered" });
  }

  const outcome = await applyBounce(tenant, event.bounce);
  return NextResponse.json({
    bounce: event.bounce.kind,
    recipient: event.bounce.recipient,
    matched_message: outcome.matched?.id ?? null,
    applied: outcome.applied,
    suppressed: outcome.suppressed,
  });
}

async function resolveMessage(tenant: TenantContext, id: string | null) {
  if (!id) return null;
  return (
    (await findOutboundByProviderId(tenant, id)) ??
    (await findOutboundByMessageId(tenant, id))
  );
}

/**
 * Postmark's vocabulary, mapped.
 *
 * `HardBounce`, `BadEmailAddress` and `ManuallyDeactivated` are statements
 * about the mailbox; `Transient`, `DnsError` and `SoftBounce` are statements
 * about right now. Anything unrecognised is treated as soft, which is the safe
 * direction: it records the event and suppresses nobody.
 */
function fromPostmark(p: z.infer<typeof Postmark>): Event {
  if (p.RecordType === "Delivery") {
    return {
      type: "delivery",
      messageId: p.MessageID ?? null,
      recipient: (p.Recipient ?? p.Email ?? null)?.toLowerCase() ?? null,
      detail: p.Details ?? null,
    };
  }
  if (p.RecordType === "Bounce" || p.RecordType === "SpamComplaint") {
    const type = (p.Type ?? "").toLowerCase();
    const complaint =
      p.RecordType === "SpamComplaint" ||
      type === "spamcomplaint" ||
      type === "spamnotification";
    const hard = [
      "hardbounce",
      "bademailaddress",
      "manuallydeactivated",
    ].includes(type);
    return {
      type: "bounce",
      bounce: {
        kind: complaint ? "complaint" : hard ? "hard" : "soft",
        recipient: (p.Email ?? p.Recipient ?? null)?.trim().toLowerCase() ?? null,
        status: p.TypeCode != null ? String(p.TypeCode) : null,
        diagnostic: p.Details ?? p.Description ?? null,
        originalMessageId: p.MessageID ?? null,
        action: complaint ? "complaint" : hard ? "failed" : "delayed",
      },
    };
  }
  return { type: "ignored", recordType: p.RecordType };
}

function fromGeneric(g: z.infer<typeof Generic>): Event {
  if (g.event === "delivery") {
    return {
      type: "delivery",
      messageId: g.message_id ?? null,
      recipient: g.email?.trim().toLowerCase() ?? null,
      detail: g.detail ?? null,
    };
  }
  return {
    type: "bounce",
    bounce: {
      kind: g.event === "complaint" ? "complaint" : g.kind === "soft" ? "soft" : "hard",
      recipient: g.email?.trim().toLowerCase() ?? null,
      status: g.status ?? null,
      diagnostic: g.detail ?? null,
      originalMessageId: g.message_id ?? null,
      action: g.kind === "soft" ? "delayed" : "failed",
    },
  };
}

/**
 * The tenant, from the credential.
 *
 * Two ways to present the same per-tenant token, because providers differ:
 * a header, or the password half of HTTP basic auth — which is what Postmark's
 * webhook configuration offers. There is deliberately no shared-secret fallback
 * here: unlike intake, this endpoint has no legacy single-tenant deployment to
 * keep working, so it can require a credential that names a tenant.
 */
async function resolveTenant(request: Request): Promise<TenantContext | null> {
  const header = request.headers.get("x-intake-token");
  if (header) return contextForIntakeToken(header);

  const auth = request.headers.get("authorization") ?? "";
  const basic = auth.match(/^Basic\s+(.+)$/i);
  if (basic?.[1]) {
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (password) return contextForIntakeToken(password);
  }

  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer?.[1]) return contextForIntakeToken(bearer[1]);

  return null;
}
