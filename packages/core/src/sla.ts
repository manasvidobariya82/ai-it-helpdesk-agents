import type { BusinessHours, BusinessSettings } from "./settings.js";
import type { TicketPriority } from "./types.js";

/**
 * SLA clocks.
 *
 * Two clocks, because they answer different questions. A P1 outage at 2am does
 * not get to wait until nine, so its clock is calendar time. A P4 licence
 * request raised at 4:55pm on Friday should not breach over the weekend, so
 * its clock only runs during business hours.
 *
 * Timezone handling here is deliberate rather than clever: all arithmetic
 * happens in the tenant's wall clock, and conversion back to an instant
 * re-resolves the offset, so a due date that lands on the far side of a DST
 * change is still the wall-clock time people expect.
 */

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  /** ISO weekday, 1 = Monday. */
  weekday: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hour12: false,
    });
    partsCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};

export function toWallClock(date: Date, tz: string): WallClock {
  const parts = formatter(tz).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    // Some locales render midnight as "24"; normalise it.
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: WEEKDAYS[get("weekday")] ?? 1,
  };
}

/**
 * Wall clock in a zone back to an instant. Two passes: guess using the offset
 * at the naive timestamp, then re-resolve at the guess. That converges for
 * every real zone, including the DST transitions where the first guess is an
 * hour out.
 */
export function fromWallClock(wc: Omit<WallClock, "weekday">, tz: string): Date {
  const naive = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, 0, 0);
  let guess = new Date(naive - offsetMs(new Date(naive), tz));
  guess = new Date(naive - offsetMs(guess, tz));
  return guess;
}

function offsetMs(at: Date, tz: string): number {
  const wc = toWallClock(at, tz);
  const asUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, 0, 0);
  // Seconds are dropped by the formatter above, so compare on the minute.
  return asUtc - Math.floor(at.getTime() / 60000) * 60000;
}

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

function isoDate(wc: WallClock): string {
  return `${wc.year}-${String(wc.month).padStart(2, "0")}-${String(wc.day).padStart(2, "0")}`;
}

function isWorkingDay(wc: WallClock, hours: BusinessHours): boolean {
  return hours.days.includes(wc.weekday) && !hours.holidays.includes(isoDate(wc));
}

function startOfNextDay(wc: WallClock, tz: string): WallClock {
  const next = new Date(fromWallClock({ ...wc, hour: 12, minute: 0 }, tz).getTime() + 86_400_000);
  const n = toWallClock(next, tz);
  return { ...n, hour: 0, minute: 0 };
}

/**
 * How far any of the business-hours walks below will go, in calendar days.
 *
 * Over a year, so no real ticket reaches it: a span that does is a
 * configuration error, and each walk falls back to calendar time rather than
 * looping on it.
 *
 * One constant, counted in calendar days by all three walks, because
 * `addBusinessMinutes` and `businessMinutesBetween` have to give up at the same
 * span to stay each other's inverse. They used to count loop iterations, and
 * the adding walk spent two of those on every working day (one to reach opening
 * time, one to use the day), so it gave up after roughly 233 calendar days
 * while the measuring walk went on to 400. A pause in between was measured in
 * business minutes and then added back as calendar ones, which moved the
 * deadline by about a third of the time the ticket had actually waited.
 */
const MAX_WALK_DAYS = 400;

/**
 * Add business minutes to an instant. Time outside the working window does not
 * count, and a start outside the window is pulled forward to the next opening.
 */
export function addBusinessMinutes(
  from: Date,
  minutes: number,
  hours: BusinessHours,
): Date {
  const open = minutesOfDay(hours.start);
  const close = minutesOfDay(hours.end);
  if (close <= open || hours.days.length === 0) {
    // A misconfigured window would loop forever. Fall back to calendar time.
    return new Date(from.getTime() + minutes * 60_000);
  }

  let wc = toWallClock(from, hours.tz);
  let remaining = minutes;
  // One iteration per calendar day, the same unit `businessMinutesBetween`
  // walks in. See `MAX_WALK_DAYS`.
  for (let day = 0; day < MAX_WALK_DAYS; day++) {
    if (day > 0) wc = startOfNextDay(wc, hours.tz);
    if (!isWorkingDay(wc, hours)) continue;

    // A start before opening is pulled forward to it.
    const nowMin = Math.max(wc.hour * 60 + wc.minute, open);
    if (nowMin >= close) continue;

    const availableToday = close - nowMin;
    if (remaining <= availableToday) {
      const end = nowMin + remaining;
      return fromWallClock(
        { ...wc, hour: Math.floor(end / 60), minute: end % 60 },
        hours.tz,
      );
    }
    remaining -= availableToday;
  }

  return new Date(from.getTime() + minutes * 60_000);
}

