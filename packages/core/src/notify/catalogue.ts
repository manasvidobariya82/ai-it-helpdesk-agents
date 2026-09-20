import { subjectTag } from "../repos/threading.js";
import type { NotificationKind } from "../types.js";
import type { NotificationPolicy } from "../settings.js";

/**
 * What each notification says.
 *
 * Templates, not a template engine. Five messages do not need one, and the
 * thing that makes a notification useful is not its formatting — it is whether
 * the first line answers "why am I being emailed" and whether the facts the
 * reader needs in order to act are above the link. Every one of these is
 * written to be legible in a phone's notification preview: the subject carries
 * the ticket tag and the point, in that order.
 *
 * Pure, and therefore testable. The sender adds the footer, resolves the
 * recipients and decides whether the message is wanted at all.
 */

export interface TicketBrief {
  id: string;
  subject: string;
  priority: string | null;
  category: string | null;
  status: string;
  requester_email?: string | null;
}

export type NotificationPayload =
  | {
      kind: "assignment";
      /** One ticket, or several from a bulk assignment. */
      tickets: TicketBrief[];
      assignedBy: string | null;
      ticketUrl: (id: string) => string;
      queueUrl: string;
    }
  | {
      kind: "sla_warning";
      ticket: TicketBrief;
      clock: "first_response" | "resolution";
      dueAt: Date;
      minutesLeft: number;
      timezone: string;
      ticketUrl: string;
    }
  | {
      kind: "escalation";
      ticket: TicketBrief;
      queue: string;
      reason: string;
      summary: string;
      suggestedFix: string | null;
      ticketUrl: string;
    }
  | {
      kind: "approval";
      ticket: TicketBrief;
      tool: string;
      summary: string;
      rationale: string;
      riskTier: string;
      expiresAt: Date | null;
      timezone: string;
      approvalsUrl: string;
    }
  | {
      kind: "resolution";
      ticket: TicketBrief;
      resolvedBy: string | null;
      signature: string;
      portalUrl: string | null;
    };

export interface RenderedNotification {
  subject: string;
  body: string;
}

/**
 * Who each kind is for, and which setting switches it off.
 *
 * `audience` is not decoration. A staff notification is a fresh message with a
 * console link in it; a requester notification is threaded onto the
 * conversation they are already having and must never contain a console URL,
 * because they cannot open one and being sent a link that asks you to log in is
 * worse than being sent nothing.
 */
export const NOTIFICATIONS: Record<
  NotificationKind,
  {
    audience: "staff" | "requester";
    setting: keyof NotificationPolicy;
    /** Why the reader is being emailed, for documentation and the console. */
    what: string;
    /** A noun for the unsubscribe footer: "Stop assignment emails". */
    label: string;
  }
> = {
  assignment: {
    audience: "staff",
    setting: "assignment",
    what: "a ticket was assigned to you",
    label: "assignment",
  },
  sla_warning: {
    audience: "staff",
    setting: "sla_warning",
    what: "an SLA clock is nearly out",
    label: "SLA warning",
  },
  escalation: {
    audience: "staff",
    setting: "escalation",
    what: "the agent handed a ticket to your queue",
    label: "escalation",
  },
  approval: {
    audience: "staff",
    setting: "approval",
    what: "the agent is waiting for authorization",
    label: "approval request",
  },
  resolution: {
    audience: "requester",
    setting: "resolution",
    what: "your ticket was resolved",
    label: "resolution",
  },
};

export function renderNotification(p: NotificationPayload): RenderedNotification {
  switch (p.kind) {
    case "assignment":
      return p.tickets.length === 1
        ? assignmentOne(p, p.tickets[0]!)
        : assignmentMany(p);
    case "sla_warning":
      return slaWarning(p);
    case "escalation":
      return escalation(p);
    case "approval":
      return approval(p);
    case "resolution":
      return resolution(p);
  }
}

// ---------------------------------------------------------------------------

function assignmentOne(
  p: Extract<NotificationPayload, { kind: "assignment" }>,
  ticket: TicketBrief,
): RenderedNotification {
  return {
    subject: `${subjectTag(ticket.id)} Assigned to you: ${ticket.subject}`,
    body: lines([
      // Named when a person did it, passive when the system did: "system
      // assigned this to you" reads like a bug report about the system.
      p.assignedBy
        ? `${p.assignedBy} assigned this ticket to you.`
        : "This ticket has been assigned to you.",
      "",
      `Subject:   ${ticket.subject}`,
      `Priority:  ${ticket.priority ?? "not triaged"}`,
      `Category:  ${ticket.category ?? "not triaged"}`,
      ticket.requester_email ? `Requester: ${ticket.requester_email}` : null,
      "",
      p.ticketUrl(ticket.id),
    ]),
  };
}

/**
 * The digest.
 *
 * A bulk reassignment of forty tickets is one decision, and forty emails about
 * it is how somebody learns to filter notifications from this system into a
 * folder they never open. The tickets are still individually in the queue and
 * individually in the event log; this is the covering note.
 */
