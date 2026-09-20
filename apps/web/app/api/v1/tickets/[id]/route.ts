import {
  NotFoundError,
  eventsFor,
  getRequester,
  getTicket,
  isUuid,
  outboundForTicket,
  slaStatus,
  threadFor,
} from "@hd/core";
import { ok, withApi } from "../../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/v1/tickets/:id` — one ticket, optionally with its history.
 *
 * `?include=messages,events,delivery` because the timeline is large and most callers
 * want the ticket. Opt-in rather than always-on: an endpoint that returns two
 * hundred events by default is one that gets called once and then cached badly.
 *
 * A ticket in another tenant is a 404, not a 403. `getTicket` scopes by the
 * context the API key produced, so a foreign id simply matches no row — and the
 * status code has to agree with that, or the difference between "exists" and
 * "does not exist" becomes readable from outside.
 */
export const GET = withApi<{ id: string }>(async ({ caller, params, url }) => {
  // Checked before the query: a malformed uuid would otherwise reach Postgres
  // as a cast error and surface as a 500 about syntax.
  if (!isUuid(params.id)) throw new NotFoundError("ticket");

  const ticket = await getTicket(caller.ctx, params.id);
  if (!ticket) throw new NotFoundError("ticket");

  const include = new Set(
    (url.searchParams.get("include") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const requester = ticket.requester_id
    ? await getRequester(caller.ctx, ticket.requester_id)
    : null;
  const sla = slaStatus(ticket);

  const body: Record<string, unknown> = {
    id: ticket.id,
    subject: ticket.subject,
    body: ticket.body,
    status: ticket.status,
    priority: ticket.priority,
    category: ticket.category,
    subcategory: ticket.subcategory,
    source: ticket.source,
    resolution_path: ticket.resolution_path,
    triage_confidence: ticket.triage_confidence,
    is_incident: ticket.is_incident,
    parent_incident_id: ticket.parent_incident_id,
    merged_into_id: ticket.merged_into_id,
    requester: requester
      ? {
          email: requester.email,
          name: requester.full_name,
          department: requester.department,
          vip: requester.vip,
        }
      : null,
    sla: {
      first_response: sla.firstResponse,
      resolution: sla.resolution,
      minutes_to_nearest: sla.minutesToNearest,
      first_response_due_at: ticket.first_response_due_at,
      resolution_due_at: ticket.resolution_due_at,
      // History rather than the live reading: the deadline each target first
      // missed, set once and never cleared, even by a reopen.
      first_response_breached_at: ticket.first_response_breached_at,
      resolution_breached_at: ticket.resolution_breached_at,
    },
    first_response_at: ticket.first_response_at,
    resolved_at: ticket.resolved_at,
    closed_at: ticket.closed_at,
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
  };

  if (include.has("messages")) {
    // The conversation (docs/conversation.md). What a key may see follows its
    // role: without `ticket_internal:read`, internal notes and drafts are left
    // out by the repository.
    const thread = await threadFor(caller.ctx, ticket.id);
    body.messages = thread.map((m) => ({
      id: m.id,
      seq: m.seq,
      kind: m.kind,
      visibility: m.visibility,
      from: m.from,
      author_kind: m.author_kind,
      channel: m.channel,
      body: m.body,
      attachments: m.attachments.map((a) => ({
        filename: a.filename,
        content_type: a.content_type,
        size_bytes: a.size_bytes,
      })),
      ai_model: m.ai_model,
      derived_from_id: m.derived_from_id,
      copied: m.legacy !== null,
      at: m.at,
    }));
  }

  if (include.has("events")) {
    const events = await eventsFor(caller.ctx, ticket.id);
    body.events = events.map((e) => ({
      id: e.id,
      kind: e.kind,
      actor: e.actor,
      // The payload is the event log's own shape and is served as-is: it is the
      // honest answer to "why did the agent do that", and re-projecting it here
      // would mean two descriptions of the same history.
      payload: e.payload,
      model: e.model,
      cost_usd: e.cost_usd,
      created_at: e.created_at,
    }));
  }

  if (include.has("delivery")) {
    // What was actually addressed to the requester, and what happened to it.
    // `sent` means the provider accepted it, which is not the same as received.
    const messages = await outboundForTicket(caller.ctx, ticket.id);
    body.delivery = messages.map((m) => ({
      id: m.id,
      kind: m.kind,
      to: m.to_email,
      subject: m.subject,
      status: m.status,
      attempts: m.attempts,
      provider: m.provider,
      bounce_kind: m.bounce_kind,
      sent_at: m.sent_at,
      created_at: m.created_at,
    }));
  }

  return ok(body);
});
