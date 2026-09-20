"use server";

import { revalidatePath } from "next/cache";
import {
  actorString,
  appendEvent,
  decideApproval,
  getSettings,
  recordApprovalOutcome,
  setStatus,
} from "@hd/core";
import { executeTool } from "@hd/tools";
import { requireConsole } from "../../../lib/auth";

/**
 * Approve and run, in that order, in one place.
 *
 * The approval row is what unlocks the risk gate in the tool registry: the
 * executor is handed the approval id, and without one a sensitive or
 * destructive tool refuses to run no matter who is asking.
 *
 * `decideApproval` now requires `action:approve` and scopes the update to the
 * session's tenant, so this is no longer "anyone who can reach /approvals can
 * approve anything whose id they can guess". The decision is written to
 * `audit_events` with the tool, the risk tier and the real actor.
 */
export async function approveAction(id: string, reason?: string): Promise<void> {
  const { ctx } = await requireConsole();

  // Throws ApprovalExpiredError if the window closed, which the console's
  // error boundary renders as a refusal rather than a crash. An approval that
  // lapsed has to be raised again, not revived: the situation it was asked
  // about has had time to move on.
  const request = await decideApproval(ctx, id, "approved", { reason });
  if (!request) throw new Error("approval is no longer pending");

  const settings = await getSettings(ctx.businessId);

  try {
    let result: unknown;
    try {
      result = await executeTool(
        request.tool_name,
        request.args,
        // The approval id is checked against the row — tenant, status, deadline
        // and the exact arguments — inside `executeTool`. Handing it over is not
        // the same as being trusted with it.
        { tenant: ctx, ticketId: request.ticket_id, approvalId: request.id },
        {
          whitelist: settings.auto_action_whitelist,
          agent: "helpdesk",
          rationale: request.rationale,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordApprovalOutcome(ctx, id, false, null, message);
      await appendEvent(ctx, {
        ticket_id: request.ticket_id,
        actor: actorString(ctx),
        kind: "error",
        payload: { stage: "approved_action", tool: request.tool_name, error: message },
      });
      // The ticket was parked in `awaiting_approval` for this request, and
      // there is nothing left to approve. Back to a person, the same as a
      // rejection, or it waits in a status nobody's queue is looking at.
      await setStatus(ctx, request.ticket_id, "triaged").catch((statusErr) =>
        console.error("[approvals] could not return the ticket to triage", statusErr),
      );
      throw err;
    }

    // Only the tool call is inside the failure branch above. Everything after
    // it is bookkeeping about an action that has already happened, and a
    // failure there used to fall into the same catch — marking an executed
    // (possibly destructive) action `failed` on the record.
    await recordApprovalOutcome(ctx, id, true, result, null);
    await appendEvent(ctx, {
      ticket_id: request.ticket_id,
      actor: actorString(ctx),
      kind: "approval",
      payload: { decision: "approved", tool: request.tool_name, result },
    });
    await setStatus(ctx, request.ticket_id, "in_progress");
  } finally {
    revalidatePath("/approvals");
    revalidatePath(`/tickets/${request.ticket_id}`);
  }
}

export async function rejectAction(id: string, reason?: string): Promise<void> {
  const { ctx } = await requireConsole();

  const request = await decideApproval(ctx, id, "rejected", { reason });
  if (!request) throw new Error("approval is no longer pending");

  await appendEvent(ctx, {
    ticket_id: request.ticket_id,
    actor: actorString(ctx),
    kind: "approval",
    payload: { decision: "rejected", tool: request.tool_name },
  });
  await setStatus(ctx, request.ticket_id, "triaged");
  revalidatePath("/approvals");
  revalidatePath(`/tickets/${request.ticket_id}`);
}
