"use server";

import { revalidatePath } from "next/cache";
import {
  actorString,
  appendEvent,
  appendMessage,
  audit,
  enqueueTriage,
  enqueueWriteback,
  getSettings,
  getTicket,
  markFirstResponse,
  mergeTicket,
  NotFoundError,
  notifyResolution,
  overrideClassification,
  reconcileShadow,
  requirePermission,
  setStatus,
  TicketPriority,
  type TenantContext,
  type TicketStatus,
} from "@hd/core";
import { executeTool } from "@hd/tools";
import { requireConsole } from "../../../../lib/auth";

/**
 * Human actions from the review queue.
 *
 * Every function here begins with `requireConsole()`, which is the whole point
 * of this phase. There used to be a module constant:
 *
 *     const HUMAN = "human:console";
 *
 * and every event these actions wrote was attributed to it. That string cannot
 * be revoked, cannot be scoped to a tenant, and cannot be asked about
 * afterwards — "who sent this reply" had no answer beyond "somebody with the
 * URL". The actor is now the signed-in user, the tenant is the session's, and
 * a ticket id belonging to another business simply does not resolve.
 */

/**
 * Send the agent's draft, as the person reviewing it wrote it in the end.
 *
 * The reply is theirs, and `draftId` says which draft it came from, so the
 * conversation keeps what the agent proposed next to what was sent (C6 in
 * docs/conversation.md). The edits are the signal of whether drafts are usable.
 */
export async function sendDraft(
  ticketId: string,
  body: string,
  draftId: string | null = null,
): Promise<void> {
  const { ctx } = await requireConsole();
  // Sending a reply is contacting a person outside the company, so it needs
  // more than `ticket:read` — a viewer who can see the draft cannot send it.
  requirePermission(ctx, "action:execute");

  const ticket = await getTicket(ctx, ticketId);
  if (!ticket) throw new NotFoundError("ticket");

  await sendAsPerson(ctx, ticketId, {
    body,
    close_after: true,
    ...(draftId ? { derived_from_id: draftId } : {}),
  });
  await enqueueWriteback(ticketId).catch(() => {});
  revalidatePath(`/tickets/${ticketId}`);
}

/**
 * A reply written in the console, not from a draft.
 *
 * `nonce` is minted when the form renders, so a double submit is one email and
 * one message (C8).
 */
export async function replyFromForm(ticketId: string, formData: FormData): Promise<void> {
  const { ctx } = await requireConsole();
  requirePermission(ctx, "action:execute");

  const body = String(formData.get("body") ?? "").trim();
  if (!body) return;
  const ticket = await getTicket(ctx, ticketId);
  if (!ticket) throw new NotFoundError("ticket");

  const resolve = formData.get("resolve") === "on";
  await sendAsPerson(ctx, ticketId, {
    body,
    close_after: resolve,
    idempotency_key: `console:${nonceOf(formData)}`,
  });
  if (resolve) await enqueueWriteback(ticketId).catch(() => {});
  revalidatePath(`/tickets/${ticketId}`);
}

/**
 * An internal note: for the desk, never for the requester (C5).
 *
 * `appendMessage` takes the author from the session and checks
 * `ticket:update` and `ticket_internal:read` itself, so nothing here can make a
 * note appear to come from somebody else.
 */
export async function addNote(ticketId: string, formData: FormData): Promise<void> {
  const { ctx } = await requireConsole();

  const body = String(formData.get("body") ?? "").trim();
  if (!body) return;

  await appendMessage(ctx, ticketId, {
    visibility: "internal",
    channel: "console",
    body,
    idempotencyKey: `note:${nonceOf(formData)}`,
  });
  revalidatePath(`/tickets/${ticketId}`);
}

async function sendAsPerson(
  ctx: TenantContext,
  ticketId: string,
  args: Record<string, unknown>,
): Promise<void> {
  const settings = await getSettings(ctx.businessId);
  await executeTool("ticket.send_reply", args, { tenant: ctx, ticketId }, {
    whitelist: [...settings.auto_action_whitelist, "ticket.send_reply"],
    agent: "helpdesk",
    rationale: "Reviewed and sent by a human from the console",
  });
  await markFirstResponse(ctx, ticketId);
}

/** The form's own id, minted when it rendered. A form without one is refused. */
function nonceOf(formData: FormData): string {
  const nonce = String(formData.get("nonce") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(nonce)) throw new Error("this form is missing its id; reload the page");
  return nonce;
}

/**
 * A tri-state label. `null` means the reviewer did not say, and it has to stay
 * distinguishable from "they said no": the safety gate reports an unlabelled
 * slice as unmeasured, and folding "did not say" into `false` would turn a
 * gate nobody has checked into a gate that reads as passing.
 */
function parseTriState(raw: FormDataEntryValue | null): boolean | null {
  const v = raw === null ? "" : String(raw);
  if (v === "yes") return true;
  if (v === "no") return false;
  return null;
}

/** The console's reclassify form, which also carries the safety slice labels. */
export async function overrideTriageFromForm(
  ticketId: string,
  formData: FormData,
): Promise<void> {
  await overrideTriage(
    ticketId,
    String(formData.get("category")),
    String(formData.get("priority")),
    {
      security: parseTriState(formData.get("security_sensitive")),
      destructive: parseTriState(formData.get("destructive")),
    },
  );
}

