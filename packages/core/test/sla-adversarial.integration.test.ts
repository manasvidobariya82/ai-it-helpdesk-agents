import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as core from "../src/index.js";

/**
 * Adversarial audit of the SLA pause.
 *
 * Written to break the implementation rather than to demonstrate it. Every test
 * here targets something the existing suite does not exercise: two writers at
 * once, a stale writer, a pause that spans a weekend against a real calendar,
 * and the question of what the database and the event log disagree about when
 * one of the two writes fails.
 *
 * The fixtures use a *business-hours* tenant, unlike `sla-pause.integration`,
 * which puts every priority on the calendar clock so its assertions can talk in
 * wall-clock minutes. That convenience is exactly what hides a business-time
 * bug, so it is not repeated here.
 */

let available = true;
let businessId = "";
let system: core.TenantContext;
let agent: core.TenantContext;
let requesterEmail = "";

/** Mon-Fri 09:00-17:30 London, with a holiday Monday. */
const HOURS = {
  tz: "Europe/London",
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "17:30",
  holidays: ["2026-09-21"],
};

interface Row {
  status: string;
  sla_paused_at: Date | null;
  sla_paused_minutes: number;
  first_response_due_at: Date | null;
  resolution_due_at: Date | null;
  first_response_warn_at: Date | null;
  resolution_warn_at: Date | null;
  resolved_at: Date | null;
}

async function row(id: string): Promise<Row> {
  return (await core.queryOne<Row>(
    `select status::text as status, sla_paused_at, sla_paused_minutes,
            first_response_due_at, resolution_due_at,
            first_response_warn_at, resolution_warn_at, resolved_at
       from tickets where id = $1`,
    [id],
  ))!;
}

async function makeTicket(subject: string, priority: core.TicketPriority = "P3") {
  const intake = await core.intakeMessage(system, {
    source: "email",
    source_message_id: `adv-${crypto.randomUUID()}@example.test`,
    requester_email: requesterEmail,
    requester_name: "Test Person",
    subject,
    body: "Something is broken.",
    attachments: [],
    received_at: new Date(),
    meta: {},
  });
  await core.applyTriage(
    system,
    intake.ticket.id,
    {
      category: "software",
      subcategory: "broken",
      priority,
      confidence: 0.9,
      resolution_path: "human_only",
      status: "triaged",
    },
    await core.getSettings(businessId),
  );
  return intake.ticket.id;
}

/** Wind an open pause back, so a measurable amount of time appears to have passed. */
async function windPauseBack(id: string, minutes: number): Promise<Date> {
  const r = await core.queryOne<{ sla_paused_at: Date }>(
    `update tickets set sla_paused_at = now() - ($2 || ' minutes')::interval
      where id = $1 returning sla_paused_at`,
    [id, String(minutes)],
  );
  return r!.sla_paused_at;
}

/**
 * A pause long enough to contain working time whenever the suite runs.
 *
 * On this business-hours tenant a pause wound back a couple of hours from
 * 05:00, or from a Saturday, is worth nothing: no time is credited, nothing
 * moves, and a test that needs the deadline to move fails for reasons that
 * have nothing to do with the code. A week always holds at least four working
 * days, the holiday included.
 */
const A_WEEK = 7 * 24 * 60;

/**
 * The business minutes a pause starting at `pausedAt` is worth right now.
 *
 * The assertions below compare against this rather than against the wall-clock
 * minutes the pause was wound back by, because this tenant runs P3 on business
 * hours: a pause wound back 90 minutes at 18:00 London is worth 59 working
 * minutes, not 90. Asserting the wall-clock number would only pass when the
 * suite happens to run inside the working window, and would pass for the wrong
 * reason when it did.
 */
async function expectedCredit(pausedAt: Date): Promise<number> {
  const settings = await core.getSettings(businessId);
  return core.businessMinutesBetween(pausedAt, new Date(), settings.business_hours);
}

