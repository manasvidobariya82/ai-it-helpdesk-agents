"use server";

import { revalidatePath } from "next/cache";
import {
  cancelOutbound,
  enqueueOutbound,
  getOutbound,
  NotFoundError,
  retryOutbound,
  unsuppressAddress,
} from "@hd/core";
import { requireConsole } from "../../../lib/auth";

/**
 * Operator actions on outbound mail.
 *
 * Each one begins with `requireConsole()`, so the tenant is the session's and
 * the actor written to the delivery history and the audit log is the signed-in
 * user. The permission checks live in the repository functions — `action:execute`
 * for all three — because "who may cause an email to be sent" is the same
 * question whether it is asked here or by the agent.
 */

/** Send a dead letter again. Gives it a fresh attempt budget, and is audited. */
export async function retryDelivery(id: string): Promise<void> {
  const { ctx } = await requireConsole();
  const message = await retryOutbound(ctx, id);
  if (!message) {
    throw new NotFoundError(
      "outbound_message",
      "This message is not in a state that can be retried.",
    );
  }
  // The sweep would find it within half a minute anyway; the enqueue is so the
  // person who clicked the button does not have to wait for the sweep.
  await enqueueOutbound(message.id, { attempt: message.attempts }).catch(() => {});
  revalidatePath("/mail");
  if (message.ticket_id) revalidatePath(`/tickets/${message.ticket_id}`);
}

/** Stop a message that has not gone out yet. */
export async function cancelDelivery(id: string, reason: string): Promise<void> {
  const { ctx } = await requireConsole();
  const message = await getOutbound(ctx, id);
  if (!message) throw new NotFoundError("outbound_message");

  const cancelled = await cancelOutbound(
    ctx,
    id,
    reason.trim() || "cancelled from the console",
  );
  if (!cancelled) {
    throw new Error(
      `This message is already ${message.status}; there is nothing left to cancel.`,
    );
  }
  revalidatePath("/mail");
  if (message.ticket_id) revalidatePath(`/tickets/${message.ticket_id}`);
}

/**
 * Write to a suppressed address again.
 *
 * The reason is required, not decorative. The address is on the list because a
 * mail server said the mailbox is gone or a person said they did not want our
 * mail, and overriding either is a decision somebody may have to answer for —
 * so it is refused without a reason rather than recorded without one.
 */
export async function liftSuppression(email: string, reason: string): Promise<void> {
  const { ctx } = await requireConsole();
  const why = reason.trim();
  if (why.length < 4) {
    throw new Error(
      "Say why this address should receive mail again. It was suppressed by a bounce or a complaint.",
    );
  }
  const lifted = await unsuppressAddress(ctx, email, why);
  if (!lifted) throw new NotFoundError("email_suppression");
  revalidatePath("/mail");
}
