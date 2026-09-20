import { describeActor, type TenantContext } from "../auth/context.js";
import { approvalsUrl, portalUrl, ticketUrl } from "../links.js";
import { getSettings } from "../repos/businesses.js";
import { appendEvent } from "../repos/events.js";
import {
  approverAddresses,
  queueAddresses,
  requesterIdForTicket,
  staffAddress,
  ticketBriefs,
} from "../repos/notifications.js";
import { recentReplyExists } from "../repos/outbound.js";
import { env } from "../env.js";
import { notify, notifyAll, type NotifyResult } from "./notify.js";
import type { TicketBrief } from "./catalogue.js";

/**
 * The five moments that produce a notification.
 *
 * One function per moment, each owning the awkward part of that moment: which
 * of several possible recipients is the right one, whether a second message
 * would be redundant, and what to write on the ticket when there was nobody to
 * tell. The callers — a console action, the escalation tool, the pipeline, the
 * worker's sweep — hand over what happened and read a result.
 *
 * None of them throw. A notification that cannot be sent must never take down
 * the operation that caused it: an assignment that works and emails nobody is a
 * missing email, and an assignment that fails because an email could not be
 * queued is a broken helpdesk.
 */

const QUEUE_URL = () => `${env.APP_BASE_URL.replace(/\/+$/, "")}/`;

export interface NotifySummary {
  results: NotifyResult[];
  /** True when there was nobody to write to at all. */
  nobody: boolean;
}

function summarize(results: NotifyResult[], nobody = false): NotifySummary {
  return { results, nobody };
}

/**
 * A ticket, or several, were assigned to somebody.
 *
 * One email per ticket up to a point, then a digest. The threshold exists
 * because a bulk reassignment of forty tickets is one decision, and forty
 * emails about it is how somebody learns to filter this system's mail into a
 * folder they never read. Above the threshold the individual tickets are still
 * in the queue and still in each ticket's event log; what changes is that the
 * person gets one covering note instead of a morning of pings.
 */
const DIGEST_ABOVE = 3;

export async function notifyAssignment(
  ctx: TenantContext,
  input: { ticketIds: string[]; staffId: string | null },
): Promise<NotifySummary> {
  try {
    // Unassigning is not an event anybody needs an email about: nothing is
    // being asked of the person losing it, and the person gaining it is the
    // agent.
    if (!input.staffId || input.ticketIds.length === 0) return summarize([]);

    const staff = await staffAddress(ctx, input.staffId);
    if (!staff) return summarize([], true);

    const tickets = await ticketBriefs(ctx, input.ticketIds);
    if (tickets.length === 0) return summarize([]);

    const payloadFor = (batch: TicketBrief[]) =>
      ({
        kind: "assignment" as const,
        tickets: batch,
        // A person is named; the system is not. `describeActor` returns
        // "system" for a job, and "system assigned this to you" reads like a
        // bug report about the system.
        assignedBy: ctx.actorType === "human" ? describeActor(ctx) : null,
        ticketUrl,
        queueUrl: QUEUE_URL(),
      });

    if (tickets.length > DIGEST_ABOVE) {
      const result = await notify(ctx, {
        payload: payloadFor(tickets),
        to: { email: staff.email, name: staff.full_name },
        // The digest is about the batch, not about one ticket, so it hangs off
        // no ticket and dedupes on the set it covers.
        ticketId: null,
        dedupeKey: `assignment:digest:${staff.email}:${digestFingerprint(tickets)}`,
      });
      return summarize([result]);
    }

    const results: NotifyResult[] = [];
    for (const ticket of tickets) {
      results.push(
        await notify(ctx, {
          payload: payloadFor([ticket]),
          to: { email: staff.email, name: staff.full_name },
          ticketId: ticket.id,
        }),
      );
    }
    return summarize(results);
  } catch (err) {
    console.error("[notify] assignment failed", err);
    return summarize([]);
  }
}

function digestFingerprint(tickets: TicketBrief[]): string {
  return `${tickets.length}:${tickets
    .map((t) => t.id.slice(0, 8))
    .sort()
    .join("")
    .slice(0, 40)}`;
}

/**
 * The agent handed a ticket to a queue.
 *
 * Goes to everybody watching that queue, because an escalation addressed to
 * nobody in particular is how a ticket sits untouched for a day. When the queue
 * has no staff the tenant's ops address is the fallback, and when there is no
 * ops address either the ticket says so — an escalation that reached nobody is
 * worth recording, since the agent has by then stopped working on it.
 */