/** Wait until Postgres reports some session blocked on a lock held by `pid`. */
async function blockedBy(pid: number): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const r = await core.queryOne<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))`,
      [pid],
    );
    if (r!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the racer never reached the row lock");
}

/** One minute of slack for the seconds a test spends between the two reads. */
function near(actual: number, expected: number, slack = 1): void {
  expect(actual).toBeGreaterThanOrEqual(expected - slack);
  expect(actual).toBeLessThanOrEqual(expected + slack);
}

beforeAll(async () => {
  try {
    await core.query("select 1");
  } catch {
    available = false;
    return;
  }

  const stamp = Date.now();
  const r = await core.queryOne<{ id: string }>(
    `insert into businesses (name, type, settings, intake_address)
     values ($1, 'it_services', $2::jsonb, $3) returning id`,
    [
      `adv-${stamp}`,
      JSON.stringify({
        business_hours: HOURS,
        // P3 on business hours; P1 stays on the calendar clock.
        sla: { calendar_priorities: ["P1"] },
        notifications: { sla_warning_at_percent: 20 },
      }),
      `adv-${stamp}@acme.test`,
    ],
  );
  businessId = r!.id;
  system = core.systemContext(businessId, { requestId: "adv" });
  agent = core.agentContext(businessId);
  requesterEmail = `adv-person-${stamp}@acme.test`;
}, 60_000);

afterAll(async () => {
  if (businessId) await core.purgeBusinessUnaudited(businessId);
  await core.closeQueues().catch(() => {});
  await core.closePool().catch(() => {});
});

const guard = () => !available;

// ---------------------------------------------------------------------------
// Scenario A / B / C / H — two writers at once.
// ---------------------------------------------------------------------------

describe("concurrency", () => {
  it("A: two simultaneous pauses produce one pause", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await makeTicket("double pause");
    await Promise.all([
      core.setStatus(agent, id, "awaiting_user"),
      core.setStatus(agent, id, "awaiting_user"),
    ]);

    const after = await row(id);
    expect(after.status).toBe("awaiting_user");
    expect(after.sla_paused_at).not.toBeNull();
    expect(after.sla_paused_minutes).toBe(0);
  }, 60_000);

  it("A2: two simultaneous pauses write one pause event, not two", async () => {
    if (guard()) return expect(available).toBe(false);

    // The database converges on one pause because `coalesce` is evaluated
    // against the locked row. The event log is written afterwards, from a value
    // each request read *before* the update — so both can believe they started
    // the pause. A replay then sees two starts and one end.
    const id = await makeTicket("double pause event");
    await Promise.all([
      core.setStatus(agent, id, "awaiting_user"),
      core.setStatus(agent, id, "awaiting_user"),
    ]);

    const events = await core.eventsFor(system, id);
    const starts = events.filter(
      (e) => e.payload.stage === "sla_pause" && e.payload.action === "paused",
    );
    expect(starts.length).toBe(1);
  }, 60_000);

  it("B: two simultaneous resumes shift the deadline exactly once", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await makeTicket("double resume");
    const before = await row(id);
    await core.setStatus(agent, id, "awaiting_user");
    const pausedAt = await windPauseBack(id, 90);
    const owed = await expectedCredit(pausedAt);

    await Promise.all([
      core.setStatus(agent, id, "triaged"),
      core.setStatus(agent, id, "triaged"),
    ]);

    const after = await row(id);
    expect(after.sla_paused_at).toBeNull();
    // Exactly one credit, not two. `owed` is the business minutes the pause was
    // actually worth, so a double credit would show as roughly twice it.
    near(after.sla_paused_minutes, owed);

    // The deadline moves by the same amount, in business time.
    const settings = await core.getSettings(businessId);
    const movedBusiness = core.businessMinutesBetween(
      before.resolution_due_at!,
      after.resolution_due_at!,
      settings.business_hours,
    );
    near(movedBusiness, owed);
  }, 60_000);

  it("B2: two simultaneous resumes write one resume event", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await makeTicket("double resume event");
    await core.setStatus(agent, id, "awaiting_user");
    await windPauseBack(id, 30);
    await Promise.all([
      core.setStatus(agent, id, "triaged"),
      core.setStatus(agent, id, "triaged"),
    ]);

    const events = await core.eventsFor(system, id);
    const ends = events.filter(
      (e) => e.payload.stage === "sla_pause" && e.payload.action === "resumed",
    );
    expect(ends.length).toBe(1);
  }, 60_000);

  it("C: a requester reply racing an admin resume credits the pause once", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await makeTicket("reply races admin");
    const ticket = await core.getTicket(system, id);
    const before = await row(id);
    await core.setStatus(agent, id, "awaiting_user");
    const pausedAt = await windPauseBack(id, 45);
    const owed = await expectedCredit(pausedAt);

    await Promise.all([
      core.intakeMessage(system, {
        source: "email",
        source_message_id: `adv-race-${crypto.randomUUID()}@example.test`,
        requester_email: requesterEmail,
        requester_name: "Test Person",
        subject: `Re: ${core.subjectTag(id)} ${ticket!.subject}`,
        body: "Here is the answer.",
        attachments: [],
        received_at: new Date(),
        meta: {},
      }),
      core.setStatus(agent, id, "in_progress"),
    ]);

    const after = await row(id);
    expect(after.sla_paused_at).toBeNull();
    // Credited once, whichever of the two writers got there first.
    near(after.sla_paused_minutes, owed);

    const settings = await core.getSettings(businessId);
    const movedBusiness = core.businessMinutesBetween(
      before.resolution_due_at!,
      after.resolution_due_at!,
      settings.business_hours,
    );
    near(movedBusiness, owed);
  }, 60_000);

  it("H: a resume that waited on another resume finds the pause over", async () => {
    if (guard()) return expect(available).toBe(false);

    // A resume held up behind another writer that resumed the same ticket.
    // `setStatus` reads the row under its lock, so once it gets the row the
    // pause is already over: no second credit and no second event. It used to
    // read first and rely on a guard on the update to refuse the stale shift.
    const id = await makeTicket("stale worker");
    await core.setStatus(agent, id, "awaiting_user");
    await windPauseBack(id, A_WEEK);

    let pending!: Promise<void>;
    await core.tx(async (client) => {
      await client.query(`select 1 from tickets where id = $1 for update`, [id]);
      const { rows } = await client.query<{ pid: number }>(`select pg_backend_pid() as pid`);
      pending = core.setStatus(agent, id, "triaged");
      pending.catch(() => {});
      await blockedBy(rows[0]!.pid);
      // The other writer's resume, as far as the row is concerned.
      await client.query(
        `update tickets
            set status = 'in_progress', sla_paused_at = null,
                sla_paused_minutes = sla_paused_minutes + 60
          where id = $1`,
        [id],
      );
    });
    await pending;

    const after = await row(id);
    expect(after.status).toBe("triaged");
    expect(after.sla_paused_at).toBeNull();
    expect(after.sla_paused_minutes).toBe(60);
    const events = await core.eventsFor(system, id);
    expect(
      events.filter((e) => e.payload.stage === "sla_pause" && e.payload.action === "resumed"),
    ).toHaveLength(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Scenario D / E / G / J — lifecycle semantics.
// ---------------------------------------------------------------------------

describe("lifecycle semantics", () => {
  it("D: resolving while paused credits the active pause exactly once", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await makeTicket("resolved while paused");
    const before = await row(id);
    await core.setStatus(agent, id, "awaiting_user");
    const pausedAt = await windPauseBack(id, 75);
    const owed = await expectedCredit(pausedAt);
    await core.setStatus(system, id, "resolved");

    const after = await row(id);
    expect(after.status).toBe("resolved");
    expect(after.sla_paused_at).toBeNull();
    near(after.sla_paused_minutes, owed);
    expect(after.resolved_at).not.toBeNull();

    const settings = await core.getSettings(businessId);
    near(
      core.businessMinutesBetween(
        before.resolution_due_at!,
        after.resolution_due_at!,
        settings.business_hours,
      ),
      owed,
    );
  }, 60_000);

  it("E: an already-breached ticket stays breached through a pause", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await makeTicket("late then paused");
    await core.query(
      `update tickets
          set first_response_at = now() - interval '5 hours',
              resolution_due_at = now() - interval '2 hours',
              resolution_warn_at = now() - interval '3 hours'
        where id = $1`,
      [id],
    );
    expect(core.slaStatus((await core.getTicket(system, id))!).resolution).toBe(
      "breached",
    );

    await core.setStatus(agent, id, "awaiting_user");
    expect(core.slaStatus((await core.getTicket(system, id))!).resolution).toBe(
      "breached",
    );
  }, 60_000);

  it("E2: a deadline that passes during a pause is never reported as a breach", async () => {
    if (guard()) return expect(available).toBe(false);

    // This test used to be called "a resume can clear an existing breach", and
    // it was the reason the audit flagged breach semantics as an open product
    // decision. The setup says otherwise: the pause is wound back a week, so it
    // began long before the deadline 20 minutes ago. The deadline passed while
    // the requester held the ticket.
    //
    // `slaStatus` compared that not-yet-shifted deadline with the wall clock,
    // so the ticket read `breached` for as long as it stayed paused and then
    // `on_track` the moment the resume gave the week back. Nothing was
    // cleared; a stopped clock had been read as a running one. It is now read
    // at the instant it stopped, and reports `paused` throughout.
    //
    // A breach that happened *before* the pause is E above, and does stick.
    // docs/sla.md, T6 and T7.
    //
    // The history is written in order: paused while the deadline was still
    // ahead, then a week passes. Pausing a ticket whose deadline had already
    // gone would record that breach, correctly (T17), and winding the pause
    // back afterwards would not unrecord it.
    const id = await makeTicket("deadline passed while waiting");
    await core.query(
      `update tickets set first_response_at = now() - interval '5 hours' where id = $1`,
      [id],
    );
    await core.setStatus(agent, id, "awaiting_user");
    await windPauseBack(id, A_WEEK);
    await core.query(
      `update tickets
          set resolution_due_at = now() - interval '20 minutes',
              resolution_warn_at = now() - interval '40 minutes'
        where id = $1`,
      [id],
    );

    const paused = await core.getTicket(system, id);
    expect(core.slaStatus(paused!).resolution).toBe("paused");

    await core.setStatus(agent, id, "triaged");
    const after = await core.getTicket(system, id);
    expect(core.slaStatus(after!).resolution).not.toBe("breached");
  }, 60_000);

  it("G: three cycles accumulate, and each shifts the deadline once", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await makeTicket("long conversation");
    const before = await row(id);

    let owed = 0;
    for (const minutes of [20, 35, 50]) {
      await core.setStatus(agent, id, "awaiting_user");
      const pausedAt = await windPauseBack(id, minutes);
      owed += await expectedCredit(pausedAt);
      await core.setStatus(agent, id, "triaged");
    }
    await core.setStatus(system, id, "resolved");

    const after = await row(id);
    // Every cycle counted, none counted twice.
    near(after.sla_paused_minutes, owed, 3);

    const settings = await core.getSettings(businessId);
    near(
      core.businessMinutesBetween(
        before.resolution_due_at!,
        after.resolution_due_at!,
        settings.business_hours,
      ),
      owed,
      3,
    );

    const events = await core.eventsFor(system, id);
    const pauses = events.filter((e) => e.payload.stage === "sla_pause");
    expect(pauses.filter((e) => e.payload.action === "paused").length).toBe(3);
    expect(pauses.filter((e) => e.payload.action === "resumed").length).toBe(3);

    const credited = pauses
      .filter((e) => e.payload.action === "resumed")
      .reduce((n, e) => n + ((e.payload.paused_minutes as number) ?? 0), 0);
    expect(credited).toBe(after.sla_paused_minutes);
  }, 60_000);

  it("J: a warning instant already passed when the pause starts moves with it", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await makeTicket("warned then paused");
    await core.query(
      `update tickets
          set first_response_at = now(),
              resolution_due_at = now() + interval '30 minutes',
              resolution_warn_at = now() - interval '5 minutes'
        where id = $1`,
      [id],
    );
    expect(core.slaStatus((await core.getTicket(system, id))!).resolution).toBe(
      "due_soon",
    );

    const before = await row(id);
    await core.setStatus(agent, id, "awaiting_user");
    await windPauseBack(id, A_WEEK);
    await core.setStatus(agent, id, "triaged");

    // The lead the ticket carried, in the units its clock runs in: the working
    // minutes between warning and deadline, or — when both sit out of hours,
    // as they do whenever this suite runs in the evening — the 35 calendar
    // minutes, since working time alone would say zero and put the warning on
    // top of the breach.
    const settings = await core.getSettings(businessId);
    const worked = core.businessMinutesBetween(
      before.resolution_warn_at!,
      before.resolution_due_at!,
      settings.business_hours,
    );
    const lead = worked > 0 ? worked : 35;

    // Both instants moved, the ticket is out of its warning window again, and
    // the warning still comes that far ahead of the deadline.
    const after = await row(id);
    expect(after.resolution_due_at!.getTime()).toBeGreaterThan(
      after.resolution_warn_at!.getTime(),
    );
    expect(
      core.businessMinutesBetween(
        after.resolution_warn_at!,
        after.resolution_due_at!,
        settings.business_hours,
      ),
    ).toBe(lead);
    expect(core.slaStatus((await core.getTicket(system, id))!).resolution).toBe(
      "on_track",
    );
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Scenario F — a real business calendar, including a holiday.
// ---------------------------------------------------------------------------

describe("business calendar", () => {
  it("F: a Friday-to-Monday pause credits working time only", async () => {
    if (guard()) return expect(available).toBe(false);

    // Friday 2026-09-18 16:00 London to Tuesday 2026-09-22 10:00, with Monday
    // the 21st configured as a holiday. Working time is 90 minutes on Friday
    // (16:00-17:30) plus 60 on Tuesday (09:00-10:00) = 150. The weekend and
    // the holiday contribute nothing.
    const settings = await core.getSettings(businessId);
    const credited = core.businessMinutesBetween(
      new Date("2026-09-18T15:00:00Z"),
      new Date("2026-09-22T09:00:00Z"),
      settings.business_hours,
    );
    expect(credited).toBe(150);
  }, 60_000);

  it("F2: the same pause on a calendar-clock priority credits the whole span", async () => {
    if (guard()) return expect(available).toBe(false);

    const settings = await core.getSettings(businessId);
    const shift = core.shiftForPause(
      {
        first_response_due_at: new Date("2026-09-22T12:00:00Z"),
        resolution_due_at: new Date("2026-09-22T12:00:00Z"),
        first_response_warn_at: new Date("2026-09-22T11:00:00Z"),
        resolution_warn_at: new Date("2026-09-22T11:00:00Z"),
      },
      new Date("2026-09-18T15:00:00Z"),
      new Date("2026-09-22T09:00:00Z"),
      "P1",
      settings,
    );
    // 3 days 18 hours = 5,400 minutes.
    expect(shift.pausedMinutes).toBe(5_400);
  }, 60_000);

  it("F3: a business-hours ticket paused over the weekend keeps a sane deadline", async () => {
    if (guard()) return expect(available).toBe(false);

    const settings = await core.getSettings(businessId);
    const shift = core.shiftForPause(
      {
        first_response_due_at: new Date("2026-09-22T12:00:00Z"),
        resolution_due_at: new Date("2026-09-22T12:00:00Z"),
        first_response_warn_at: new Date("2026-09-22T11:00:00Z"),
        resolution_warn_at: new Date("2026-09-22T11:00:00Z"),
      },
      new Date("2026-09-18T15:00:00Z"),
      new Date("2026-09-22T09:00:00Z"),
      "P3",
      settings,
    );
    expect(shift.pausedMinutes).toBe(150);
    // Tuesday 13:00 London + 150 working minutes = Tuesday 15:30.
    expect(
      shift.resolutionDueAt!.toLocaleString("en-GB", {
        timeZone: "Europe/London",
        hour12: false,
      }),
    ).toContain("15:30");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Atomicity between the row and the log.
// ---------------------------------------------------------------------------

describe("the row and the log", () => {
  it("leaves no pause unexplained on the timeline", async () => {
    if (guard()) return expect(available).toBe(false);

    // Every row mutation the pause makes must have a matching event. This walks
    // a lifecycle and asserts the two agree, which is the property the P1
    // replay criterion rests on.
    const id = await makeTicket("row and log agree");
    await core.setStatus(agent, id, "awaiting_user");
    await windPauseBack(id, 25);
    await core.setStatus(agent, id, "triaged");

    const after = await row(id);
    const events = await core.eventsFor(system, id);
    const resumed = events.filter(
      (e) => e.payload.stage === "sla_pause" && e.payload.action === "resumed",
    );
    expect(resumed.length).toBe(1);
    expect(resumed[0]!.payload.paused_minutes).toBe(after.sla_paused_minutes);
    // The event carries the resulting deadline, so a replay can state it rather
    // than recompute it from a calendar it would have to reimplement.
    expect(resumed[0]!.payload.resolution_due_at).toBe(
      after.resolution_due_at!.toISOString(),
    );
  }, 60_000);

  it("moves nothing when the event cannot be written", async () => {
    if (guard()) return expect(available).toBe(false);

    // The test above passes whether or not the two writes share a transaction,
    // because nothing fails in it. This one makes the event insert fail, for
    // this ticket only, and requires the row to be exactly as it was: no
    // status change, no credit, no moved deadline. Written as two statements on
    // the pool, the update would already have committed by the time the insert
    // threw.
    const id = await makeTicket("event write fails");
    await core.setStatus(agent, id, "awaiting_user");
    await windPauseBack(id, A_WEEK);
    const before = await row(id);

    const fn = `adv_fail_events_${id.replace(/-/g, "")}`;
    await core.query(
      `create function ${fn}() returns trigger language plpgsql as $$
       begin
         if new.ticket_id = '${id}' then raise exception 'injected event failure'; end if;
         return new;
       end $$`,
    );
    await core.query(
      `create trigger ${fn} before insert on ticket_events
         for each row execute function ${fn}()`,
    );
    try {
      await expect(core.setStatus(agent, id, "triaged")).rejects.toThrow(
        /injected event failure/,
      );
    } finally {
      await core.query(`drop trigger if exists ${fn} on ticket_events`);
      await core.query(`drop function if exists ${fn}()`);
    }

    expect(await row(id)).toEqual(before);
    const events = await core.eventsFor(system, id);
    expect(
      events.filter((e) => e.payload.stage === "sla_pause" && e.payload.action === "resumed"),
    ).toHaveLength(0);
  }, 60_000);

  it("T15 I6 changes nothing when the restamp event cannot be written", async () => {
    if (guard()) return expect(available).toBe(false);

    // The same property for a priority change: the new priority, the moved
    // deadlines and the event that explains them land together or not at all.
    const id = await makeTicket("restamp event write fails");
    const before = await row(id);

    const fn = `adv_fail_restamp_${id.replace(/-/g, "")}`;
    await core.query(
      `create function ${fn}() returns trigger language plpgsql as $$
       begin
         if new.ticket_id = '${id}' then raise exception 'injected event failure'; end if;
         return new;
       end $$`,
    );
    await core.query(
      `create trigger ${fn} before insert on ticket_events
         for each row execute function ${fn}()`,
    );
    try {
      await expect(
        core.overrideClassification(system, id, { category: "hardware", priority: "P2" }),
      ).rejects.toThrow(/injected event failure/);
    } finally {
      await core.query(`drop trigger if exists ${fn} on ticket_events`);
      await core.query(`drop function if exists ${fn}()`);
    }

    expect(await row(id)).toEqual(before);
    const ticket = await core.getTicket(system, id);
    expect(ticket!.priority).toBe("P3");
    expect(ticket!.category).toBe("software");
  }, 60_000);

  it("T12 I6 records no first response when the credit event cannot be written", async () => {
    if (guard()) return expect(available).toBe(false);

    // The response, the credited deadline and the event that explains it land
    // together. A week-long pause always holds working time, so the credit is
    // never zero and the event is always written.
    const id = await makeTicket("credit event write fails");
    await core.setStatus(agent, id, "awaiting_user");
    await windPauseBack(id, A_WEEK);
    const before = await row(id);

    const fn = `adv_fail_credit_${id.replace(/-/g, "")}`;
    await core.query(
      `create function ${fn}() returns trigger language plpgsql as $$
       begin
         if new.ticket_id = '${id}' then raise exception 'injected event failure'; end if;
         return new;
       end $$`,
    );
    await core.query(
      `create trigger ${fn} before insert on ticket_events
         for each row execute function ${fn}()`,
    );
    try {
      await expect(core.markFirstResponse(agent, id)).rejects.toThrow(/injected event failure/);
    } finally {
      await core.query(`drop trigger if exists ${fn} on ticket_events`);
      await core.query(`drop function if exists ${fn}()`);
    }

    expect(await row(id)).toEqual(before);
    expect((await core.getTicket(system, id))!.first_response_at).toBeNull();

    // And with the log writable again, the same call goes through.
    await core.markFirstResponse(agent, id);
    const after = await row(id);
    expect(after.first_response_due_at!.getTime()).toBeGreaterThan(
      before.first_response_due_at!.getTime(),
    );
    const credited = (await core.eventsFor(system, id)).filter(
      (e) => e.payload.stage === "sla_pause" && e.payload.action === "credited",
    );
    expect(credited).toHaveLength(1);
  }, 60_000);
});