/**
 * Business minutes between two instants — the inverse of `addBusinessMinutes`.
 *
 * Needed because a pause has to be measured in the same units the deadline was
 * set in. A ticket that waits on a requester from Friday 4pm to Monday 10am has
 * been paused for 64 calendar hours and 3 business ones, and giving the service
 * desk back 64 hours of budget because a weekend happened would be a gift the
 * SLA never promised.
 */
export function businessMinutesBetween(
  from: Date,
  to: Date,
  hours: BusinessHours,
): number {
  if (to.getTime() <= from.getTime()) return 0;

  const open = minutesOfDay(hours.start);
  const close = minutesOfDay(hours.end);
  if (close <= open || hours.days.length === 0) {
    // Same fallback as addBusinessMinutes: a misconfigured window is calendar
    // time, so the two stay each other's inverse even when the config is wrong.
    return Math.round((to.getTime() - from.getTime()) / 60_000);
  }

  const end = to.getTime();
  let total = 0;
  let cursor = from;

  for (let day = 0; day < MAX_WALK_DAYS; day++) {
    const wc = toWallClock(cursor, hours.tz);

    if (isWorkingDay(wc, hours)) {
      const dayOpen = fromWallClock(
        { ...wc, hour: Math.floor(open / 60), minute: open % 60 },
        hours.tz,
      ).getTime();
      const dayClose = fromWallClock(
        { ...wc, hour: Math.floor(close / 60), minute: close % 60 },
        hours.tz,
      ).getTime();

      const segmentStart = Math.max(cursor.getTime(), dayOpen);
      const segmentEnd = Math.min(end, dayClose);
      if (segmentEnd > segmentStart) total += (segmentEnd - segmentStart) / 60_000;
      if (end <= dayClose) return Math.round(total);
    }

    cursor = fromWallClock(startOfNextDay(wc, hours.tz), hours.tz);
    if (cursor.getTime() >= end) return Math.round(total);
  }

  // The walk ran out. `addBusinessMinutes` runs out at the same span and falls
  // back to calendar time there, so this does too; returning the partial total
  // instead would break the inverse relationship between the two silently, and
  // under-credit by however much was left to walk.
  return Math.round((to.getTime() - from.getTime()) / 60_000);
}

/**
 * Subtract business minutes from an instant: the mirror of
 * `addBusinessMinutes`, walking backwards.
 *
 * It exists because `addBusinessMinutes` is not injective. Every instant
 * outside the working window maps to the same point — 19:31 and 22:00 on a
 * Wednesday both become 09:00 Thursday plus whatever was added — so shifting
 * two clocks through it independently can land them on the same instant and
 * silently destroy the gap between them. `shiftForPause` therefore moves the
 * deadline and *derives* the warning from it, which needs this direction.
 */
export function subtractBusinessMinutes(
  from: Date,
  minutes: number,
  hours: BusinessHours,
): Date {
  if (minutes <= 0) return from;

  const open = minutesOfDay(hours.start);
  const close = minutesOfDay(hours.end);
  if (close <= open || hours.days.length === 0) {
    return new Date(from.getTime() - minutes * 60_000);
  }

  let wc = toWallClock(from, hours.tz);
  let remaining = minutes;

  for (let day = 0; day < MAX_WALK_DAYS; day++) {
    if (day > 0) wc = endOfPreviousDay(wc, hours);
    if (!isWorkingDay(wc, hours)) continue;

    // A start after closing is pulled back to it.
    const nowMin = Math.min(wc.hour * 60 + wc.minute, close);
    if (nowMin <= open) continue;

    const availableToday = nowMin - open;
    if (remaining <= availableToday) {
      const end = nowMin - remaining;
      return fromWallClock(
        { ...wc, hour: Math.floor(end / 60), minute: end % 60 },
        hours.tz,
      );
    }
    remaining -= availableToday;
  }

  return new Date(from.getTime() - minutes * 60_000);
}

