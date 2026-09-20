import type pg from "pg";
import { query, queryOne, tx } from "../db.js";
import {
  NotFoundError,
  actorString,
  requirePermission,
  type TenantContext,
} from "../auth/context.js";
import type { Permission } from "../auth/permissions.js";
import {
  computeSla,
  shiftForFirstResponse,
  shiftForPause,
  slaStatus,
  stampForReopen,
  unrecordedBreaches,
  type SlaClock,
  type SlaShift,
} from "../sla.js";
import { getSettings } from "./businesses.js";
import type { BusinessSettings } from "../settings.js";
import type {
  InboundMessage,
  ResolutionPath,
  Ticket,
  TicketPriority,
  TicketStatus,
} from "../types.js";

export interface CreatedTicket {
  ticket: Ticket;
  /** False when intake deduplicated against an existing source_message_id. */
  created: boolean;
}

/**
 * Idempotent intake. Webhook retries and IMAP re-reads are normal, not
 * exceptional, so the unique index on (business_id, source, source_message_id)
 * does the work and we return the existing row instead of raising.
 */
export async function createTicketFromMessage(
  ctx: TenantContext,
  msg: InboundMessage,
  requesterId: string,
  assetId: string | null,
): Promise<CreatedTicket> {
  const inserted = await queryOne<Ticket>(
    `insert into tickets
       (business_id, source, source_message_id, requester_id, asset_id,
        subject, body, attachments, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     on conflict do nothing
     returning *`,
    [
      ctx.businessId,
      msg.source,
      msg.source_message_id,
      requesterId,
      assetId,
      msg.subject,
      msg.body,
      JSON.stringify(msg.attachments),
      msg.received_at,
    ],
  );
  if (inserted) return { ticket: inserted, created: true };

  // The dedupe index is per tenant, so the row that conflicted is this
  // tenant's. It used to be global, which made one email copied to two tenants
  // — or one API `external_id` two tenants both chose — a conflict with no
  // matching row here, and a 500. See 0016.
  const existing = await queryOne<Ticket>(
    `select * from tickets
      where source = $1 and source_message_id = $2 and business_id = $3`,
    [msg.source, msg.source_message_id, ctx.businessId],
  );
  if (!existing) {
    throw new Error(
      `intake conflict with no matching row (source=${msg.source}, id=${msg.source_message_id})`,
    );
  }
  return { ticket: existing, created: false };
}

/**
 * A ticket, scoped to the caller's tenant.
 *
 * The `business_id` predicate is the point. Before this, `getTicket(id)` would
 * happily return another tenant's ticket to anyone who could guess a uuid, and
 * every caller was one forgotten check away from a cross-tenant read.
 *
 * Returns null rather than throwing for a foreign id, so the caller cannot
 * distinguish "exists, not yours" from "does not exist" — that difference is an
 * enumeration oracle.
 */
export async function getTicket(
  ctx: TenantContext,
  id: string,
): Promise<Ticket | null> {
  requirePermission(ctx, "ticket:read");
  if (!isUuid(id)) return null;
  return queryOne<Ticket>(
    `select * from tickets where id = $1 and business_id = $2`,
    [id, ctx.businessId],
  );
}

