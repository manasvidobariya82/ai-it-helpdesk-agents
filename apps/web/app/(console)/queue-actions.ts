"use server";

import { revalidatePath } from "next/cache";
import {
  actorString,
  appendEvent,
  bulkUpdateTickets,
  notifyAssignment,
  notifyResolution,
  type TicketStatus,
} from "@hd/core";
import { requireConsole } from "../../lib/auth";

/**
 * Bulk actions from the queue.
 *
 * The `businessId` argument is gone. It used to be passed from the client
 * component that rendered the table, which meant a bulk update's tenant came
 * from the browser — the exact shape this phase exists to remove. It now comes
 * from the session, and `bulkUpdateTickets` checks the permission and scopes the
 * `where` clause itself.
 *
 * Every ticket touched still gets its own event, because "who assigned these
 * forty tickets to me and why" has to be answerable from the log like anything
 * else. A bulk action that writes one summary row and nothing per ticket is a
 * hole in the audit trail. Only the tickets that actually changed, though: an
 * event or an email about a ticket the update skipped would be a record of
 * something that did not happen.
 */
export async function bulkAssign(
  ticketIds: string[],
  staffId: string | null,
): Promise<number> {
  const { ctx } = await requireConsole();
  const changed = await bulkUpdateTickets(ctx, ticketIds, { assigned_to: staffId });
  await Promise.all(
    changed.map((id) =>
      appendEvent(ctx, {
        ticket_id: id,
        actor: actorString(ctx),
        kind: "note",
        payload: {
          stage: "assignment",
          assigned_to: staffId,
          bulk: changed.length > 1,
        },
      }),
    ),
  );

  // Tell the person. A queue is a pull model and assignment is a push, so
  // without this the only way to find out that four tickets are now yours is
  // to go and look — which is exactly what the assignment was meant to save.
  // One email per ticket up to a handful, then a digest, because a bulk
  // reassignment is one decision and forty emails about it teaches people to
  // filter this system's mail.
  await notifyAssignment(ctx, { ticketIds: changed, staffId });

  revalidatePath("/");
  return changed.length;
}

/**
 * `bulkUpdateTickets` moves each ticket through `setStatus`, so a bulk close
 * needs `ticket:close` exactly as a single one does, and the SLA clock and
 * `resolved_at` move the same way they would from the ticket page.
 */
export async function bulkStatus(
  ticketIds: string[],
  status: TicketStatus,
): Promise<number> {
  const { ctx } = await requireConsole();
  const changed = await bulkUpdateTickets(ctx, ticketIds, { status });
  await Promise.all(
    changed.map((id) =>
      appendEvent(ctx, {
        ticket_id: id,
        actor: actorString(ctx),
        kind: "status_change",
        payload: { status, source: "bulk", bulk: changed.length > 1 },
      }),
    ),
  );

  // Resolving in bulk still tells each requester about their own ticket: one
  // message each, and skipped for anybody who has just had a reply. There is
  // no digest here on purpose — a requester has one ticket in the batch, and a
  // covering note about somebody else's tickets would be a disclosure.
  if (status === "resolved") {
    for (const id of changed) {
      await notifyResolution(ctx, { ticketId: id });
    }
  }

  revalidatePath("/");
  return changed.length;
}
