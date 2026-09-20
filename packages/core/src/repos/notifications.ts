import { query, queryOne } from "../db.js";
import { actorString, requirePermission, type TenantContext } from "../auth/context.js";
import { ROLE_PERMISSIONS, type Role } from "../auth/permissions.js";
import { audit } from "./audit.js";
import type { NotificationKind } from "../types.js";

/**
 * Consent, and who to write to.
 *
 * The transport in `repos/outbound.ts` knows how to deliver a message. This
 * file answers the two questions it deliberately does not: is this person
 * willing to hear from us, and who is "the queue" anyway.
 *
 * An opt-out is a fact about a person, not a setting of the tenant, which is
 * why it lives in a table rather than in `businesses.settings`. Configuration
 * is versioned and rolled back; a rollback to last week's settings must not
 * resubscribe somebody who unsubscribed yesterday.
 */

export interface Optout {
  id: number;
  business_id: string;
  email: string;
  /** A `NotificationKind`, or `all`. */
  kind: string;
  reason: string | null;
  source: string;
  created_by: string;
  created_at: Date;
}

/** `all` is a real value here: "stop emailing me about anything". */
export const ALL_KINDS = "all";

/**
 * Record that somebody does not want a kind of notification.
 *
 * Deliberately permission-free. The usual caller is the unsubscribe link in an
 * email, which runs as the system inside the tenant the signed token names —
 * there is no session, and requiring one would mean the only people who can
 * stop the mail are the people who could already turn it off for everybody.
 * The audit row records which it was.
 */
export async function optOut(
  ctx: TenantContext,
  input: {
    email: string;
    kind: NotificationKind | typeof ALL_KINDS;
    reason?: string | null;
    /** `self` when the recipient clicked the link; `console` when staff did it. */
    source?: "self" | "console";
  },
): Promise<boolean> {
  const email = input.email.trim().toLowerCase();
  const source = input.source ?? "self";

  const row = await queryOne<{ id: number }>(
    `insert into notification_optouts
       (business_id, email, kind, reason, source, created_by)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (business_id, lower(email), kind) do nothing
     returning id`,
    [ctx.businessId, email, input.kind, input.reason ?? null, source, actorString(ctx)],
  );
  // Already opted out. Clicking an unsubscribe link twice is not an error, and
  // saying "you were already unsubscribed" is the honest answer.
  if (!row) return false;

  await audit(ctx, {
    action: "notification.optout",
    resource_type: "email_address",
    resource_id: email,
    new_value: { kind: input.kind, source },
    reason: input.reason ?? null,
  });
  return true;
}

/**
 * Undo an opt-out.
 *
 * Needs `config:update`, because resubscribing somebody is a decision about
 * another person's inbox. The one case that does not go through here is a
 * recipient resubscribing themselves, which nothing in this product offers —
 * there is no "actually, do email me" link, deliberately: the way back is to
 * ask, and the asking leaves a trace.
 */
export async function optIn(
  ctx: TenantContext,
  email: string,
  kind: NotificationKind | typeof ALL_KINDS,
  reason: string,
): Promise<boolean> {
  requirePermission(ctx, "config:update");
  const row = await queryOne<Optout>(
    `delete from notification_optouts
      where business_id = $1 and lower(email) = lower($2) and kind = $3
      returning *`,
    [ctx.businessId, email.trim(), kind],
  );
  if (!row) return false;

  await audit(ctx, {
    action: "notification.optin",
    resource_type: "email_address",
    resource_id: row.email,
    old_value: { kind: row.kind, source: row.source, since: row.created_at },
    new_value: { subscribed: true },
    reason,
  });
  return true;
}

/**
 * Whether this address has asked not to receive this kind.
 *
 * `all` counts for every kind, which is what the master unsubscribe link sets.
 */
export async function isOptedOut(
  ctx: TenantContext,
  email: string,
  kind: NotificationKind,
): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    `select id from notification_optouts
      where business_id = $1
        and lower(email) = lower($2)
        and kind = any($3::text[])
      limit 1`,
    [ctx.businessId, email.trim(), [kind, ALL_KINDS]],
  );
  return row !== null;
}