/** The previous day, positioned at closing time. */
function endOfPreviousDay(wc: WallClock, hours: BusinessHours): WallClock {
  const close = minutesOfDay(hours.end);
  const prev = new Date(
    fromWallClock({ ...wc, hour: 12, minute: 0 }, hours.tz).getTime() - 86_400_000,
  );
  const p = toWallClock(prev, hours.tz);
  return { ...p, hour: Math.floor(close / 60), minute: close % 60 };
}

/**
 * How long before a deadline the warning is due.
 *
 * One definition, used by the console badge, the portal, the API and the
 * warning sweep. There used to be two — a flat 15 minutes in `slaStatus` and a
 * share of the window in the notification query — which meant the console and
 * the email disagreed about whether a ticket was at risk.
 *
 * A share rather than a fixed lead, because a fixed one cannot be right at both
 * ends: 30 minutes is the entire window of a P1 and a rounding error on a P4.
 * There is deliberately no floor. A floor is a fixed lead wearing a percentage,
 * and on a fifteen-minute P1 target a 15-minute floor would mark the ticket at
 * risk the instant it arrived.
 */
export function warningLeadMinutes(
  windowMinutes: number,
  sharePercent: number,
): number {
  return Math.max(0, Math.round((windowMinutes * sharePercent) / 100));
}

export interface SlaTargets {
  firstResponseDueAt: Date;
  resolutionDueAt: Date;
  /** When each clock enters its warning window. */
  firstResponseWarnAt: Date;
  resolutionWarnAt: Date;
  /** True when this priority runs on a calendar clock rather than open hours. */
  calendar: boolean;
}

/**
 * Stamp both clocks from the moment the ticket arrived.
 *
 * `creditMinutes` is pause time the ticket has already been given back, and is
 * zero on a first stamp. A retriage runs this again on a ticket that may have
 * waited on its requester twice already; stamping it from `created_at` alone
 * used to hand that time back to the desk's account, so the deadline moved
 * earlier while `sla_paused_minutes` still said it had been credited.
 *
 * `resolvedMinutes` is time the ticket spent resolved or closed before a reopen
 * (`sla_resolved_minutes`, D3). It is credited to the resolution clock only:
 * a resolution stops that clock and nothing else.
 *
 * The credit is added to the window rather than to the instants, so both
 * deadlines and both warnings are walked from the same origin and keep their
 * gap by construction — the same reason `shiftForPause` derives the warning
 * rather than moving it.
 */
export function computeSla(
  createdAt: Date,
  priority: TicketPriority,
  settings: BusinessSettings,
  creditMinutes = 0,
  resolvedMinutes = 0,
): SlaTargets {
  const calendar = settings.sla.calendar_priorities.includes(priority);
  const first = settings.sla.first_response_minutes[priority];
  const resolve = settings.sla.resolution_minutes[priority];
  const share = settings.notifications.sla_warning_at_percent;
  const credit = Math.max(0, creditMinutes);
  const resolutionCredit = credit + Math.max(0, resolvedMinutes);

  const add = (from: Date, mins: number) =>
    calendar
      ? new Date(from.getTime() + mins * 60_000)
      : addBusinessMinutes(from, mins, settings.business_hours);

  const firstResponseDueAt = add(createdAt, first + credit);
  const resolutionDueAt = add(createdAt, resolve + resolutionCredit);

  // The warning instant is the deadline minus a share of the window, walked
  // back through the same calendar the deadline was walked forward through —
  // so on a business-hours clock the warning lands inside working time rather
  // than at 2am on a Sunday.
  return {
    firstResponseDueAt,
    resolutionDueAt,
    firstResponseWarnAt: add(createdAt, first - warningLeadMinutes(first, share) + credit),
    resolutionWarnAt: add(
      createdAt,
      resolve - warningLeadMinutes(resolve, share) + resolutionCredit,
    ),
    calendar,
  };
}

/**
 * How long a clock was stopped between two instants, in the units it runs in:
 * wall minutes on a calendar clock, working minutes on a business-hours one.
 * A ticket with no priority yet is on the calendar clock.
 */
