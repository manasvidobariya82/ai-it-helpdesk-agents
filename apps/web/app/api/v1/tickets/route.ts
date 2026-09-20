import { z } from "zod";
import {
  TicketPriority,
  TicketStatus,
  intakeMessage,
  listTickets,
  requirePermission,
  type TicketListRow,
} from "@hd/core";
import { intParam, listParam, ok, readJson, withApi } from "../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `/api/v1/tickets` — list and create.
 *
 * The API this platform did not have. Until now the only authenticated route
 * was the inbound mail webhook, which means the only client that could read a
 * ticket was this repository's own console — and "can be handed to somebody
 * else" was not true of the deployment in the way the P1 gate claims.
 *
 * Two things are deliberate about the shape.
 *
 * **The response is a projection, not a row.** `toPublicTicket` lists every
 * field this API promises, so a column added to `tickets` next month does not
 * silently become part of a public contract — and the internal columns that
 * are nobody's business outside the console (the injection flag, the config
 * version a decision was made under) stay inside it.
 *
 * **Permissions are the role's, unchanged.** A `viewer` key can list tickets
 * and cannot create one, because `ticket:create` is not a viewer permission.
 * There is no separate scope system: a second authorization model would be a
 * second place for the two to disagree.
 */

function toPublicTicket(t: TicketListRow) {
  return {
    id: t.id,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    category: t.category,
    subcategory: t.subcategory,
    source: t.source,
    resolution_path: t.resolution_path,
    triage_confidence: t.triage_confidence,
    is_incident: t.is_incident,
    requester: t.requester_email
      ? { email: t.requester_email, name: t.requester_name, vip: t.requester_vip ?? false }
      : null,
    assignee: t.assignee_name ? { name: t.assignee_name } : null,
    first_response_at: t.first_response_at,
    first_response_due_at: t.first_response_due_at,
    resolution_due_at: t.resolution_due_at,
    resolved_at: t.resolved_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

const MAX_PAGE = 100;

export const GET = withApi(async ({ caller, url }) => {
  const statuses = listParam(url, "status").map((s) => TicketStatus.parse(s));
  const priorities = listParam(url, "priority").map((p) => TicketPriority.parse(p));
  const limit = intParam(url, "limit", 25, MAX_PAGE);
  const offset = intParam(url, "offset", 0, 100_000);

  // Scoped by the context the key produced. There is no tenant parameter to
  // pass, which is the property that makes this safe rather than carefully
  // written.
  const rows = await listTickets(caller.ctx, {
    ...(statuses.length ? { status: statuses } : {}),
    ...(priorities.length ? { priority: priorities } : {}),
    ...(url.searchParams.get("category")
      ? { category: url.searchParams.get("category")! }
      : {}),
    ...(url.searchParams.get("search") ? { search: url.searchParams.get("search")! } : {}),
    limit,
    offset,
  });

  return ok(rows.map(toPublicTicket), {
    limit,
    offset,
    count: rows.length,
    // A `next` offset only when this page was full. A client that pages until
    // `next` is null makes exactly the right number of requests.
    next_offset: rows.length === limit ? offset + limit : null,
  });
});

/**
 * Create a ticket.
 *
 * Goes through `intakeMessage`, the same door email and the portal use, rather
 * than inserting a row. That is what keeps deduplication, identity resolution,
 * threading, secret scrubbing and the triage enqueue identical across channels
 * — a second create path is how two channels start behaving differently, and
 * the one that skips secret scrubbing is the one somebody pastes a password
 * into.
 */
const CreateTicket = z.object({
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(50_000),
  requester_email: z.email(),
  requester_name: z.string().max(200).nullish(),
  /** Deduplication key. Send the same one twice and get the same ticket. */
  external_id: z.string().min(1).max(200).nullish(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const POST = withApi(async ({ caller, request }) => {
  // Checked before anything is parsed, so a read-only key gets a 403 rather
  // than a validation error about a body it was never allowed to send.
  requirePermission(caller.ctx, "ticket:create");

  const payload = CreateTicket.parse(await readJson(request));
  const result = await intakeMessage(caller.ctx, {
    source: "api",
    source_message_id:
      payload.external_id ?? `api:${caller.key.id}:${crypto.randomUUID()}`,
    requester_email: payload.requester_email,
    requester_name: payload.requester_name ?? null,
    subject: payload.subject,
    body: payload.body,
    attachments: [],
    received_at: new Date(),
    // The caller's metadata first, then ours: `via` and `api_key` are the
    // record of which credential filed this ticket, and a client that sends
    // `{"metadata": {"api_key": "someone else"}}` must not be able to rewrite
    // that.
    meta: { ...(payload.metadata ?? {}), via: "api", api_key: caller.key.name },
  });

  return ok(
    {
      id: result.ticket.id,
      status: result.ticket.status,
      subject: result.ticket.subject,
      created_at: result.ticket.created_at,
    },
    {
      // A redelivery is not an error and must not create a second ticket: the
      // client that retried on a timeout gets the ticket it already made.
      duplicate: !result.created,
      queued: result.enqueued,
    },
    result.created ? 201 : 200,
  );
});