/** Same row, for the worker and the pipeline, which resolve their own tenant. */
export async function getTicketUnscoped(id: string): Promise<Ticket | null> {
  if (!isUuid(id)) return null;
  return queryOne<Ticket>(`select * from tickets where id = $1`, [id]);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A malformed id is a 404, not a 500 from Postgres refusing the cast. */
export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

export interface TicketListFilters {
  status?: TicketStatus[];
  priority?: TicketPriority[];
  category?: string;
  path?: ResolutionPath[];
  search?: string;
  limit?: number;
  offset?: number;
}

export interface TicketListRow extends Ticket {
  requester_email: string | null;
  requester_name: string | null;
  requester_vip: boolean | null;
  assignee_name: string | null;
}

/**
 * The ticket list for one tenant.
 *
 * `business_id` was removed from the filter object on purpose: a filter is
 * something a caller supplies, and the tenant is not. It now comes from the
 * context and nowhere else, so there is no shape of request that can ask for
 * another tenant's queue.
 */
export async function listTickets(
  ctx: TenantContext,
  f: TicketListFilters = {},
): Promise<TicketListRow[]> {
  requirePermission(ctx, "ticket:read");
  const params: unknown[] = [ctx.businessId];
  // A merged ticket is history, not work. It stays reachable by id.
  const where: string[] = [`t.business_id = $1`, `t.merged_into_id is null`];

  if (f.status?.length) {
    params.push(f.status);
    where.push(`t.status = any($${params.length}::ticket_status[])`);
  }
  if (f.priority?.length) {
    params.push(f.priority);
    where.push(`t.priority = any($${params.length}::ticket_priority[])`);
  }
  if (f.path?.length) {
    params.push(f.path);
    where.push(`t.resolution_path = any($${params.length}::resolution_path[])`);
  }
  if (f.category) {
    params.push(f.category);
    where.push(`t.category = $${params.length}`);
  }
  if (f.search) {
    params.push(`%${f.search}%`);
    where.push(`(t.subject ilike $${params.length} or t.body ilike $${params.length})`);
  }
  params.push(f.limit ?? 50);
  const limitIdx = params.length;
  params.push(f.offset ?? 0);
  const offsetIdx = params.length;

  return query<TicketListRow>(
    `select t.*,
            r.email as requester_email,
            r.full_name as requester_name,
            r.vip as requester_vip,
            s.full_name as assignee_name
       from tickets t
       left join requesters r on r.id = t.requester_id
       left join staff s on s.id = t.assigned_to
      where ${where.join(" and ")}
      order by
        case t.priority when 'P1' then 1 when 'P2' then 2 when 'P3' then 3 else 4 end,
        t.created_at desc
      limit $${limitIdx} offset $${offsetIdx}`,
    params,
  );
}

/**
 * The four clock columns for a restamp, keeping any clock that has settled.
 *
 * A clock settles when its result is recorded: the first response once
 * `first_response_at` is set, the resolution while `resolved_at` is, and either
 * clock once its breach is recorded (`first_response_breached_at`, or
 * `resolution_clock_breached` for the resolution clock running now). Its met
 * or breached result is then history. A priority change used to restamp it
 * anyway, so relabelling a closed P3 as P1 for the calibration table could
 * turn a target the desk met into a breach, and a downgrade could erase one. A
 * clock with no deadline yet takes the stamp even if its outcome is recorded,
 * so a reply sent before the first triage still gets a clock.
 *
 * A breached clock keeps the deadline it missed. The recorded breach would
 * keep it `breached` either way (`slaStatus`), but a new priority's window
 * would change how late it reads: later under an upgrade, and back in the
 * future under a downgrade, so a clock that has already failed would count
 * down towards a deadline that no longer means anything.
 *
 * The resolution clock is restamped when a reopen unsettles it (`setStatus`),
 * with the time it spent resolved credited. The first response never
 * unsettles.
 *
 * SQL rather than TypeScript so it is judged against the row being updated,
 * whoever wrote it last. The arguments are the parameter placeholders for the
 * new first-response deadline, resolution deadline, and their two warnings.
 */
const SETTLED_CLOCKS = (fDue: string, rDue: string, fWarn: string, rWarn: string) => `
            first_response_due_at = case
              when first_response_due_at is not null
               and (first_response_at is not null or first_response_breached_at is not null)
                then first_response_due_at
              else coalesce(${fDue}::timestamptz, first_response_due_at) end,
            first_response_warn_at = case
              when first_response_due_at is not null
               and (first_response_at is not null or first_response_breached_at is not null)
                then first_response_warn_at
              else coalesce(${fWarn}::timestamptz, first_response_warn_at) end,
            resolution_due_at = case
              when resolution_due_at is not null
               and (resolved_at is not null or resolution_clock_breached)
                then resolution_due_at
              else coalesce(${rDue}::timestamptz, resolution_due_at) end,
            resolution_warn_at = case
              when resolution_due_at is not null
               and (resolved_at is not null or resolution_clock_breached)
                then resolution_warn_at
              else coalesce(${rWarn}::timestamptz, resolution_warn_at) end`;

/**
 * Write the triage result back onto the ticket.
 *
 * Called by the pipeline with an `agentContext`, so the tenant in the predicate
 * is the one the ticket was loaded under. It is scoped here rather than left as
 * a bare update so a later caller cannot retriage across tenants by id.
 *
 * A retriage can land on a ticket whose clock is stopped. Writing the new
 * status straight onto that row used to move it out of `awaiting_user` and
 * leave `sla_paused_at` set, so the desk held the ticket with its clock
 * stopped: it reported `paused` for as long as nobody touched it, the warning
 * sweep skipped it, and whoever touched it next was credited the whole time
 * as though the requester had held it. Leaving the pause is `setStatus`'s job
 * — it measures the wait, moves the clocks and logs it — so this write keeps
 * the paused status and hands the transition over.
 *
 * A clock that has already settled keeps its deadline, so a retriage cannot
 * turn a met target into a breach after the event or the other way round. See
 * `SETTLED_CLOCKS`.
 *
 * It takes the row lock the other clock writers take, so a breach the row
 * already shows is recorded before the restamp can move its deadline, and a
 * breach the restamp itself causes is recorded with it.
 *
 * **The stamp is computed here, from the locked row.** It used to arrive with
 * the triage result, computed by the pipeline from the ticket it read before
 * the model call. A requester who replied during the call resumed the clock
 * and was credited the wait, and the stamp then wrote the uncredited deadline
 * over it, while `sla_paused_minutes` went on saying the wait had been given
 * back. The credit is now read under the lock, in the transaction that writes
 * the stamp, so whichever of the two commits second builds on the first.
 *
 * `settings` is the policy the decision was made under, passed in rather than
 * read here so the targets stamped and `config_version` come from the same
 * configuration. Returns the deadlines as written, before any resume credits an
 * open pause onto them, or null for a ticket this tenant does not have.
 */
export async function applyTriage(
  ctx: TenantContext,
  ticketId: string,
  t: {
    category: string;
    subcategory: string;
    priority: TicketPriority;
    confidence: number;
    resolution_path: ResolutionPath;
    status: TicketStatus;
    parent_incident_id?: string | null;
    injection_suspected?: boolean;
    /**
     * The configuration version in force when this decision was made.
     *
     * Without it, replaying this ticket six weeks from now silently uses
     * today's thresholds and produces a decision nobody ever made.
     */
    config_version?: number | null;
  },
  settings: BusinessSettings,
): Promise<Pick<Ticket, "first_response_due_at" | "resolution_due_at"> | null> {
  const after = await tx(async (client) => {
    const locked = await lockSlaRow(client, ctx, ticketId);
    if (!locked) return null;
    const now = new Date();
    const { row: before } = await recordBreaches(
      client,
      ctx,
      ticketId,
      locked,
      "retriage",
      now,
    );

    // From `created_at` for the new priority, carrying the credit the locked
    // row has: every pause that has ended, including one that ended while the
    // model was running, and the time spent resolved before every reopen. A
    // pause still open is credited by the resume below.
    const stamp = computeSla(
      new Date(before.created_at),
      t.priority,
      settings,
      before.sla_paused_minutes,
      before.sla_resolved_minutes,
    );

    const { rows } = await client.query<SlaRow & { resume: boolean }>(
      `update tickets
          set category = $2,
              subcategory = $3,
              priority = $4,
              triage_confidence = $5,
              resolution_path = $6,
              status = case
                when sla_paused_at is not null and $7::ticket_status <> '${PAUSED_STATUS}'
                  then status
                else $7::ticket_status end,
              parent_incident_id = coalesce($8, parent_incident_id),
              ${SETTLED_CLOCKS("$9", "$10", "$14", "$15")},
              injection_suspected = $11,
              config_version = coalesce($13, config_version),
              updated_at = now()
        where id = $1 and business_id = $12
        returning (sla_paused_at is not null
                   and $7::ticket_status <> '${PAUSED_STATUS}') as resume,
                  ${SLA_ROW}`,
      [
        ticketId,
        t.category,
        t.subcategory,
        t.priority,
        t.confidence,
        t.resolution_path,
        t.status,
        t.parent_incident_id ?? null,
        stamp.firstResponseDueAt,
        stamp.resolutionDueAt,
        t.injection_suspected ?? false,
        ctx.businessId,
        t.config_version ?? null,
        stamp.firstResponseWarnAt,
        stamp.resolutionWarnAt,
      ],
    );
    const written = rows[0]!;
    // An upgrade can stamp a deadline that has already gone.
    await recordBreaches(client, ctx, ticketId, written, "retriage", now);
    return written;
  });
  if (!after) return null;

  // After the stamp, so the wait is credited onto the deadlines just written.
  // After the commit too: `setStatus` takes the same row lock.
  if (after.resume) await setStatus(ctx, ticketId, t.status);
  return {
    first_response_due_at: after.first_response_due_at,
    resolution_due_at: after.resolution_due_at,
  };
}

/**
 * The permission a move to `status` needs.
 *
 * `ticket:close` and `ticket:reopen` are separate from `ticket:update` because
 * they are separate decisions. Exported so a caller that changes many tickets
 * at once can refuse up front, before it has changed any of them.
 */
export function permissionForStatus(status: TicketStatus): Permission {
  return status === "closed"
    ? "ticket:close"
    : status === "reopened"
      ? "ticket:reopen"
      : "ticket:update";
}

/**
 * The outcome columns a status change moves, for both updates in `setStatus`.
 *
 * `resolved_at` means "resolved, and still resolved". It used to survive a
 * reopen, and every reader of it went wrong in its own way: the follow-up
 * sweep judged a re-resolved ticket against its first resolution — so the
 * requester's reply that caused the reopen counted as a reply "since
 * resolution" and reopened it again, every sweep, for ever — the SLA badge
 * showed a reopened ticket as `met`, and the warning sweep, which skips
 * anything with a `resolved_at`, never warned about it.
 *
 * So it is set on the way into `resolved` or `closed` (kept, not restamped,
 * when a resolved ticket is closed) and cleared on the way out of both.
 * `closed_at` follows the same rule for `closed`.
 *
 * The way out is a reopen, which starts a new resolution clock. The old
 * clock's breach flag goes with it, so the new clock is judged on its own
 * deadline. `resolution_breached_at` stays: the old clock's breach is history,
 * and nothing rewrites a recorded result. The new clock is credited the time
 * since `resolved_at` before that column is cleared (`stampForReopen`, D3).
 */
const OUTCOME_COLUMNS = `
              resolved_at = case
                when $2::ticket_status in ('resolved','closed') then coalesce(resolved_at, now())
                else null end,
              closed_at = case
                when $2::ticket_status = 'closed' then coalesce(closed_at, now())
                else null end,
              resolution_clock_breached = case
                when resolved_at is not null and $2::ticket_status not in ('resolved','closed')
                  then false
                else resolution_clock_breached end,
              reopened_count = case
                when $2::ticket_status = 'reopened' then reopened_count + 1
                else reopened_count end`;

/**
 * The status in which the service desk is waiting on somebody else.
 *
 * One status, named once, because the SLA pause hangs off it and a second
 * spelling elsewhere would silently stop pausing.
 */
const PAUSED_STATUS: TicketStatus = "awaiting_user";

/**
 * Move a ticket between statuses, stopping and restarting the SLA clock.
 *
 * `ticket:close` and `ticket:reopen` are separate permissions from
 * `ticket:update` because they are separate decisions: an agent account may
 * work and close a ticket, and reopening one is a manager's call.
 *
 * **The clock stops on `awaiting_user` and restarts on the way out.** Before
 * this, `computeSla` stamped both deadlines from `created_at` and nothing ever
 * moved them, so a ticket parked waiting for a requester kept spending its
 * resolution budget — and the resolution SLA measured how fast people answer
 * their email rather than how fast this desk works.
 *
 * Three properties the implementation has to have, all of which are about
 * repeated cycles rather than the first one:
 *
 * **Pausing twice is not two pauses.** A ticket already in `awaiting_user` that
 * is set to `awaiting_user` again keeps its original `sla_paused_at`, so a
 * duplicate write cannot reset the clock and hand the desk free time.
 *
 * **The read is locked.** The shift is computed here, in TypeScript, because
 * it needs the working-hours calendar, so the row has to be read before it is
 * written. It is read `for update`, in the same transaction as the write, so
 * nothing can move the clocks in between. Another resume waits and then finds
 * the pause already over, and a priority change (`overrideClassification`)
 * waits and then restamps the deadlines this wrote.
 *
 * The read used to be unlocked, with optimistic guards on the update instead:
 * `sla_paused_at` had to still equal the value the shift was computed from.
 * That stopped a second resume, but not a priority change landing between the
 * read and the write. It left `sla_paused_at` alone, so the guard passed and
 * the old priority's deadlines were written back, shifted by the pause.
 *
 * **Every cycle accumulates.** `sla_paused_minutes` adds up across pauses, so
 * "how much of this ticket's age was ours" survives a conversation that goes
 * back and forth four times.
 *
 * **A breach is recorded before anything moves.** Whatever breach the locked
 * row shows is recorded first (`recordBreaches`), and whatever breach the
 * change produces, such as a resolution after the deadline or a reopen onto a
 * deadline already gone, is recorded after it. Both happen in this
 * transaction.
 */
export async function setStatus(
  ctx: TenantContext,
  ticketId: string,
  status: TicketStatus,
): Promise<void> {
  requirePermission(ctx, permissionForStatus(status));

  // Fetched before the row is locked rather than only when a resume needs it:
  // fetching it inside would hold the lock while waiting for a second pool
  // connection.
  const settings = await getSettings(ctx.businessId);

  // The row and the event move together or not at all.
  //
  // They used to be two statements on the pool: the update committed, and the
  // event was appended afterwards. An append that failed — a dropped
  // connection, a constraint, a restart in between — left a ticket whose
  // deadline had moved with nothing on its timeline to say why, which is
  // exactly the state the P1 replay criterion exists to forbid, and it would
  // never have surfaced as an error anybody saw.
  //
  // Same reasoning, and the same shape, as `auditInTx` in `config.ts`.
  await tx(async (client) => {
    const locked = await lockSlaRow(client, ctx, ticketId);
    if (!locked) throw new NotFoundError("ticket");
    const now = new Date();
    const { row: before } = await recordBreaches(
      client,
      ctx,
      ticketId,
      locked,
      "status_change",
      now,
    );

    const wasPaused = before.sla_paused_at !== null;
    // Entering starts a pause only if there is not one already, so setting
    // `awaiting_user` twice keeps the first `sla_paused_at` and logs once.
    const entering = status === PAUSED_STATUS && !wasPaused;
    // Resuming is "was stopped, and is not being asked to stop again". Reaching
    // `resolved` from `awaiting_user` resumes too: the clock has to be running
    // for `resolved_at` to be judged against a deadline that means anything.
    const resuming = wasPaused && status !== PAUSED_STATUS;

    const shift: SlaShift | null = resuming
      ? shiftForPause(
          before,
          new Date(before.sla_paused_at!),
          now,
          before.priority,
          settings,
        )
      : null;

    // A reopen unsettles the resolution clock, which kept its deadline while it
    // was settled (`SETTLED_CLOCKS`). The time since `resolved_at` is credited
    // to it (D3), and it is stamped again for the priority the ticket has now,
    // with every credit it has, so a priority change made while it was
    // resolved reaches it here too. When no time passed and nothing changed,
    // that is the deadline it already had and nothing moves.
    const reopening =
      before.resolved_at !== null && status !== "resolved" && status !== "closed";
    const reopen = reopening
      ? stampForReopen(
          { ...before, resolved_at: before.resolved_at! },
          now,
          before.priority,
          settings,
        )
      : null;
    const stamp =
      reopen?.stamp && !resuming && before.resolution_due_at !== null ? reopen.stamp : null;
    const restamp =
      stamp && !sameInstant(stamp.resolutionDueAt, before.resolution_due_at) ? stamp : null;

    const updated = await client.query<SlaRow>(
      `update tickets
          set status = $2::ticket_status,
              ${OUTCOME_COLUMNS},
              -- Entering the paused status stamps the start. Leaving it clears
              -- the start. Every other transition leaves the column alone.
              sla_paused_at = case
                when $4::boolean then now()
                when $5::boolean then null
                else sla_paused_at end,
              sla_paused_minutes = sla_paused_minutes + coalesce($6::int, 0),
              sla_resolved_minutes = sla_resolved_minutes + $11::int,
              first_response_due_at = coalesce($7::timestamptz, first_response_due_at),
              resolution_due_at = coalesce($8::timestamptz, resolution_due_at),
              first_response_warn_at = coalesce($9::timestamptz, first_response_warn_at),
              resolution_warn_at = coalesce($10::timestamptz, resolution_warn_at),
              updated_at = now()
        where id = $1 and business_id = $3
        returning ${SLA_ROW}`,
      [
        ticketId,
        status,
        ctx.businessId,
        entering,
        resuming,
        shift?.pausedMinutes ?? null,
        shift?.firstResponseDueAt ?? null,
        shift?.resolutionDueAt ?? restamp?.resolutionDueAt ?? null,
        shift?.firstResponseWarnAt ?? null,
        shift?.resolutionWarnAt ?? restamp?.resolutionWarnAt ?? null,
        reopen?.resolvedMinutes ?? 0,
      ],
    );

    // The clock movement goes in the log, not only in the columns. A replay has
    // to be able to explain a deadline that moved, or it will report a ticket
    // that met an SLA it appears to have breached.
    const payloads: Record<string, unknown>[] = [];
    if (entering) payloads.push({ stage: "sla_pause", action: "paused", status });
    if (shift) {
      payloads.push({
        stage: "sla_pause",
        action: "resumed",
        status,
        paused_minutes: shift.pausedMinutes,
        resolution_due_at: shift.resolutionDueAt?.toISOString() ?? null,
        first_response_due_at: shift.settled.includes("first_response")
          ? null
          : (shift.firstResponseDueAt?.toISOString() ?? null),
        resolution_warn_at: shift.resolutionWarnAt?.toISOString() ?? null,
        // Clocks that kept their deadline because their result was recorded.
        settled: shift.settled,
      });
    }
    // A reopen ends the resolution clock and starts a new one. The old clock's
    // result stays where it was recorded. This event says the clock ended and
    // how, so a replay can tell the new clock's breach from the old one's
    // without depending on the caller to log the status change first. It also
    // carries the time credited for being resolved, which is how a replay
    // rebuilds `sla_resolved_minutes`, so it is written whenever that moves,
    // even on a ticket with no clock yet.
    if (reopen && (before.resolution_due_at !== null || reopen.resolvedMinutes > 0)) {
      payloads.push({
        stage: "sla_clock",
        clock: "resolution",
        action: "restarted",
        status,
        previous: slaStatus(before, now).resolution,
        resolved_minutes: reopen.resolvedMinutes,
      });
    }
    if (restamp) {
      payloads.push({
        stage: "sla_restamp",
        reason: "reopen",
        status,
        priority: before.priority,
        credit_minutes: before.sla_paused_minutes,
        resolved_minutes: before.sla_resolved_minutes + (reopen?.resolvedMinutes ?? 0),
        resolution_due_at: restamp.resolutionDueAt.toISOString(),
        resolution_warn_at: restamp.resolutionWarnAt.toISOString(),
      });
    }

    for (const payload of payloads) {
      await client.query(
        `insert into ticket_events (ticket_id, actor, kind, payload)
         select t.id, $2, 'note', $3::jsonb
           from tickets t
          where t.id = $1 and t.business_id = $4`,
        [ticketId, actorString(ctx), JSON.stringify(payload), ctx.businessId],
      );
    }

    await recordBreaches(client, ctx, ticketId, updated.rows[0]!, "status_change", now);
  });
}

/**
 * Record the first response, once.
 *
 * Usually the clock is running and that is the whole of it. When the ticket is
 * waiting on the requester the clock is stopped, and the response settles it
 * there: the deadline is credited the part of the pause before the response,
 * and the resume that follows leaves it alone (`shiftForPause`). The resume
 * used to credit the whole pause, so a response that was late when the clock
 * stopped could read `met` once the requester replied, and a response that
 * read `breached` until then could turn into `met` on the resume.
 *
 * The instant is taken after the row lock, from the same clock `setStatus`
 * measures a resume with, and written as `first_response_at`, so the credit
 * runs to the recorded response exactly. The lock is the one `setStatus` takes,
 * so a resume cannot land between the read of the pause and this write.
 *
 * A breach the clock already shows is recorded before the response, and a
 * response that arrives late is recorded as a breach with it.
 */
export async function markFirstResponse(
  ctx: TenantContext,
  ticketId: string,
): Promise<void> {
  // Before the lock, for the same reason as in `setStatus`.
  const settings = await getSettings(ctx.businessId);

  await tx(async (client) => {
    const locked = await lockSlaRow(client, ctx, ticketId);
    if (!locked || locked.first_response_at !== null) return;

    const respondedAt = new Date();
    const { row: before } = await recordBreaches(
      client,
      ctx,
      ticketId,
      locked,
      "first_response",
      respondedAt,
    );
    const shift =
      before.sla_paused_at !== null && before.first_response_due_at !== null
        ? shiftForFirstResponse(
            before,
            new Date(before.sla_paused_at),
            respondedAt,
            before.priority,
            settings,
          )
        : null;
    const moved =
      shift && !sameInstant(shift.dueAt, before.first_response_due_at) ? shift : null;

    const updated = await client.query<SlaRow>(
      `update tickets
          set first_response_at = $3,
              first_response_due_at = coalesce($4::timestamptz, first_response_due_at),
              first_response_warn_at = coalesce($5::timestamptz, first_response_warn_at),
              updated_at = now()
        where id = $1 and business_id = $2
        returning ${SLA_ROW}`,
      [ticketId, ctx.businessId, respondedAt, moved?.dueAt ?? null, moved?.warnAt ?? null],
    );

    // In the same transaction, like every other deadline that moves (I6). It
    // carries no status and adds nothing to `sla_paused_minutes`: the pause is
    // still open, and the resume credits the whole of it to the resolution
    // clock.
    if (moved) {
      await client.query(
        `insert into ticket_events (ticket_id, actor, kind, payload)
         select t.id, $2, 'note', $3::jsonb
           from tickets t
          where t.id = $1 and t.business_id = $4`,
        [
          ticketId,
          actorString(ctx),
          JSON.stringify({
            stage: "sla_pause",
            action: "credited",
            clock: "first_response",
            credit_minutes: moved.creditMinutes,
            first_response_due_at: iso(moved.dueAt),
            first_response_warn_at: iso(moved.warnAt),
          }),
          ctx.businessId,
        ],
      );
    }

    await recordBreaches(client, ctx, ticketId, updated.rows[0]!, "first_response", respondedAt);
  });
}

export async function incrementClarify(
  ctx: TenantContext,
  ticketId: string,
): Promise<void> {
  await query(
    `update tickets set clarify_count = clarify_count + 1, updated_at = now()
      where id = $1 and business_id = $2`,
    [ticketId, ctx.businessId],
  );
}

/**
 * Reclassify a ticket by hand, which is also how the calibration table gets its
 * ground truth. Gated on `agent:override` rather than `ticket:update`:
 * correcting the agent is a supervisory act, and the worth of the resulting
 * label depends on who wrote it.
 *
 * **A new priority restamps the clocks, the way a retriage does.** It used to
 * change the priority only, so a P3 that somebody re-marked as P1 kept its P3
 * deadline, while the same correction made by a retriage moved it. The ticket
 * was always that priority, so the stamp is taken from `created_at` and carries
 * the pause time already given back, and the time spent resolved before any
 * reopen (resolution clock only). An open pause stays open, and the resume
 * credits it onto the new deadlines. A clock whose result is already recorded
 * keeps its deadline (`SETTLED_CLOCKS`), so relabelling a closed ticket does
 * not rewrite its SLA history. A change of category alone moves nothing.
 *
 * The credit is read under the same row lock `setStatus` takes, so this and a
 * resume run one after the other: whichever goes second sees what the first
 * wrote. The stamp is written in the same transaction as the event that
 * explains it.
 *
 * **A downgrade cannot erase a breach.** It used to: lowering the priority of
 * an open ticket that was already late stamped a later deadline, and the
 * breach was gone before anything had recorded it. Whatever breach the locked
 * row shows is now recorded before the restamp, and the breached clock then
 * keeps the deadline it missed (`SETTLED_CLOCKS`). An upgrade onto a deadline
 * that has already gone is recorded after it.
 */
export async function overrideClassification(
  ctx: TenantContext,
  ticketId: string,
  next: { category: string; priority: TicketPriority },
): Promise<void> {
  requirePermission(ctx, "agent:override");
  const settings = await getSettings(ctx.businessId);

  await tx(async (client) => {
    const locked = await lockSlaRow(client, ctx, ticketId);
    if (!locked) throw new NotFoundError("ticket");
    const now = new Date();
    const { row: before } = await recordBreaches(
      client,
      ctx,
      ticketId,
      locked,
      "reclassification",
      now,
    );

    const stamp =
      before.priority === next.priority
        ? null
        : computeSla(
            new Date(before.created_at),
            next.priority,
            settings,
            before.sla_paused_minutes,
            before.sla_resolved_minutes,
          );

    const updated = await client.query<SlaRow>(
      `update tickets
          set category = $3,
              priority = $4,
              ${SETTLED_CLOCKS("$5", "$6", "$7", "$8")},
              updated_at = now()
        where id = $1 and business_id = $2
        returning ${SLA_ROW}`,
      [
        ticketId,
        ctx.businessId,
        next.category,
        next.priority,
        stamp?.firstResponseDueAt ?? null,
        stamp?.resolutionDueAt ?? null,
        stamp?.firstResponseWarnAt ?? null,
        stamp?.resolutionWarnAt ?? null,
      ],
    );
    const after = updated.rows[0]!;

    // Read back rather than predicted, so the event records what the settled
    // rule let through and cannot drift from it.
    const moved = stamp
      ? CLOCKS.filter(
          (c) =>
            !sameInstant(before[`${c}_due_at`], after[`${c}_due_at`]) ||
            !sameInstant(before[`${c}_warn_at`], after[`${c}_warn_at`]),
        )
      : [];
    if (stamp && moved.length > 0) {
      const stampedDue = {
        first_response: stamp.firstResponseDueAt,
        resolution: stamp.resolutionDueAt,
      };
      const shown = (c: Clock, v: Date | null) => (moved.includes(c) ? iso(v) : null);

      // Same reason as the pause events in `setStatus`: a replay has to be able
      // to explain a deadline that moved.
      await client.query(
        `insert into ticket_events (ticket_id, actor, kind, payload)
         select t.id, $2, 'note', $3::jsonb
           from tickets t
          where t.id = $1 and t.business_id = $4`,
        [
          ticketId,
          actorString(ctx),
          JSON.stringify({
            stage: "sla_restamp",
            reason: "priority_change",
            from_priority: before.priority,
            to_priority: next.priority,
            credit_minutes: before.sla_paused_minutes,
            resolved_minutes: before.sla_resolved_minutes,
            first_response_due_at: shown("first_response", after.first_response_due_at),
            first_response_warn_at: shown("first_response", after.first_response_warn_at),
            resolution_due_at: shown("resolution", after.resolution_due_at),
            resolution_warn_at: shown("resolution", after.resolution_warn_at),
            // Clocks that kept their deadline because their result was
            // recorded: an outcome, or a breach.
            settled: CLOCKS.filter((c) => !sameInstant(after[`${c}_due_at`], stampedDue[c])),
          }),
          ctx.businessId,
        ],
      );
    }

    await recordBreaches(client, ctx, ticketId, after, "reclassification", now);
  });
}

// ---------------------------------------------------------------------------
// Recording breaches
// ---------------------------------------------------------------------------

/**
 * The columns every clock writer reads under the row lock and gets back from
 * its update. One list, so `slaStatus` is always handed everything it needs to
 * decide a breach, including the breaches already recorded.
 */
const SLA_ROW = `priority, created_at, first_response_at, resolved_at,
                 sla_paused_at, sla_paused_minutes, sla_resolved_minutes,
                 first_response_due_at, resolution_due_at,
                 first_response_warn_at, resolution_warn_at,
                 first_response_breached_at, resolution_breached_at,
                 resolution_clock_breached`;

interface SlaRow extends ClockColumns {
  priority: TicketPriority | null;
  created_at: Date;
  first_response_at: Date | null;
  resolved_at: Date | null;
  sla_paused_at: Date | null;
  sla_paused_minutes: number;
  sla_resolved_minutes: number;
  first_response_breached_at: Date | null;
  resolution_breached_at: Date | null;
  resolution_clock_breached: boolean;
}

/** The ticket's clocks, locked until the caller's transaction ends. */
async function lockSlaRow(
  client: pg.PoolClient,
  ctx: TenantContext,
  ticketId: string,
): Promise<SlaRow | null> {
  const { rows } = await client.query<SlaRow>(
    `select ${SLA_ROW} from tickets where id = $1 and business_id = $2 for update`,
    [ticketId, ctx.businessId],
  );
  return rows[0] ?? null;
}

/** Which write saw a breach first. It goes on the `sla_breach` event. */
export type BreachRecorder =
  | "sweep"
  | "status_change"
  | "first_response"
  | "reclassification"
  | "retriage";

/**
 * Record every breach the row shows and has not recorded yet, inside the
 * caller's transaction, and return the row as it now stands.
 *
 * Every clock writer calls this twice under the row lock. The first call comes
 * before its change, so nothing the change moves can take away a breach that
 * has not been recorded. The second comes after, for a breach the change
 * itself produced: a late answer, a resolution after the deadline, or an
 * upgrade onto a deadline already gone. The sweep calls it for clocks that
 * breached while nobody was writing to their ticket.
 *
 * The decision is `unrecordedBreaches`, which is `slaStatus`, so the record
 * and the console agree about what counts. The update is guarded on the column
 * as well as decided under the lock, so a caller that forgot the lock still
 * could not record one breach twice. The event is written only when the guard
 * let the update through. The column and the event are one transaction, and an
 * event that cannot be written rolls back the column and whatever change the
 * caller was making.
 *
 * The actor is always the system. A person whose priority change was the first
 * write to see a breach did not cause it. `recorded_by` says which write it
 * was.
 */
async function recordBreaches(
  client: pg.PoolClient,
  ctx: TenantContext,
  ticketId: string,
  row: SlaRow,
  recordedBy: BreachRecorder,
  now: Date,
): Promise<{ row: SlaRow; recorded: Clock[] }> {
  let current = row;
  const recorded: Clock[] = [];

  for (const breach of unrecordedBreaches(row, now)) {
    const { rows } = await client.query<SlaRow>(
      breach.clock === "first_response"
        ? `update tickets
              set first_response_breached_at = $3, updated_at = now()
            where id = $1 and business_id = $2 and first_response_breached_at is null
            returning ${SLA_ROW}`
        : // The first breach of the resolution target stays in
          // `resolution_breached_at` for good. A later clock's breach is its
          // own event, and sets only the flag for the clock running now.
          `update tickets
              set resolution_breached_at = coalesce(resolution_breached_at, $3),
                  resolution_clock_breached = true,
                  updated_at = now()
            where id = $1 and business_id = $2 and not resolution_clock_breached
            returning ${SLA_ROW}`,
      [ticketId, ctx.businessId, breach.breachedAt],
    );
    if (!rows[0]) continue;
    current = rows[0];
    recorded.push(breach.clock);

    const outcome = breach.clock === "first_response" ? row.first_response_at : row.resolved_at;
    await client.query(
      `insert into ticket_events (ticket_id, actor, kind, payload)
       select t.id, 'system', 'note', $2::jsonb
         from tickets t
        where t.id = $1 and t.business_id = $3`,
      [
        ticketId,
        JSON.stringify({
          stage: "sla_breach",
          clock: breach.clock,
          // The deadline it missed, which is the instant it breached. When it
          // was recorded is the event's own timestamp.
          breached_at: breach.breachedAt.toISOString(),
          priority: row.priority,
          // The late answer or resolution that decided it, or null for a clock
          // that was still running when its breach was seen.
          outcome_at: iso(outcome),
          // Seen while the clock was stopped, which means it breached before
          // the pause began.
          paused: row.sla_paused_at !== null,
          recorded_by: recordedBy,
        }),
        ctx.businessId,
      ],
    );
  }

  return { row: current, recorded };
}

/**
 * Record whatever breaches one ticket shows now. This is what the sweep calls.
 *
 * The writers record every breach they see, but a clock can breach while
 * nobody writes to its ticket. Without this, such a breach would wait for the
 * next write, which for a forgotten ticket may never come, and a report would
 * not see it. Returns the clocks it recorded, and nothing for a ticket that
 * shows no new breach, so running it twice is the same as running it once.
 */
export async function recordSlaBreaches(
  ctx: TenantContext,
  ticketId: string,
): Promise<SlaClock[]> {
  requirePermission(ctx, "ticket:update");
  return tx(async (client) => {
    const row = await lockSlaRow(client, ctx, ticketId);
    if (!row) return [];
    const { recorded } = await recordBreaches(client, ctx, ticketId, row, "sweep", new Date());
    return recorded;
  });
}

/**
 * Tickets that may show a breach nobody has recorded. These are the sweep's
 * candidates.
 *
 * A superset: the database says only which clocks have no breach recorded,
 * have not been met, and whose deadline is behind the instant the clock is read
 * at. Whether each one really is a breach is decided by `slaStatus`, under the
 * lock, in `recordSlaBreaches`. The two halves match the partial indexes in
 * 0017. Merged tickets are left out, as the warning sweep leaves them out,
 * because they are history rather than work.
 */
export async function ticketsWithUnrecordedBreaches(
  ctx: TenantContext,
  limit = 200,
): Promise<string[]> {
  requirePermission(ctx, "ticket:read");
  const rows = await query<{ id: string }>(
    `select id from tickets
      where business_id = $1
        and merged_into_id is null
        and first_response_breached_at is null
        and (first_response_at is null or first_response_at > first_response_due_at)
        and first_response_due_at < coalesce(first_response_at, sla_paused_at, now())
     union
     select id from tickets
      where business_id = $1
        and merged_into_id is null
        and not resolution_clock_breached
        and (resolved_at is null or resolved_at > resolution_due_at)
        and resolution_due_at < coalesce(resolved_at, sla_paused_at, now())
     limit $2`,
    [ctx.businessId, limit],
  );
  return rows.map((r) => r.id);
}

type Clock = SlaClock;
const CLOCKS: readonly Clock[] = ["first_response", "resolution"];

interface ClockColumns {
  first_response_due_at: Date | null;
  resolution_due_at: Date | null;
  first_response_warn_at: Date | null;
  resolution_warn_at: Date | null;
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return a === null || b === null ? a === b : new Date(a).getTime() === new Date(b).getTime();
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

/** Everything a requester has raised. Powers their portal view. */
export async function ticketsForRequester(
  ctx: TenantContext,
  requesterId: string,
  limit = 25,
): Promise<Ticket[]> {
  return query<Ticket>(
    `select * from tickets
      where requester_id = $1 and business_id = $2 and merged_into_id is null
      order by created_at desc
      limit $3`,
    [requesterId, ctx.businessId, limit],
  );
}

/** Recent history for the same requester, used to enrich the triage prompt. */
export async function recentTicketsFor(
  ctx: TenantContext,
  requesterId: string,
  days = 14,
  excludeTicketId?: string,
): Promise<Ticket[]> {
  return query<Ticket>(
    `select * from tickets
      where requester_id = $1
        and business_id = $4
        and created_at > now() - ($2 || ' days')::interval
        and ($3::uuid is null or id <> $3)
      order by created_at desc
      limit 10`,
    [requesterId, String(days), excludeTicketId ?? null, ctx.businessId],
  );
}

/** Open P1/P2 incidents, so forty duplicates during an outage become children. */
export async function activeIncidents(ctx: TenantContext): Promise<Ticket[]> {
  return query<Ticket>(
    `select * from tickets
      where business_id = $1
        and is_incident = true
        and status not in ('resolved','closed')
      order by created_at desc
      limit 10`,
    [ctx.businessId],
  );
}

export async function ticketsAwaitingFollowup(
  ctx: TenantContext,
  hours: number,
): Promise<Ticket[]> {
  return query<Ticket>(
    `select * from tickets
      where business_id = $1
        and status = 'resolved'
        and resolved_at < now() - ($2 || ' hours')::interval
      order by resolved_at asc
      limit 50`,
    [ctx.businessId, String(hours)],
  );
}