export async function listOptouts(ctx: TenantContext, limit = 100): Promise<Optout[]> {
  requirePermission(ctx, "config:read");
  return query<Optout>(
    `select * from notification_optouts
      where business_id = $1
      order by created_at desc
      limit $2`,
    [ctx.businessId, limit],
  );
}

// ---------------------------------------------------------------------------
// recipients
// ---------------------------------------------------------------------------

/*
 * The three lookups below take a context and require no permission, and that is
 * a deliberate exception worth naming.
 *
 * Each returns internal addresses inside the caller's own tenant, for the sole
 * purpose of writing to them, and each is called by the notification sender —
 * which runs as the agent when the pipeline escalates or asks for approval. The
 * alternative would be granting the agent context a permission to read the
 * user directory, which is a much wider capability than "may email the person
 * this ticket was assigned to".
 */

/** The address of the person a ticket is assigned to, if anybody. */
export async function assigneeAddress(
  ctx: TenantContext,
  ticketId: string,
): Promise<{ email: string; full_name: string } | null> {
  return queryOne<{ email: string; full_name: string }>(
    `select s.email, s.full_name
       from tickets t
       join staff s on s.id = t.assigned_to
      where t.id = $1 and t.business_id = $2 and s.business_id = $2 and s.active`,
    [ticketId, ctx.businessId],
  );
}

/** Active staff watching one queue. */
export async function queueAddresses(
  ctx: TenantContext,
  queue: string,
): Promise<{ email: string; full_name: string }[]> {
  return query<{ email: string; full_name: string }>(
    `select email, full_name
       from staff
      where business_id = $1 and queue = $2 and active
      order by email`,
    [ctx.businessId, queue],
  );
}

/**
 * Everyone in this tenant who could decide an approval.
 *
 * The roles are derived from `ROLE_PERMISSIONS` rather than listed in SQL, so
 * adding `action:approve` to a role automatically adds its holders here. A
 * second copy of that grant table in a query string is how the two drift.
 */
export async function approverAddresses(
  ctx: TenantContext,
): Promise<{ email: string; full_name: string }[]> {
  const roles = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((role) =>
    ROLE_PERMISSIONS[role].includes("action:approve"),
  );
  return query<{ email: string; full_name: string }>(
    `select u.email, u.full_name
       from memberships m
       join users u on u.id = m.user_id
      where m.business_id = $1
        and m.role = any($2::text[])
        and u.active
      order by u.email`,
    [ctx.businessId, roles],
  );
}

/**
 * The facts a notification template needs about a ticket.
 *
 * A separate read rather than passing whole `Ticket` rows around, because the
 * templates need the requester's address — which lives on another table — and
 * because a notification should never be built from a ticket object somebody
 * happened to have in scope from before the change it is announcing.
 */
export async function ticketBriefs(
  ctx: TenantContext,
  ticketIds: string[],
): Promise<
  {
    id: string;
    subject: string;
    priority: string | null;
    category: string | null;
    status: string;
    requester_email: string | null;
    assigned_to: string | null;
  }[]
> {
  requirePermission(ctx, "ticket:read");
  if (ticketIds.length === 0) return [];
  return query(
    `select t.id, t.subject, t.priority::text as priority, t.category,
            t.status::text as status, r.email as requester_email, t.assigned_to
       from tickets t
       left join requesters r on r.id = t.requester_id
      where t.id = any($1::uuid[]) and t.business_id = $2
      order by t.created_at asc`,
    [ticketIds, ctx.businessId],
  );
}

/**
 * The requester a ticket belongs to, by id.
 *
 * Kept out of `ticketBriefs` on purpose: a brief is what goes into a template,
 * and a requester id in a template is one copy-and-paste away from appearing in
 * a staff-facing email — where it would be a working portal capability for
 * somebody else's ticket history.
 */