export function stoppedMinutes(
  from: Date,
  to: Date,
  priority: TicketPriority | null,
  settings: BusinessSettings,
): number {
  const calendar =
    priority === null || settings.sla.calendar_priorities.includes(priority);
  return calendar
    ? Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000))
    : businessMinutesBetween(from, to, settings.business_hours);
}

/**
 * Where a reopen starts the new resolution clock. D3 in `docs/sla.md`.
 *
 * `resolved` and `closed` stop the resolution clock, because the ball is with
 * the requester, as it is in `awaiting_user`. The reopen credits the time since
 * `resolved_at`, measured for the priority the ticket has now, and the new
 * clock is stamped from `created_at` with every credit the ticket has. So it
 * starts with the margin the old clock had when it was resolved, and a ticket
 * resolved late is reopened exactly as late. When the priority changed while
 * the ticket was resolved, the same stamp puts it on the new priority's window.
 *
 * It used to be stamped with the pause credit alone, onto the deadline the old
 * clock had. A requester who reopened days after an on-time fix put the new
 * clock days past its deadline, and the reopen recorded that as a breach.
 *
 * `stamp` is null for a ticket with no priority, which has no clock to stamp.
 * The credit is still returned, and still counts, for the stamp its first
 * triage will make.
 */
export function stampForReopen(
  ticket: {
    created_at: Date | string;
    resolved_at: Date | string;
    sla_paused_minutes: number;
    sla_resolved_minutes: number;
  },
  reopenedAt: Date,
  priority: TicketPriority | null,
  settings: BusinessSettings,
): { resolvedMinutes: number; stamp: SlaTargets | null } {
  const resolvedMinutes = stoppedMinutes(
    new Date(ticket.resolved_at),
    reopenedAt,
    priority,
    settings,
  );
  return {
    resolvedMinutes,
    stamp:
      priority === null
        ? null
        : computeSla(
            new Date(ticket.created_at),
            priority,
            settings,
            ticket.sla_paused_minutes,
            ticket.sla_resolved_minutes + resolvedMinutes,
          ),
  };
}

export type SlaClock = "first_response" | "resolution";

/**
 * Where the clocks land after a pause.
 *
 * The deadlines and warning instants of every clock still running move forward
 * by the time the ticket spent waiting on somebody outside the service desk —
 * measured in the units the clock runs in, so a business-hours ticket is not
 * handed a weekend.
 *
 * A clock whose outcome is already recorded does not move. It used to: a first
 * response sent an hour late, followed by a pause of an hour or more, read
 * `met` after the resume, because the pause had carried its deadline past the
 * response. A pause gives back time the clock was stopped for, and a settled
 * clock was not stopped by it. A first response recorded during the pause is
 * credited the part before it when it is recorded (`shiftForFirstResponse`),
 * and is left alone here with the rest.
 *
 * Pure, and returns every field rather than mutating, because this is the
 * arithmetic that decides whether an SLA was met and it should be checkable
 * without a database.
 */
export interface SlaShift {
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  firstResponseWarnAt: Date | null;
  resolutionWarnAt: Date | null;
  /** Minutes the clock was stopped for, in the units the clock runs in. */
  pausedMinutes: number;
  /** Clocks left where they were because their outcome was already recorded. */
  settled: SlaClock[];
}

