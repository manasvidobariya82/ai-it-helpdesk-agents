import { query, queryOne, tx } from "../db.js";
import {
  NotFoundError,
  actorString,
  requirePermission,
  type TenantContext,
} from "../auth/context.js";
import { audit } from "./audit.js";
import { lockConversation } from "./conversations.js";
import { isUuid, permissionForStatus, setStatus } from "./tickets.js";
import { TicketStatus, type Ticket } from "../types.js";

/**
 * Email threading, merge, and assignment.
 *
 * Threading is the difference between a helpdesk and an inbox. Without it,
 * "thanks, that worked" arrives as a brand new P3 ticket, gets triaged, gets
 * a runbook reply, and the requester learns the agent is not listening.
 */

/**
 * Remember a Message-ID as part of a ticket's thread.
 *
 * Unique per tenant, not globally: one email copied to two tenants' support
 * addresses carries one Message-ID, and whichever tenant saw it first used to
 * own it — the other's row was silently dropped, so a reply to that email
 * could never thread there. The tenant is taken from the ticket row.
 */
export async function recordMessageId(
  ticketId: string,
  messageId: string,
  direction: "inbound" | "outbound" = "inbound",
): Promise<void> {
  await query(
    `insert into ticket_message_ids (business_id, message_id, ticket_id, direction)
     select t.business_id, $1, t.id, $3
       from tickets t
      where t.id = $2
     on conflict (business_id, message_id) do nothing`,
    [messageId, ticketId, direction],
  );
}

/**
 * Find the ticket a reply belongs to, from its In-Reply-To and References
 * headers. Mail clients disagree about which they populate and in what order,
 * so try every candidate and take the most recent match.
 */
export async function findTicketByReferences(
  businessId: string,
  candidates: string[],
): Promise<Ticket | null> {
  const ids = candidates.map((c) => c.trim()).filter(Boolean);
  if (ids.length === 0) return null;

  return queryOne<Ticket>(
    `select t.*
       from ticket_message_ids m
       join tickets t on t.id = m.ticket_id
      where m.message_id = any($1::text[])
        and m.business_id = $2
        and t.business_id = $2
      order by t.created_at desc
      limit 1`,
    [ids, businessId],
  );
}

/**
 * A subject-line fallback for clients that strip threading headers. Matches
 * the `[NG-1a2b3c4d]` tag the outbound reply carries.
 */
export async function findTicketBySubjectTag(
  businessId: string,
  subject: string,
): Promise<Ticket | null> {
  const tag = subject.match(/\[([A-Z]{2}-[0-9a-f]{8})\]/);
  if (!tag) return null;
  const short = tag[1]!.split("-")[1]!;
  let ticket = await queryOne<Ticket>(
    `select * from tickets
      where business_id = $1 and id::text like $2 || '%'
      limit 1`,
    [businessId, short],
  );

  // A merged ticket's subject tag is still in the requester's mail client.
  // Their reply belongs on the surviving ticket, the same place a reply found
  // by its headers goes — `mergeTicket` moves the Message-IDs but cannot
  // rewrite a subject line somebody already has. Without this the reply
  // reopened the closed, merged-away ticket that nobody works on.
  for (let hop = 0; ticket?.merged_into_id && hop < 5; hop++) {
    ticket = await queryOne<Ticket>(
      `select * from tickets where id = $1 and business_id = $2`,
      [ticket.merged_into_id, businessId],
    );
  }
  return ticket;
}

export function subjectTag(ticketId: string): string {
  return `[NG-${ticketId.slice(0, 8)}]`;
}

/**
 * Every Message-ID on one ticket's thread, oldest first.
 *
 * This is what an outbound reply puts in `References`, and its last entry is
 * what goes in `In-Reply-To`. Without it a reply is a new conversation in the
 * requester's mail client: correct content, wrong thread, and a person who
 * cannot find the answer they were sent.
 *
 * Scoped by a join, because `ticket_message_ids` carries no `business_id` of
 * its own — it inherits the ticket's.
 */
export async function threadMessageIds(
  ctx: TenantContext,
  ticketId: string,
): Promise<string[]> {
  requirePermission(ctx, "ticket:read");
  const rows = await query<{ message_id: string }>(
    `select m.message_id
       from ticket_message_ids m
       join tickets t on t.id = m.ticket_id
      where m.ticket_id = $1 and t.business_id = $2
      order by m.created_at asc`,
    [ticketId, ctx.businessId],
  );
  return rows.map((r) => r.message_id);
}

