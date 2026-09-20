import { systemContext, type TenantContext } from "../auth/context.js";
import { ticketUrl } from "../links.js";
import { getSettings, listBusinesses } from "../repos/businesses.js";
import { appendEvent } from "../repos/events.js";
import { queueAddresses, ticketsNearingSla } from "../repos/notifications.js";
import { recordSlaBreaches, ticketsWithUnrecordedBreaches } from "../repos/tickets.js";
import { notifyAll, type NotifyResult } from "./notify.js";

/**
 * The SLA warning sweep.
 *
 * A clock cannot notify anybody by itself, so something has to look. This runs
 * every few minutes, asks each tenant which of its open tickets are inside the
 * last slice of their window, and writes to whoever can do something about it.
 *
 * Two decisions worth naming.
 *
 * **Once per clock, for ever.** The dedupe key is the ticket and the clock, not
 * the hour, so a ticket sitting at 19% of its window left for three hours
 * produces one email rather than thirty-six. The queue is where somebody
 * watches a slipping deadline; the email is there to make them look at the
 * queue once.
 *
 * **The assignee, or the queue, or nobody.** An unassigned ticket has no
 * individual to warn, and picking an arbitrary person would make the warning
 * somebody else's problem to ignore. It goes to the staff watching the default
 * queue instead, and when that is empty the ticket records that the warning
 * reached nobody — which is a fact worth having when the breach is reviewed.
 */

export interface SlaSweepSummary {
  tenants: number;
  checked: number;
  sent: number;
  skipped: number;
  nobody: number;
}

export async function sweepSlaWarnings(): Promise<SlaSweepSummary> {
  const summary: SlaSweepSummary = {
    tenants: 0,
    checked: 0,
    sent: 0,
    skipped: 0,
    nobody: 0,
  };

  for (const business of await listBusinesses()) {
    const tenant = systemContext(business.id, { requestId: "sla-warning-sweep" });
    // One tenant's failure is that tenant's. It used to abort the loop, so a
    // bad row in the first business silenced every warning for the rest.
    let one: Awaited<ReturnType<typeof warnNearingSla>>;
    try {
      one = await warnNearingSla(tenant);
    } catch (err) {
      console.error(`[sla] warning sweep failed for ${business.id}`, err);
      continue;
    }
    summary.tenants += 1;
    summary.checked += one.checked;
    summary.sent += one.sent;
    summary.skipped += one.skipped;
    summary.nobody += one.nobody;
  }

  return summary;
}

/** One tenant's worth, so a caller with a context can run it on its own. */
export async function warnNearingSla(
  ctx: TenantContext,
): Promise<{ checked: number; sent: number; skipped: number; nobody: number }> {
  const settings = await getSettings(ctx.businessId);
  const policy = settings.notifications;

  // Checked before the query rather than after it: a tenant that has switched
  // these off should not be paying for the scan.
  if (!policy.enabled || !policy.sla_warning) {
    return { checked: 0, sent: 0, skipped: 0, nobody: 0 };
  }

  // The share of the window lives in `computeSla` now, stamped onto the ticket
  // as `*_warn_at`, so this sweep asks "which tickets have reached their
  // warning point" rather than recomputing what that point is. The policy flag
  // above still decides whether to ask at all.
  const due = await ticketsNearingSla(ctx);
  let sent = 0;
  let skipped = 0;
  let nobody = 0;

  for (const row of due) {
    const targets = row.assignee_email
      ? [{ email: row.assignee_email, name: row.assignee_name }]
      : (await queueAddresses(ctx, settings.routing.default_queue)).map((s) => ({
          email: s.email,
          name: s.full_name,
        }));

    const fallback =
      targets.length === 0 && policy.ops_address
        ? [{ email: policy.ops_address, name: null }]
        : targets;

    if (fallback.length === 0) {
      nobody += 1;
      await appendEvent(ctx, {
        ticket_id: row.ticket_id,
        actor: "system",
        kind: "note",
        payload: {
          stage: "notification",
          notification: "sla_warning",
          clock: row.clock,
          minutes_left: row.minutes_left,
          skipped: "nobody to notify",
          note: "Unassigned, no staff on the default queue, and no ops address.",
        },
      });
      continue;
    }

    const results: NotifyResult[] = await notifyAll(ctx, {
      payload: {
        kind: "sla_warning",
        ticket: {
          id: row.ticket_id,
          subject: row.subject,
          priority: row.priority,
          category: row.category,
          status: row.status,
        },
        clock: row.clock,
        dueAt: new Date(row.due_at),
        minutesLeft: row.minutes_left,
        timezone: settings.business_hours.tz,
        ticketUrl: ticketUrl(row.ticket_id),
      },
      to: fallback,
      ticketId: row.ticket_id,
      // Once per ticket per clock, whatever the sweep interval is.
      dedupeKey: `sla_warning:${row.ticket_id}:${row.clock}`,
    });

    for (const result of results) {
      if (result.sent) sent += 1;
      else skipped += 1;
    }
  }

  return { checked: due.length, sent, skipped, nobody };
}

/**
 * The breach sweep.
 *
 * Every clock writer records the breaches it sees before it changes anything,
 * but a clock can breach while nobody writes to its ticket. This finds those
 * clocks and records them, so a breach is on the record within one sweep of
 * its deadline whether or not anybody touches the ticket.
 *
 * It is also the backfill. Tickets that breached before breaches were recorded
 * at all, open or closed, are candidates until they are recorded, so the first
 * sweeps after a deploy record them through the same `slaStatus` the console
 * reads, with an `sla_breach` event each.
 *
 * It sends nothing. A breach notification is a separate decision about who
 * should be told; this only makes the breach a fact that one could be sent
 * about.
 */

export interface SlaBreachSweepSummary {
  tenants: number;
  checked: number;
  recorded: number;
  failed: number;
}

export async function sweepSlaBreaches(): Promise<SlaBreachSweepSummary> {
  const summary: SlaBreachSweepSummary = { tenants: 0, checked: 0, recorded: 0, failed: 0 };

  for (const business of await listBusinesses()) {
    const tenant = systemContext(business.id, { requestId: "sla-breach-sweep" });
    let one: Awaited<ReturnType<typeof recordDueBreaches>>;
    try {
      one = await recordDueBreaches(tenant);
    } catch (err) {
      console.error(`[sla] breach sweep failed for ${business.id}`, err);
      continue;
    }
    summary.tenants += 1;
    summary.checked += one.checked;
    summary.recorded += one.recorded;
    summary.failed += one.failed;
  }

  return summary;
}

/**
 * One tenant's worth, so a caller with a context can run it on its own.
 *
 * Each ticket is its own transaction under its row lock, so a sweep and a
 * console write to the same ticket take turns, and a sweep that overlaps the
 * previous one records nothing twice. One ticket that fails is logged and
 * skipped. It would otherwise stop every later candidate, and the order is
 * stable, so it would stop the same ones on every run.
 */
export async function recordDueBreaches(
  ctx: TenantContext,
  limit = 200,
): Promise<{ checked: number; recorded: number; failed: number }> {
  const ids = await ticketsWithUnrecordedBreaches(ctx, limit);
  let recorded = 0;
  let failed = 0;

  for (const id of ids) {
    try {
      recorded += (await recordSlaBreaches(ctx, id)).length;
    } catch (err) {
      failed += 1;
      console.error(`[sla] could not record a breach on ${id}`, err);
    }
  }

  return { checked: ids.length, recorded, failed };
}