export function shiftForPause(
  clocks: {
    first_response_due_at: Date | string | null;
    resolution_due_at: Date | string | null;
    first_response_warn_at: Date | string | null;
    resolution_warn_at: Date | string | null;
    first_response_at?: Date | string | null;
    resolved_at?: Date | string | null;
  },
  pausedAt: Date,
  resumedAt: Date,
  priority: TicketPriority | null,
  settings: BusinessSettings,
): SlaShift {
  const calendar =
    priority === null || settings.sla.calendar_priorities.includes(priority);

  const pausedMinutes = stoppedMinutes(pausedAt, resumedAt, priority, settings);

  const move = (value: Date | string | null): Date | null => {
    if (!value) return null;
    const at = new Date(value);
    if (pausedMinutes === 0) return at;
    return calendar
      ? new Date(at.getTime() + pausedMinutes * 60_000)
      : addBusinessMinutes(at, pausedMinutes, settings.business_hours);
  };

  /**
   * The warning is derived from its deadline, not shifted alongside it.
   *
   * Shifting both independently looks equivalent and is not, because
   * `addBusinessMinutes` collapses every instant outside the working window
   * onto the next opening. A deadline of 19:31 and a warning of 18:56 — which
   * is exactly what the 0015 backfill produces for a ticket whose calendar-span
   * warning landed in the evening — both become 10:28 the next morning, and the
   * warning is destroyed: it now fires at the moment of breach.
   *
   * Measuring the lead in business minutes first and walking it back off the
   * shifted deadline makes the gap an invariant of the operation rather than a
   * coincidence of where the two instants happened to sit.
   */
  const deriveWarn = (
    warn: Date | string | null,
    due: Date | string | null,
    shiftedDue: Date | null,
  ): Date | null => {
    if (!warn) return null;
    if (!due || !shiftedDue) return move(warn);
    if (pausedMinutes === 0) return new Date(warn);

    const warnAt = new Date(warn);
    const dueAt = new Date(due);
    const calendarLead = Math.max(
      0,
      Math.round((dueAt.getTime() - warnAt.getTime()) / 60_000),
    );

    if (calendar) return new Date(shiftedDue.getTime() - calendarLead * 60_000);

    // The business lead is the right measure whenever the two instants have
    // working time between them. When they do not — an evening deadline with an
    // evening warning, which is precisely what the 0015 backfill writes for a
    // ticket whose calendar-derived warning landed out of hours — the business
    // lead is legitimately zero, and honouring it would leave the warning
    // firing at the moment of breach. Falling back to the calendar gap keeps
    // the warning useful without inventing a number: it is the separation the
    // ticket was actually carrying.
    const businessLead = businessMinutesBetween(warnAt, dueAt, settings.business_hours);
    const lead = businessLead > 0 ? businessLead : calendarLead;

    return subtractBusinessMinutes(shiftedDue, lead, settings.business_hours);
  };

  // Settled means an outcome judged against a deadline. An outcome with no
  // deadline yet has nothing to keep.
  //
  // A recorded breach with no outcome still moves. `SETTLED_CLOCKS` keeps such
  // a clock's deadline through a restamp, because a new priority's window would
  // change how late it was. A pause credit does not: it moves the deadline by
  // exactly the time the clock was stopped, so the clock stays as late as it
  // was (T8), and the recorded breach keeps it `breached` whatever the deadline
  // then says.
  const settled: SlaClock[] = [];
  if (clocks.first_response_at && clocks.first_response_due_at) settled.push("first_response");
  if (clocks.resolved_at && clocks.resolution_due_at) settled.push("resolution");

  const keep = (value: Date | string | null): Date | null => (value ? new Date(value) : null);
  const shiftClock = (
    clock: SlaClock,
    due: Date | string | null,
    warn: Date | string | null,
  ): [Date | null, Date | null] => {
    if (settled.includes(clock)) return [keep(due), keep(warn)];
    const shiftedDue = move(due);
    return [shiftedDue, deriveWarn(warn, due, shiftedDue)];
  };

  const [firstResponseDueAt, firstResponseWarnAt] = shiftClock(
    "first_response",
    clocks.first_response_due_at,
    clocks.first_response_warn_at,
  );
  const [resolutionDueAt, resolutionWarnAt] = shiftClock(
    "resolution",
    clocks.resolution_due_at,
    clocks.resolution_warn_at,
  );

  return {
    firstResponseDueAt,
    resolutionDueAt,
    firstResponseWarnAt,
    resolutionWarnAt,
    pausedMinutes,
    settled,
  };
}

/**
 * Where the first-response clock lands when the response is recorded while the
 * clock is stopped.
 *
 * The pause is credited up to the response and no further. The resume used to
 * credit the whole pause, including the part after the response, so a clock
 * that was already late when it stopped could read `met` once the requester
 * replied. Credited here, when the outcome is recorded, the result is final
 * from that moment: `shiftForPause` leaves a settled clock alone, and nothing
 * between the response and the resume can change what it reads.
 *
 * A clock that had already breached when it stopped keeps its deadline. The
 * credit preserves how late it was, so it could only turn the result into
 * `met` in one case: a business-hours deadline at closing time, paused out of
 * hours, which is late by the calendar and by no working minutes (the T8
 * exception in `docs/sla.md`). There it would record `met` against a breach
 * the console had already reported. Reading the stopped clock with
 * `slaStatus` asks the same question the console asked, and a recorded breach
 * answers it the same way.
 */