function assignmentMany(
  p: Extract<NotificationPayload, { kind: "assignment" }>,
): RenderedNotification {
  const shown = p.tickets.slice(0, 10);
  const rest = p.tickets.length - shown.length;
  return {
    subject: `${p.tickets.length} tickets assigned to you`,
    body: lines([
      p.assignedBy
        ? `${p.assignedBy} assigned ${p.tickets.length} tickets to you.`
        : `${p.tickets.length} tickets have been assigned to you.`,
      "",
      ...shown.map(
        (t) => `  ${t.priority ?? "--"}  ${t.subject}  ${p.ticketUrl(t.id)}`,
      ),
      rest > 0 ? `  … and ${rest} more.` : null,
      "",
      `The whole queue: ${p.queueUrl}`,
    ]),
  };
}

function slaWarning(
  p: Extract<NotificationPayload, { kind: "sla_warning" }>,
): RenderedNotification {
  const which =
    p.clock === "first_response" ? "First response" : "Resolution";
  return {
    subject:
      `${subjectTag(p.ticket.id)} ${which} due in ${humanMinutes(p.minutesLeft)}` +
      ` — ${p.ticket.subject}`,
    body: lines([
      `${which} on this ticket is due in ${humanMinutes(p.minutesLeft)}, at ` +
        `${formatInZone(p.dueAt, p.timezone)}.`,
      "",
      `Subject:   ${p.ticket.subject}`,
      `Priority:  ${p.ticket.priority ?? "not triaged"}`,
      `Status:    ${p.ticket.status}`,
      p.ticket.requester_email ? `Requester: ${p.ticket.requester_email}` : null,
      "",
      p.ticketUrl,
      "",
      // Said plainly, because the alternative is somebody assuming the clock
      // stops when they open the ticket.
      p.clock === "first_response"
        ? "The clock stops when the requester hears from us, not when somebody reads the ticket."
        : "The clock stops when the ticket is resolved.",
    ]),
  };
}

function escalation(
  p: Extract<NotificationPayload, { kind: "escalation" }>,
): RenderedNotification {
  return {
    subject: `${subjectTag(p.ticket.id)} Escalated to ${p.queue}: ${p.ticket.subject}`,
    body: lines([
      `The agent stopped and handed this to ${p.queue}.`,
      "",
      `Why:       ${p.reason}`,
      `Priority:  ${p.ticket.priority ?? "not triaged"}`,
      p.ticket.requester_email ? `Requester: ${p.ticket.requester_email}` : null,
      "",
      "What it found:",
      indent(p.summary),
      p.suggestedFix ? "" : null,
      p.suggestedFix ? "Suggested fix (unverified — the agent did not do this):" : null,
      p.suggestedFix ? indent(p.suggestedFix) : null,
      "",
      p.ticketUrl,
    ]),
  };
}

function approval(
  p: Extract<NotificationPayload, { kind: "approval" }>,
): RenderedNotification {
  return {
    subject: `${subjectTag(p.ticket.id)} Approval needed: ${p.summary}`,
    body: lines([
      `The agent is waiting for authorization on ticket "${p.ticket.subject}".`,
      "",
      `Wants to:  ${p.summary}`,
      `Tool:      ${p.tool} (${p.riskTier})`,
      `Because:   ${p.rationale}`,
      p.expiresAt
        ? `Expires:   ${formatInZone(p.expiresAt, p.timezone)}`
        : "Expires:   unknown, which means it is already treated as expired",
      "",
      p.approvalsUrl,
      "",
      // The deadline is the reason this notification exists at all: an approval
      // nobody is told about lapses unread, and from the ticket's point of view
      // that is indistinguishable from a rejection.
      "Nothing happens until somebody decides. If it expires it has to be raised again.",
    ]),
  };
}

/**
 * The one message here that goes to a person outside the company.
 *
 * Threaded onto their existing conversation by the sender, so it arrives in the
 * same place as everything else about this ticket, and it says how to reopen —
 * "if this is not fixed, reply" is the whole of the escape hatch, and a
 * resolution notice without one is a system telling somebody they are finished.
 */
function resolution(
  p: Extract<NotificationPayload, { kind: "resolution" }>,
): RenderedNotification {
  return {
    subject: p.ticket.subject,
    body: lines([
      `Your ticket has been resolved${p.resolvedBy ? ` by ${p.resolvedBy}` : ""}.`,
      "",
      `Subject: ${p.ticket.subject}`,
      "",
      "If this is not actually fixed, reply to this email and the ticket reopens " +
        "with a person on it.",
      p.portalUrl ? "" : null,
      p.portalUrl ? `Your tickets: ${p.portalUrl}` : null,
      "",
      p.signature,
    ]),
  };
}

// ---------------------------------------------------------------------------

function lines(parts: (string | null)[]): string {
  return parts.filter((p): p is string => p !== null).join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}

/** "3 minutes", "2 hours", "1 day" — precision nobody needs is noise. */
export function humanMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 90) return `${m} minute${m === 1 ? "" : "s"}`;
  const hours = Math.round(m / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The due time in the tenant's own timezone.
 *
 * A deadline printed in UTC to somebody in Sydney is a deadline they have to do
 * arithmetic on, and the arithmetic is where the mistake happens.
 */
export function formatInZone(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).format(date);
  } catch {
    // An invalid tz in settings must not stop the mail going out.
    return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}
