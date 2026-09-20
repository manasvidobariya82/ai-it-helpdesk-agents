import {
  agentContext,
  appendEvent,
  env,
  eventsFor,
  getSettings,
  listBusinesses,
  setStatus,
  systemContext,
  ticketsAwaitingFollowup,
  type TenantContext,
  type Ticket,
} from "@hd/core";
import { writeBackResolution } from "./writeback.js";

export interface FollowupSummary {
  checked: number;
  closed: number;
  writtenBack: number;
  reopened: number;
}

/**
 * The 24-hour check.
 *
 * A ticket the agent resolved is not finished until the requester has had a
 * chance to say otherwise. Anything they replied to after the resolution is
 * treated as a reopen - that reopen count is the false-resolve rate, which is
 * the metric that erodes trust fastest when it climbs.
 */
export async function runFollowups(businessId: string): Promise<FollowupSummary> {
  // A scheduled sweep has no session behind it, so it runs as the agent in the
  // tenant it was asked to sweep. Every read and write below is then scoped by
  // that context rather than by the loop remembering to pass an id.
  const tenant = agentContext(businessId, { requestId: `followup:${businessId}` });
  const settings = await getSettings(businessId);
  const due = await ticketsAwaitingFollowup(tenant, settings.followup_hours);

  // Reopening is `ticket:reopen`, which the agent deliberately does not hold —
  // it is a manager's call when a person makes it. Here nobody is making it:
  // the requester replied, and the ticket reopens by rule, exactly as it does
  // when the reply arrives through intake. So that one transition runs as the
  // system. With the agent's context it threw, and because it threw on the
  // same ticket every fifteen minutes, nothing after it was ever closed.
  const system = systemContext(businessId, { requestId: `followup:${businessId}` });

  const summary: FollowupSummary = {
    checked: due.length,
    closed: 0,
    writtenBack: 0,
    reopened: 0,
  };

  for (const ticket of due) {
    try {
      await followUp(tenant, system, settings.followup_hours, ticket, summary);
    } catch (err) {
      // One ticket that cannot be processed must not hold up the rest.
      console.error(`[followup] ${ticket.id} failed`, err);
    }
  }

  return summary;
}

/**
 * Every tenant's follow-ups.
 *
 * The worker used to run `runFollowups` for the first business only, so on a
 * deployment with a second tenant that tenant's resolved tickets never closed
 * and never reached the knowledge base. The tenant list is read on every run,
 * so a business added while the worker is up is picked up without a restart.
 */
export async function runAllFollowups(): Promise<FollowupSummary> {
  const total: FollowupSummary = { checked: 0, closed: 0, writtenBack: 0, reopened: 0 };
  for (const business of await listBusinesses()) {
    try {
      const one = await runFollowups(business.id);
      total.checked += one.checked;
      total.closed += one.closed;
      total.writtenBack += one.writtenBack;
      total.reopened += one.reopened;
    } catch (err) {
      console.error(`[followup] tenant ${business.id} failed`, err);
    }
  }
  return total;
}

async function followUp(
  tenant: TenantContext,
  system: TenantContext,
  followupHours: number,
  ticket: Ticket,
  summary: FollowupSummary,
): Promise<void> {
  if (await requesterRepliedSinceResolution(tenant, ticket)) {
    await setStatus(system, ticket.id, "reopened");
    await appendEvent(tenant, {
      ticket_id: ticket.id,
      actor: "system",
      kind: "status_change",
      payload: {
        status: "reopened",
        reason: "requester replied after the agent marked it resolved",
      },
    });
    summary.reopened += 1;
    return;
  }

  await setStatus(tenant, ticket.id, "closed");
  await appendEvent(tenant, {
    ticket_id: ticket.id,
    actor: "system",
    kind: "status_change",
    payload: {
      status: "closed",
      reason: `no reply ${followupHours}h after resolution`,
    },
  });
  summary.closed += 1;

  // Only successful resolutions earn a knowledge base entry, and only when
  // the agent actually solved it rather than handing it to someone.
  if (
    env.AGENT_MODE !== "shadow" &&
    (ticket.resolution_path === "auto_reply" || ticket.resolution_path === "auto_action")
  ) {
    const result = await writeBackResolution(tenant, ticket.id).catch((err) => {
      console.error(`[followup] writeback failed for ${ticket.id}`, err);
      return { written: false } as const;
    });
    if (result.written) summary.writtenBack += 1;
  }
}

async function requesterRepliedSinceResolution(
  tenant: TenantContext,
  ticket: Ticket,
): Promise<boolean> {
  if (!ticket.resolved_at) return false;
  const events = await eventsFor(tenant, ticket.id);
  return events.some(
    (e) =>
      e.actor === "user" &&
      new Date(e.created_at).getTime() > new Date(ticket.resolved_at!).getTime(),
  );
}