export function shiftForFirstResponse(
  clocks: {
    first_response_due_at: Date | string | null;
    first_response_warn_at: Date | string | null;
    first_response_breached_at?: Date | string | null;
  },
  pausedAt: Date,
  respondedAt: Date,
  priority: TicketPriority | null,
  settings: BusinessSettings,
): { dueAt: Date | null; warnAt: Date | null; creditMinutes: number } {
  const stoppedLate =
    slaStatus({
      first_response_at: null,
      resolved_at: null,
      first_response_due_at: clocks.first_response_due_at,
      resolution_due_at: null,
      sla_paused_at: pausedAt,
      first_response_breached_at: clocks.first_response_breached_at,
    }).firstResponse === "breached";

  // A clock that stopped late is credited nothing: the pause is measured from
  // its start to its start.
  const shift = shiftForPause(
    {
      first_response_due_at: clocks.first_response_due_at,
      first_response_warn_at: clocks.first_response_warn_at,
      resolution_due_at: null,
      resolution_warn_at: null,
    },
    pausedAt,
    stoppedLate ? pausedAt : respondedAt,
    priority,
    settings,
  );
  return {
    dueAt: shift.firstResponseDueAt,
    warnAt: shift.firstResponseWarnAt,
    creditMinutes: shift.pausedMinutes,
  };
}

/** The columns `slaStatus` reads. */
export interface SlaColumns {
  first_response_at: Date | string | null;
  resolved_at: Date | string | null;
  first_response_due_at: Date | string | null;
  resolution_due_at: Date | string | null;
  first_response_warn_at?: Date | string | null;
  resolution_warn_at?: Date | string | null;
  sla_paused_at?: Date | string | null;
  sla_paused_minutes?: number | null;
  /** Set once the first-response clock's breach is recorded. Never cleared. */
  first_response_breached_at?: Date | string | null;
  /**
   * Whether the current resolution clock's breach is recorded. The resolution
   * target keeps its history in `resolution_breached_at`, which a reopen does
   * not clear. This flag describes the clock running now, and a reopen does.
   */
  resolution_clock_breached?: boolean | null;
}

export type SlaState = "on_track" | "due_soon" | "breached" | "met" | "none" | "paused";

export interface SlaStatus {
  firstResponse: SlaState;
  resolution: SlaState;
  /**
   * Minutes until the nearest open target; negative when breached. While the
   * clock is stopped this is how late it was when it stopped, and does not grow.
   */
  minutesToNearest: number | null;
  /** True while the clock is stopped waiting on somebody outside the desk. */
  paused: boolean;
  /** Business minutes this ticket has spent paused, across every cycle. */
  pausedMinutes: number;
}

/**
 * What each clock is doing, right now.
 *
 * The only place that answers this question. The console queue, the ticket
 * page, the requester portal and the REST API all call it, and the warning
 * sweep selects on the same stored `*_warn_at` instants it reads here — so
 * "due soon" means one thing across the product.
 *
 * It used to mean two. This function decided `due_soon` at a flat
 * `Math.max(15, 0)` minutes — a dead expression whose second argument was
 * never filled in — while the sweep used a share of the window. A P4 with a
 * three-day target therefore sat `on_track` in the console and produced a
 * warning email at the same moment.
 *
 * A paused clock reports `paused` rather than a countdown. Showing "4h left"
 * on a ticket whose clock is stopped invites somebody to act on a number that
 * is not moving, and showing the stale countdown is how the old behaviour hid.
 *
 * A paused clock is also read at the instant it stopped, not at `now`. The
 * stored deadline does not move until the pause ends, so comparing it with the
 * wall clock reported `breached` on a ticket whose deadline merely passed while
 * the requester held it — and then `on_track` again the moment they replied,
 * which looked like a resume clearing a breach. It was never a breach: the
 * clock was not running. Reading the stopped instant keeps the one breach a
 * pause genuinely cannot undo, the one that had happened before it began.
 *
 * A recorded breach is final for its clock. Without that, the reading and the
 * record could disagree. A downgrade gives a late ticket a later deadline, and
 * an answer that arrived before it would read `met` while the record says the
 * clock breached. The record wins because it is what happened. A reopen starts
 * a new resolution clock, and `resolution_clock_breached` describes that one.
 *
 * The full state machine, and the test that pins each transition, is in
 * `docs/sla.md`.
 */