export async function notifyEscalation(
  ctx: TenantContext,
  input: {
    ticketId: string;
    queue: string;
    reason: string;
    summary: string;
    suggestedFix: string | null;
  },
): Promise<NotifySummary> {
  try {
    const [ticket] = await ticketBriefs(ctx, [input.ticketId]);
    if (!ticket) return summarize([]);

    const settings = await getSettings(ctx.businessId);
    const staff = await queueAddresses(ctx, input.queue);
    const targets = staff.length
      ? staff.map((s) => ({ email: s.email, name: s.full_name }))
      : settings.notifications.ops_address
        ? [{ email: settings.notifications.ops_address, name: null }]
        : [];

    if (targets.length === 0) {
      await noteNobody(ctx, input.ticketId, "escalation", input.queue);
      return summarize([], true);
    }

    return summarize(
      await notifyAll(ctx, {
        payload: {
          kind: "escalation",
          ticket,
          queue: input.queue,
          reason: input.reason,
          summary: input.summary,
          suggestedFix: input.suggestedFix,
          ticketUrl: ticketUrl(ticket.id),
        },
        to: targets,
        ticketId: ticket.id,
      }),
    );
  } catch (err) {
    console.error("[notify] escalation failed", err);
    return summarize([]);
  }
}

/**
 * The agent asked for authorization.
 *
 * This is the notification the roadmap called out by name: the approval queue
 * has had a deadline since 0009 and nobody was told about it, so a request
 * raised at 5pm expired overnight and read, from the ticket, exactly like a
 * refusal. Dedupes on the approval id — one request, one email, however many
 * times the pipeline is re-run.
 */
export async function notifyApprovalRequest(
  ctx: TenantContext,
  input: {
    approvalId: string;
    ticketId: string;
    tool: string;
    summary: string;
    rationale: string;
    riskTier: string;
    expiresAt: Date | null;
  },
): Promise<NotifySummary> {
  try {
    const [ticket] = await ticketBriefs(ctx, [input.ticketId]);
    if (!ticket) return summarize([]);

    const settings = await getSettings(ctx.businessId);
    const approvers = await approverAddresses(ctx);
    const targets = approvers.length
      ? approvers.map((a) => ({ email: a.email, name: a.full_name }))
      : settings.notifications.ops_address
        ? [{ email: settings.notifications.ops_address, name: null }]
        : [];

    if (targets.length === 0) {
      await noteNobody(ctx, input.ticketId, "approval", input.tool);
      return summarize([], true);
    }

    return summarize(
      await notifyAll(ctx, {
        payload: {
          kind: "approval",
          ticket,
          tool: input.tool,
          summary: input.summary,
          rationale: input.rationale,
          riskTier: input.riskTier,
          expiresAt: input.expiresAt,
          timezone: settings.business_hours.tz,
          approvalsUrl: approvalsUrl(),
        },
        to: targets,
        ticketId: ticket.id,
        dedupeKey: `approval:${input.approvalId}`,
      }),
    );
  } catch (err) {
    console.error("[notify] approval failed", err);
    return summarize([]);
  }
}

/** How recently a reply has to have gone out for the resolution notice to be redundant. */
const REPLY_WINDOW_MINUTES = 15;

/**
 * A person resolved the ticket.
 *
 * Skipped when the requester has just been written to, because the most
 * irritating pair of emails this system could send is "that should be fixed
 * now, let me know" followed immediately by "your ticket has been resolved".
 * The agent's own resolutions are already announced by the reply that resolved
 * them, so this exists for the case the transport could not previously cover: a
 * human closing a ticket they fixed by walking over to somebody's desk.
 */
export async function notifyResolution(
  ctx: TenantContext,
  input: { ticketId: string },
): Promise<NotifySummary> {
  try {
    const [ticket] = await ticketBriefs(ctx, [input.ticketId]);
    if (!ticket?.requester_email) return summarize([], true);

    if (await recentReplyExists(ctx, ticket.id, REPLY_WINDOW_MINUTES)) {
      return summarize([]);
    }

    const settings = await getSettings(ctx.businessId);
    const requesterId = await requesterIdForTicket(ctx, ticket.id);

    return summarize([
      await notify(ctx, {
        payload: {
          kind: "resolution",
          ticket,
          resolvedBy: ctx.actorType === "human" ? describeActor(ctx) : null,
          signature: settings.signature,
          portalUrl: requesterId ? portalUrl(requesterId) : null,
        },
        to: { email: ticket.requester_email, name: null },
        ticketId: ticket.id,
      }),
    ]);
  } catch (err) {
    console.error("[notify] resolution failed", err);
    return summarize([]);
  }
}

async function noteNobody(
  ctx: TenantContext,
  ticketId: string,
  kind: string,
  detail: string,
): Promise<void> {
  await appendEvent(ctx, {
    ticket_id: ticketId,
    actor: "system",
    kind: "note",
    payload: {
      stage: "notification",
      notification: kind,
      detail,
      skipped: "nobody to notify",
      note: "No active staff for the queue and no ops address configured.",
    },
  });
}