export async function overrideTriage(
  ticketId: string,
  category: string,
  priority: string,
  safety: { security?: boolean | null; destructive?: boolean | null } = {},
): Promise<void> {
  const { ctx } = await requireConsole();
  const parsedPriority = TicketPriority.parse(priority);

  const ticket = await getTicket(ctx, ticketId);
  if (!ticket) throw new NotFoundError("ticket");

  // `agent:override` rather than `ticket:update`: this writes the ground truth
  // the thresholds are later set from, so who wrote it matters.
  await overrideClassification(ctx, ticketId, {
    category,
    priority: parsedPriority,
  });

  // Ground truth for the calibration table.
  await reconcileShadow(ctx, {
    ticket_id: ticketId,
    human_category: category,
    human_priority: parsedPriority,
    human_path: ticket.resolution_path,
    human_security_sensitive: safety.security ?? null,
    human_destructive: safety.destructive ?? null,
  });

  await appendEvent(ctx, {
    ticket_id: ticketId,
    actor: actorString(ctx),
    kind: "triage",
    payload: {
      source: "human_override",
      from: { category: ticket.category, priority: ticket.priority },
      to: { category, priority: parsedPriority },
    },
  });

  // The classification drives autonomy, so a correction belongs in the audit
  // trail as well as the ticket's own timeline.
  await audit(ctx, {
    action: "ticket.update",
    resource_type: "ticket",
    resource_id: ticketId,
    old_value: { category: ticket.category, priority: ticket.priority },
    new_value: { category, priority: parsedPriority },
    reason: "human triage override",
  });

  revalidatePath(`/tickets/${ticketId}`);
}

/**
 * Confirms the agent got it right. Same ground truth, cheaper to click.
 *
 * Deliberately says nothing about the safety flags. Copying the agent's own
 * flags across on a one-click confirm would record a human endorsement of two
 * booleans the human was never asked about, and the safety slice is the one
 * place where collected agreement is worth less than no data at all. They are
 * labelled explicitly on the correction form or not at all.
 */
export async function confirmTriage(ticketId: string): Promise<void> {
  const { ctx } = await requireConsole();
  requirePermission(ctx, "agent:override");

  const ticket = await getTicket(ctx, ticketId);
  if (!ticket?.category || !ticket.priority) throw new Error("ticket is not triaged");

  await reconcileShadow(ctx, {
    ticket_id: ticketId,
    human_category: ticket.category,
    human_priority: ticket.priority,
    human_path: ticket.resolution_path,
  });
  await appendEvent(ctx, {
    ticket_id: ticketId,
    actor: actorString(ctx),
    kind: "triage",
    payload: {
      source: "human_confirm",
      category: ticket.category,
      priority: ticket.priority,
    },
  });
  revalidatePath(`/tickets/${ticketId}`);
}

export async function changeStatus(
  ticketId: string,
  status: TicketStatus,
): Promise<void> {
  const { ctx } = await requireConsole();
  // `setStatus` picks the permission from the status: closing and reopening are
  // separate decisions from an ordinary update.
  await setStatus(ctx, ticketId, status);
  await appendEvent(ctx, {
    ticket_id: ticketId,
    actor: actorString(ctx),
    kind: "status_change",
    payload: { status, source: "console" },
  });
  if (status === "resolved") {
    await enqueueWriteback(ticketId).catch(() => {});
    // The case the transport could not cover before: somebody fixes a laptop at
    // the desk and closes the ticket, and the requester is told nothing. Skipped
    // when a reply has just gone out, because "that should be fixed now" followed
    // by "your ticket has been resolved" is the most irritating pair of emails
    // this system could send.
    await notifyResolution(ctx, { ticketId });
  }
  revalidatePath(`/tickets/${ticketId}`);
}

/**
 * Merge this ticket into another. A human decides: `duplicateCandidates`
 * proposes on same requester, same category, opened close together, and that
 * is a heuristic, not a judgement. Two "printer broken" tickets an hour apart
 * can easily be two printers.
 *
 * Both ids are checked against the session's tenant inside `mergeTicket`, so a
 * hand-edited target id is a "not found" rather than a way to discover whether
 * a uuid in another business exists.
 */
export async function mergeInto(sourceId: string, targetId: string): Promise<void> {
  const { ctx } = await requireConsole();
  const result = await mergeTicket(ctx, sourceId, targetId);
  revalidatePath(`/tickets/${sourceId}`);
  revalidatePath(`/tickets/${result.targetId}`);
  revalidatePath("/");
}

export async function retriage(ticketId: string): Promise<void> {
  const { ctx } = await requireConsole();
  requirePermission(ctx, "agent:override");

  // Confirms the ticket is ours before queueing a job that will act on it.
  const ticket = await getTicket(ctx, ticketId);
  if (!ticket) throw new NotFoundError("ticket");

  await enqueueTriage(ticketId, { force: true });
  await appendEvent(ctx, {
    ticket_id: ticketId,
    actor: actorString(ctx),
    kind: "note",
    payload: { stage: "retriage_requested" },
  });
  revalidatePath(`/tickets/${ticketId}`);
}