/**
 * Assign a ticket to a member of staff.
 *
 * Both ids are checked against the tenant in SQL — the ticket by predicate and
 * the staff row by subquery — so neither "assign my ticket to their engineer"
 * nor "assign their ticket to me" matches a row.
 */
export async function assignTicket(
  ctx: TenantContext,
  ticketId: string,
  staffId: string | null,
): Promise<void> {
  requirePermission(ctx, "ticket:assign");
  const updated = await queryOne<{ id: string }>(
    `update tickets
        set assigned_to = case
              when $3::uuid is null then null
              else (select s.id from staff s where s.id = $3 and s.business_id = $2)
            end,
            updated_at = now()
      where id = $1 and business_id = $2
      returning id`,
    [ticketId, ctx.businessId, staffId],
  );
  if (!updated) throw new NotFoundError("ticket");

  await audit(ctx, {
    action: "ticket.assign",
    resource_type: "ticket",
    resource_id: ticketId,
    new_value: { assigned_to: staffId },
  });
}

/**
 * Apply one patch to many tickets.
 *
 * The tenant predicate is what makes a list of ids safe to accept from a form:
 * ids belonging to another business simply do not match, and the returned count
 * is lower than the list the caller sent. That difference is the caller's
 * problem to notice, not a reason to leak which ids were real.
 */
export async function bulkUpdate(
  ctx: TenantContext,
  ticketIds: string[],
  patch: { status?: string; assigned_to?: string | null },
): Promise<number> {
  return (await bulkUpdateTickets(ctx, ticketIds, patch)).length;
}

/**
 * The same, returning the ids that actually changed, so a caller can write an
 * event and send a notification for those and only those.
 *
 * A status change goes through `setStatus`, one ticket at a time. It used to be
 * a single `update ... set status`, which skipped everything `setStatus` exists
 * for: a bulk close needed only `ticket:update`, so an agent could close and
 * reopen in bulk what they could not close or reopen one at a time; a bulk
 * resolve left `resolved_at` empty, so the follow-up sweep never closed those
 * tickets and their SLA read as still running; and a ticket moved out of
 * `awaiting_user` in bulk kept its clock stopped.
 *
 * An assignee is checked against the tenant once, up front, so a staff id from
 * another business fails the whole request rather than landing on forty rows.
 */
export async function bulkUpdateTickets(
  ctx: TenantContext,
  ticketIds: string[],
  patch: { status?: string; assigned_to?: string | null },
): Promise<string[]> {
  const status = patch.status ? TicketStatus.parse(patch.status) : null;
  const assigning = patch.assigned_to !== undefined;

  // Every permission the patch needs, before anything is touched.
  if (assigning) requirePermission(ctx, "ticket:assign");
  if (status) requirePermission(ctx, permissionForStatus(status));
  if (!assigning && !status) requirePermission(ctx, "ticket:update");

  // A malformed id matches nothing, the same as a foreign one, rather than
  // failing the whole batch on a uuid cast.
  const ids = [...new Set(ticketIds)].filter(isUuid);
  if (ids.length === 0) return [];

  const assignee = patch.assigned_to ?? null;
  if (assigning && assignee !== null) {
    const staff = isUuid(assignee)
      ? await queryOne<{ id: string }>(
          `select id from staff where id = $1 and business_id = $2`,
          [assignee, ctx.businessId],
        )
      : null;
    if (!staff) throw new NotFoundError("staff");
  }

  let changed = ids;
  if (assigning) {
    const rows = await query<{ id: string }>(
      `update tickets set assigned_to = $3::uuid, updated_at = now()
        where business_id = $1 and id = any($2::uuid[])
        returning id`,
      [ctx.businessId, ids, assignee],
    );
    const hit = new Set(rows.map((r) => r.id));
    changed = ids.filter((id) => hit.has(id));
  }

  if (status) {
    const moved: string[] = [];
    for (const id of changed) {
      try {
        await setStatus(ctx, id, status);
        moved.push(id);
      } catch (err) {
        // Another tenant's id, or one that does not exist: skipped, not fatal.
        if (!(err instanceof NotFoundError)) throw err;
      }
    }
    changed = moved;
  }

  return changed;
}

export interface MergeResult {
  mergedId: string;
  targetId: string;
  eventsMoved: number;
}

/**
 * Merge `sourceId` into `targetId`.
 *
 * The source ticket is not deleted. Its events are copied onto the target so
 * the thread reads in one place, and the source stays closed with a pointer,
 * because "where did my ticket go" is a question the audit trail has to be
 * able to answer.
 */