export function slaStatus(ticket: SlaColumns, now: Date = new Date()): SlaStatus {
  const paused = Boolean(ticket.sla_paused_at);
  // The instant the clocks are read at: now, unless they are stopped.
  const asOf = paused ? new Date(ticket.sla_paused_at!).getTime() : now.getTime();

  const evaluate = (
    due: Date | string | null,
    warnAt: Date | string | null | undefined,
    metAt: Date | string | null,
    breachRecorded: boolean,
  ): [SlaState, number | null] => {
    if (!due) return ["none", null];
    const dueMs = new Date(due).getTime();

    // A clock that has already stopped is answered by the outcome, not by the
    // wall clock — and that stays true whether or not the ticket is paused. A
    // clock whose breach is recorded cannot be met, whenever the outcome came.
    if (metAt) {
      return [!breachRecorded && new Date(metAt).getTime() <= dueMs ? "met" : "breached", null];
    }

    const minutes = Math.round((dueMs - asOf) / 60_000);

    // Breach is still reportable while paused when the deadline had gone past
    // before the clock stopped: the pause cannot un-breach it, and the resume
    // gives back only the time it waited, so it is still exactly as late after.
    // A recorded breach is reported whatever the deadline says now.
    if (breachRecorded || minutes < 0) return ["breached", minutes];
    if (paused) return ["paused", null];

    // No warning instant (a ticket stamped before this column existed, or one
    // never triaged) degrades to on_track rather than guessing a window.
    if (!warnAt) return ["on_track", minutes];
    return [now.getTime() >= new Date(warnAt).getTime() ? "due_soon" : "on_track", minutes];
  };

  const [firstResponse, fMin] = evaluate(
    ticket.first_response_due_at,
    ticket.first_response_warn_at,
    ticket.first_response_at,
    Boolean(ticket.first_response_breached_at),
  );
  const [resolution, rMin] = evaluate(
    ticket.resolution_due_at,
    ticket.resolution_warn_at,
    ticket.resolved_at,
    Boolean(ticket.resolution_clock_breached),
  );

  const open = [fMin, rMin].filter((m): m is number => m !== null);
  return {
    firstResponse,
    resolution,
    minutesToNearest: open.length ? Math.min(...open) : null,
    paused,
    pausedMinutes: ticket.sla_paused_minutes ?? 0,
  };
}

/** A breach a clock shows: which clock, and the deadline it missed. */
export interface SlaBreach {
  clock: SlaClock;
  /** The deadline the clock missed, which is the instant it breached. */
  breachedAt: Date;
}

/**
 * The breaches a ticket shows and has not recorded yet.
 *
 * A breach is whatever `slaStatus` reports as `breached`, so the record and
 * the console cannot disagree about what counts. A deadline that passed while
 * the clock was stopped is not one (T6), one that passed before the pause is
 * (T5), and an outcome after its deadline is (T10).
 *
 * What recording adds is memory. `slaStatus` answers from the deadline the row
 * has now, and a running clock's deadline can still move, so a downgrade of a
 * ticket that was already late used to make the breach disappear. Every clock
 * writer calls this under the row lock before it changes anything, so what the
 * row shows is recorded before the change can move it.
 *
 * A recorded clock reports nothing more, which is what makes a second
 * evaluation a no-op. For the resolution clock "recorded" means the clock
 * running now (`resolution_clock_breached`). A breach from before a reopen is
 * history and does not stop the new clock's own breach from being recorded.
 *
 * Pure, so the rule is checkable without a database. The writes are in
 * `tickets.ts`.
 */
export function unrecordedBreaches(ticket: SlaColumns, now: Date = new Date()): SlaBreach[] {
  const status = slaStatus(ticket, now);
  const breaches: SlaBreach[] = [];
  if (
    status.firstResponse === "breached" &&
    !ticket.first_response_breached_at &&
    ticket.first_response_due_at
  ) {
    breaches.push({ clock: "first_response", breachedAt: new Date(ticket.first_response_due_at) });
  }
  if (
    status.resolution === "breached" &&
    !ticket.resolution_clock_breached &&
    ticket.resolution_due_at
  ) {
    breaches.push({ clock: "resolution", breachedAt: new Date(ticket.resolution_due_at) });
  }
  return breaches;
}