export async function requesterIdForTicket(
  ctx: TenantContext,
  ticketId: string,
): Promise<string | null> {
  const row = await queryOne<{ requester_id: string | null }>(
    `select requester_id from tickets where id = $1 and business_id = $2`,
    [ticketId, ctx.businessId],
  );
  return row?.requester_id ?? null;
}

/** One staff row, for naming the person a ticket was assigned to. */
export async function staffAddress(
  ctx: TenantContext,
  staffId: string,
): Promise<{ email: string; full_name: string } | null> {
  return queryOne<{ email: string; full_name: string }>(
    `select email, full_name from staff
      where id = $1 and business_id = $2 and active`,
    [staffId, ctx.businessId],
  );
}

// ---------------------------------------------------------------------------
// the SLA warning query
// ---------------------------------------------------------------------------

export interface SlaWarning {
  ticket_id: string;
  subject: string;
  priority: string | null;
  category: string | null;
  status: string;
  /** Which clock is running out. */
  clock: "first_response" | "resolution";
  due_at: Date;
  minutes_left: number;
  assigned_to: string | null;
  assignee_email: string | null;
  assignee_name: string | null;
}

/**
 * Open tickets whose SLA window is nearly used up.
 *
 * The threshold is a share of each ticket's own window rather than a fixed
 * number of minutes, which is the only version that works for two clocks and
 * four priorities at once: 20% of a fifteen-minute P1 target is three minutes,
 * and 20% of a three-day P4 target is most of a working day. A fixed "warn 30
 * minutes before" would be useless at one end and noise at the other.
 *
 * Already-breached tickets are excluded. The warning is about a deadline that
 * can still be met; a breach is a different fact, and the queue already shows
 * it in red.
 */
export async function ticketsNearingSla(
  ctx: TenantContext,
  limit = 200,
): Promise<SlaWarning[]> {
  requirePermission(ctx, "ticket:read");
  // No percentage arithmetic here any more.
  //
  // This query used to compute the warning point itself, as a share of the
  // calendar span between `created_at` and the deadline, while `slaStatus`
  // computed a different one in TypeScript. Two implementations of one policy
  // disagree the moment either changes, and these did: the console called a P4
  // on_track while this query sent a warning email about it.
  //
  // Now both read `*_warn_at`, stamped once by `computeSla` — which is also the
  // only place that knows the deadline was measured in business minutes rather
  // than wall-clock ones, and therefore the only place that can take a share of
  // it correctly.
  //
  // Paused tickets are excluded outright: the clock is stopped, the deadline
  // moves when it restarts, and warning somebody about a deadline that is about
  // to change is how a warning gets ignored.
  return query<SlaWarning>(
    `with open_tickets as (
       select t.*, s.email as assignee_email, s.full_name as assignee_name
         from tickets t
         left join staff s on s.id = t.assigned_to and s.business_id = t.business_id
        where t.business_id = $1
          and t.merged_into_id is null
          and t.status not in ('resolved', 'closed')
          and t.sla_paused_at is null
     )
     select ticket_id, subject, priority, category, status, clock, due_at,
            minutes_left, assigned_to, assignee_email, assignee_name
       from (
         select id as ticket_id, subject, priority::text as priority, category,
                status::text as status,
                'first_response' as clock,
                first_response_due_at as due_at,
                round(extract(epoch from (first_response_due_at - now())) / 60)::int
                  as minutes_left,
                assigned_to, assignee_email, assignee_name
           from open_tickets
          where first_response_at is null
            and first_response_due_at is not null
            and first_response_warn_at is not null
            and now() >= first_response_warn_at
            and now() < first_response_due_at
         union all
         select id as ticket_id, subject, priority::text as priority, category,
                status::text as status,
                'resolution' as clock,
                resolution_due_at as due_at,
                round(extract(epoch from (resolution_due_at - now())) / 60)::int
                  as minutes_left,
                assigned_to, assignee_email, assignee_name
           from open_tickets
          where resolved_at is null
            and resolution_due_at is not null
            and resolution_warn_at is not null
            and now() >= resolution_warn_at
            and now() < resolution_due_at
       ) as due
      order by due_at asc
      limit $2`,
    [ctx.businessId, limit],
  );
}