export async function mergeTicket(
  ctx: TenantContext,
  sourceId: string,
  targetId: string,
): Promise<MergeResult> {
  requirePermission(ctx, "ticket:update");
  if (sourceId === targetId) throw new Error("cannot merge a ticket into itself");
  const actor = actorString(ctx);

  const result = await tx(async (client) => {
    // Scoped to the tenant here rather than compared afterwards: a merge is
    // the one operation that takes two ids at once, and "both must exist" has
    // to mean "both must exist in your tenant" or it is a way to discover
    // whether an id in someone else's business is real.
    const both = await client.query<Ticket>(
      `select * from tickets where id = any($1::uuid[]) and business_id = $2`,
      [[sourceId, targetId], ctx.businessId],
    );
    const source = both.rows.find((t) => t.id === sourceId);
    const target = both.rows.find((t) => t.id === targetId);
    if (!source || !target) throw new Error("both tickets must exist");
    if (source.business_id !== target.business_id) {
      throw new Error("refusing to merge across tenants");
    }
    if (target.merged_into_id) {
      throw new Error("target has itself been merged; merge into the surviving ticket");
    }

    // Both parameters are cast where they are compared. `$1` is used twice, and
    // Postgres infers one type per parameter from its first use — `::text`,
    // inside the jsonb — so the uncast `ticket_id = $1` was `uuid = text`, and
    // every merge failed with "operator does not exist".
    const moved = await client.query(
      `insert into ticket_events (ticket_id, actor, kind, payload, model, tokens_in, tokens_out, cost_usd, latency_ms, created_at)
       select $2::uuid, actor, kind,
              payload || jsonb_build_object('merged_from', $1::text),
              model, tokens_in, tokens_out, cost_usd, latency_ms, created_at
         from ticket_events where ticket_id = $1::uuid`,
      [sourceId, targetId],
    );

    // Future replies on the old thread land on the surviving ticket.
    await client.query(
      `update ticket_message_ids set ticket_id = $2 where ticket_id = $1`,
      [sourceId, targetId],
    );

    // And nothing more is written to the old conversation (C10 in
    // docs/conversation.md). Its messages stay where they are, append-only,
    // on the ticket they were written to.
    await lockConversation(client, ctx, sourceId, "merged");

    await client.query(
      `update tickets
          set merged_into_id = $2, status = 'closed', closed_at = now(), updated_at = now()
        where id = $1`,
      [sourceId, targetId],
    );

    await client.query(
      `insert into ticket_events (ticket_id, actor, kind, payload)
       values ($1, $2, 'note', $3::jsonb), ($4, $2, 'note', $5::jsonb)`,
      [
        sourceId,
        actor,
        JSON.stringify({ stage: "merge", merged_into: targetId }),
        targetId,
        JSON.stringify({ stage: "merge", absorbed: sourceId, events: moved.rowCount }),
      ],
    );

    return { mergedId: sourceId, targetId, eventsMoved: moved.rowCount ?? 0 };
  });

  await audit(ctx, {
    action: "ticket.merge",
    resource_type: "ticket",
    resource_id: sourceId,
    new_value: { merged_into: targetId, events_moved: result.eventsMoved },
  });
  return result;
}

/**
 * Candidate duplicates: same requester, same category, still open, opened
 * close together. Deliberately conservative - this proposes, a human merges.
 */
export async function duplicateCandidates(
  ctx: TenantContext,
  withinHours = 48,
): Promise<{ a: string; b: string; subject_a: string; subject_b: string; requester: string | null }[]> {
  requirePermission(ctx, "ticket:read");
  return query(
    `select a.id as a, b.id as b, a.subject as subject_a, b.subject as subject_b,
            r.email as requester
       from tickets a
       join tickets b
         on b.business_id = a.business_id
        and b.requester_id = a.requester_id
        and b.id > a.id
        and b.created_at between a.created_at - ($2 || ' hours')::interval
                             and a.created_at + ($2 || ' hours')::interval
       left join requesters r on r.id = a.requester_id
      where a.business_id = $1
        and a.merged_into_id is null and b.merged_into_id is null
        and a.status not in ('closed') and b.status not in ('closed')
        and coalesce(a.category, '') = coalesce(b.category, '')
      order by a.created_at desc
      limit 25`,
    [ctx.businessId, String(withinHours)],
  );
}
