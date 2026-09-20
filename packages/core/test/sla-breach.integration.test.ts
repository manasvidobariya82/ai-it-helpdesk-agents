import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as core from "../src/index.js";

/**
 * SLA breaches as recorded facts, through a real database. D1 in docs/sla.md.
 *
 * A breach used to be only a reading: `slaStatus` compared the deadline the row
 * had now with the wall clock. A running clock's deadline can still move, so a
 * downgrade of a ticket that was already late stamped a later deadline and the
 * breach was gone, and nothing anywhere said it had happened.
 *
 * Every test here runs the same matrix against both clocks. A breach is
 * recorded once the deadline passes. Nothing done after that removes it: not a
 * priority change either way, a pause, a resume or a retriage. A second
 * evaluation records nothing more, and an event that cannot be written takes
 * the record and the change that triggered it down with it. A reopen leaves
 * the old clock's breach in history and starts a new clock.
 *
 * Every priority runs on the calendar clock here, as in `sla-pause`, so "five
 * minutes late" means five minutes whatever day the suite runs on.
 */

let available = true;
let businessId = "";
let system: core.TenantContext;
let agent: core.TenantContext;
let requesterEmail = "";

type Clock = core.SlaClock;
const CLOCKS: Clock[] = ["first_response", "resolution"];

interface Row {
  status: string;
  priority: string | null;
  created_at: Date;
  first_response_at: Date | null;
  resolved_at: Date | null;
  sla_paused_at: Date | null;
  first_response_due_at: Date | null;
  resolution_due_at: Date | null;
  first_response_breached_at: Date | null;
  resolution_breached_at: Date | null;
  resolution_clock_breached: boolean;
}

async function row(id: string): Promise<Row> {
  return (await core.queryOne<Row>(
    `select status::text as status, priority::text as priority, created_at,
            first_response_at, resolved_at, sla_paused_at,
            first_response_due_at, resolution_due_at,
            first_response_breached_at, resolution_breached_at, resolution_clock_breached
       from tickets where id = $1`,
    [id],
  ))!;
}

const dueOf = (r: Row, clock: Clock) =>
  clock === "first_response" ? r.first_response_due_at : r.resolution_due_at;
const breachedAtOf = (r: Row, clock: Clock) =>
  clock === "first_response" ? r.first_response_breached_at : r.resolution_breached_at;

/** What the console, the portal and the API would show for one clock. */
async function reading(id: string, clock: Clock): Promise<core.SlaState> {
  const s = core.slaStatus((await core.getTicket(system, id))!);
  return clock === "first_response" ? s.firstResponse : s.resolution;
}

const breachEvents = async (id: string) =>
  (await core.eventsFor(system, id)).filter((e) => e.payload.stage === "sla_breach");

/** A triaged ticket with both clocks stamped from `created_at`. */
async function triagedTicket(subject: string, priority: core.TicketPriority = "P2") {
  const intake = await core.intakeMessage(system, {
    source: "email",
    source_message_id: `sla-breach-${crypto.randomUUID()}@example.test`,
    requester_email: requesterEmail,
    requester_name: "Test Person",
    subject,
    body: "Something is broken.",
    attachments: [],
    received_at: new Date(),
    meta: {},
  });
  await retriage(intake.ticket.id, priority);
  return intake.ticket.id;
}

/**
 * The write a retriage makes. `applyTriage` stamps from `created_at`, carrying
 * the credit the row has when it locks it.
 */
async function retriage(
  id: string,
  priority: core.TicketPriority,
  status: core.TicketStatus = "triaged",
): Promise<void> {
  await core.applyTriage(
    agent,
    id,
    {
      category: "software",
      subcategory: "broken",
      priority,
      confidence: 0.9,
      resolution_path: "human_only",
      status,
    },
    await core.getSettings(businessId),
  );
}

/** What a stamp for `priority` would be on this ticket now. */
async function owed(id: string, priority: core.TicketPriority) {
  const t = (await core.getTicket(system, id))!;
  const settings = await core.getSettings(businessId);
  return core.computeSla(
    new Date(t.created_at),
    priority,
    settings,
    t.sla_paused_minutes,
    t.sla_resolved_minutes,
  );
}

/**
 * Let `minutes` pass: every instant on the row moves that far into the past,
 * the recorded breaches included, so the ticket's history stays consistent and
 * a restamp from `created_at` lands where it would have.
 */
async function elapse(id: string, minutes: number): Promise<void> {
  await core.query(
    `update tickets
        set created_at = created_at - $2::int * interval '1 minute',
            first_response_due_at = first_response_due_at - $2::int * interval '1 minute',
            first_response_warn_at = first_response_warn_at - $2::int * interval '1 minute',
            resolution_due_at = resolution_due_at - $2::int * interval '1 minute',
            resolution_warn_at = resolution_warn_at - $2::int * interval '1 minute',
            first_response_at = first_response_at - $2::int * interval '1 minute',
            resolved_at = resolved_at - $2::int * interval '1 minute',
            sla_paused_at = sla_paused_at - $2::int * interval '1 minute',
            first_response_breached_at = first_response_breached_at - $2::int * interval '1 minute',
            resolution_breached_at = resolution_breached_at - $2::int * interval '1 minute'
      where id = $1`,
    [id, minutes],
  );
}

/**
 * A P2 ticket whose `clock` passed its deadline five minutes ago, with nothing
 * recorded: no sweep has run and nothing has written to it since.
 *
 * P2 is an hour to first response and eight to resolution. For the resolution
 * clock the ticket was answered ten minutes in, so only that clock is late.
 */
async function lateTicket(subject: string, clock: Clock): Promise<string> {
  const id = await triagedTicket(subject, "P2");
  if (clock === "resolution") {
    await core.query(
      `update tickets set first_response_at = created_at + interval '10 minutes' where id = $1`,
      [id],
    );
    await elapse(id, 480 + 5);
  } else {
    await elapse(id, 60 + 5);
  }
  return id;
}

/** The write that records the clock's outcome. */
const settle = (id: string, clock: Clock): Promise<void> =>
  clock === "first_response"
    ? core.markFirstResponse(agent, id)
    : core.setStatus(system, id, "resolved");

/** Make every `sla_breach` event for this ticket fail to write, for the duration. */
async function withFailingBreachEvents(id: string, fn: () => Promise<void>): Promise<void> {
  const name = `breach_fail_${id.replace(/-/g, "")}`;
  await core.query(
    `create function ${name}() returns trigger language plpgsql as $$
     begin
       if new.ticket_id = '${id}' and new.payload ->> 'stage' = 'sla_breach' then
         raise exception 'injected breach event failure';
       end if;
       return new;
     end $$`,
  );
  await core.query(
    `create trigger ${name} before insert on ticket_events
       for each row execute function ${name}()`,
  );
  try {
    await fn();
  } finally {
    await core.query(`drop trigger if exists ${name} on ticket_events`);
    await core.query(`drop function if exists ${name}()`);
  }
}

/**
 * Force one interleaving of two writers: hold the row lock, start `racer`, wait
 * until it is blocked on the lock, then make the other writer's change and
 * commit. The same helper as in `sla-pause`.
 */
async function raceBehindLock(
  id: string,
  racer: () => Promise<void>,
  sql: string,
  params: unknown[],
): Promise<void> {
  let pending!: Promise<void>;
  await core.tx(async (client) => {
    await client.query(`select 1 from tickets where id = $1 for update`, [id]);
    const { rows } = await client.query<{ pid: number }>(`select pg_backend_pid() as pid`);
    pending = racer();
    pending.catch(() => {});
    await blockedBy(rows[0]!.pid);
    await client.query(sql, params);
  });
  await pending;
}

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
      `sla-breach-${stamp}`,
      JSON.stringify({ sla: { calendar_priorities: ["P1", "P2", "P3", "P4"] } }),
      `support-breach-${stamp}@acme.test`,
    ],
  );
  businessId = r!.id;
  system = core.systemContext(businessId, { requestId: "sla-breach-test" });
  agent = core.agentContext(businessId);
  requesterEmail = `breach-person-${stamp}@acme.test`;
}, 60_000);

afterAll(async () => {
  if (businessId) await core.purgeBusinessUnaudited(businessId);
  await core.closeQueues().catch(() => {});
  await core.closePool().catch(() => {});
});

function guard(): boolean {
  if (!available) console.warn("[sla-breach] no database reachable; skipping. npm run db:up");
  return !available;
}

// ---------------------------------------------------------------------------
// The matrix, once per clock.
// ---------------------------------------------------------------------------

for (const clock of CLOCKS) {
  describe(`the ${clock.replace("_", "-")} clock`, () => {
    it("T17 a breach is recorded once the deadline passes, at the deadline it missed", async () => {
      if (guard()) return expect(available).toBe(false);

      const id = await lateTicket(`${clock}: late`, clock);
      const before = await row(id);
      expect(await breachEvents(id)).toHaveLength(0);
      expect(await core.ticketsWithUnrecordedBreaches(system, 10_000)).toContain(id);

      expect(await core.recordSlaBreaches(system, id)).toEqual([clock]);

      const after = await row(id);
      expect(breachedAtOf(after, clock)).toEqual(dueOf(before, clock));
      if (clock === "resolution") expect(after.resolution_clock_breached).toBe(true);
      expect(await reading(id, clock)).toBe("breached");

      const [event] = await breachEvents(id);
      expect(event!.actor).toBe("system");
      expect(event!.payload).toEqual({
        stage: "sla_breach",
        clock,
        breached_at: dueOf(before, clock)!.toISOString(),
        priority: "P2",
        outcome_at: null,
        paused: false,
        recorded_by: "sweep",
      });
      expect(await core.ticketsWithUnrecordedBreaches(system, 10_000)).not.toContain(id);
    }, 60_000);

    it("I9 a second evaluation records nothing, however many run at once", async () => {
      if (guard()) return expect(available).toBe(false);

      const id = await lateTicket(`${clock}: evaluated four times`, clock);
      const results = await Promise.all([1, 2, 3].map(() => core.recordSlaBreaches(system, id)));
      expect(results.flat()).toEqual([clock]);
      expect(await core.recordSlaBreaches(system, id)).toEqual([]);
      await core.recordDueBreaches(system);

      expect(await breachEvents(id)).toHaveLength(1);
    }, 60_000);

    it("T10 T17 the write that records a late outcome records the breach with it", async () => {
      if (guard()) return expect(available).toBe(false);

      const id = await lateTicket(`${clock}: answered late`, clock);
      const before = await row(id);
      await settle(id, clock);

      expect(await reading(id, clock)).toBe("breached");
      const [event] = await breachEvents(id);
      expect(event!.payload).toMatchObject({
        clock,
        breached_at: dueOf(before, clock)!.toISOString(),
        recorded_by: clock === "first_response" ? "first_response" : "status_change",
      });
      expect(await breachEvents(id)).toHaveLength(1);
    }, 60_000);

    it("T15 I9 raising the priority after the breach keeps it, against the deadline it missed", async () => {
      if (guard()) return expect(available).toBe(false);

      const id = await lateTicket(`${clock}: late, then raised`, clock);
      await core.recordSlaBreaches(system, id);
      const recorded = await row(id);

      await core.overrideClassification(system, id, { category: "software", priority: "P1" });

      const after = await row(id);
      expect(after.priority).toBe("P1");
      // P1's window would make it later than it was. It keeps the deadline it
      // missed, and the restamp says so.
      expect(dueOf(after, clock)).toEqual(dueOf(recorded, clock));
      expect(breachedAtOf(after, clock)).toEqual(breachedAtOf(recorded, clock));
      expect(await reading(id, clock)).toBe("breached");
      expect(await breachEvents(id)).toHaveLength(1);
      for (const e of (await core.eventsFor(system, id)).filter(
        (e) => e.payload.stage === "sla_restamp",
      )) {
        expect(e.payload.settled).toContain(clock);
      }
    }, 60_000);

    it("T15 I9 lowering the priority after the breach cannot turn the outcome into met", async () => {
      if (guard()) return expect(available).toBe(false);

      const id = await lateTicket(`${clock}: late, lowered, then settled`, clock);
      await core.recordSlaBreaches(system, id);
      const recorded = await row(id);

      await core.overrideClassification(system, id, { category: "software", priority: "P4" });
      expect(dueOf(await row(id), clock)).toEqual(dueOf(recorded, clock));

      // P4's window would have put this deadline hours after the outcome below.
      const p4 = await owed(id, "P4");
      const p4Due = clock === "first_response" ? p4.firstResponseDueAt : p4.resolutionDueAt;
      expect(p4Due.getTime()).toBeGreaterThan(Date.now());

      await settle(id, clock);
      expect(await reading(id, clock)).toBe("breached");
      expect(breachedAtOf(await row(id), clock)).toEqual(breachedAtOf(recorded, clock));
      expect(await breachEvents(id)).toHaveLength(1);
    }, 60_000);

    it("T15 I9 lowering the priority records a breach nobody had recorded, before it restamps", async () => {
      if (guard()) return expect(available).toBe(false);

      // The defect D1 exists for. Nothing had recorded this breach, and the
      // downgrade used to stamp a deadline hours ahead: the console went back
      // to a countdown, and no record anywhere said the clock had breached.
      const id = await lateTicket(`${clock}: late, then lowered first`, clock);
      const before = await row(id);

      await core.overrideClassification(system, id, { category: "software", priority: "P4" });

      const after = await row(id);
      expect(after.priority).toBe("P4");
      expect(breachedAtOf(after, clock)).toEqual(dueOf(before, clock));
      expect(dueOf(after, clock)).toEqual(dueOf(before, clock));
      expect(await reading(id, clock)).toBe("breached");

      const events = await core.eventsFor(system, id);
      const breach = events.findIndex((e) => e.payload.stage === "sla_breach");
      expect(events[breach]!.actor).toBe("system");
      expect(events[breach]!.payload).toMatchObject({
        clock,
        priority: "P2",
        recorded_by: "reclassification",
      });
      // Recorded before the restamp that would have moved it.
      const restamp = events.findIndex((e) => e.payload.stage === "sla_restamp");
      if (restamp >= 0) expect(breach).toBeLessThan(restamp);
    }, 60_000);

    it("T5 T8 I9 a pause and a resume after the breach keep it", async () => {
      if (guard()) return expect(available).toBe(false);

      const id = await lateTicket(`${clock}: late, then waiting`, clock);
      await core.recordSlaBreaches(system, id);
      const recorded = await row(id);

      await core.setStatus(agent, id, "awaiting_user");
      expect(await reading(id, clock)).toBe("breached");

      await core.query(
        `update tickets set sla_paused_at = now() - interval '90 minutes' where id = $1`,
        [id],
      );
      await core.setStatus(agent, id, "triaged");

      expect(await reading(id, clock)).toBe("breached");
      expect(breachedAtOf(await row(id), clock)).toEqual(breachedAtOf(recorded, clock));
      expect(await breachEvents(id)).toHaveLength(1);
    }, 60_000);

    it("T5 T17 a pause records a breach nobody had recorded", async () => {
      if (guard()) return expect(available).toBe(false);

      const id = await lateTicket(`${clock}: late, then paused first`, clock);
      const before = await row(id);
      await core.setStatus(agent, id, "awaiting_user");

      expect(breachedAtOf(await row(id), clock)).toEqual(dueOf(before, clock));
      const [event] = await breachEvents(id);
      expect(event!.payload).toMatchObject({ clock, recorded_by: "status_change" });
    }, 60_000);

    it("T14 I9 a retriage after the breach keeps it", async () => {
      if (guard()) return expect(available).toBe(false);

      const id = await lateTicket(`${clock}: late, then retriaged`, clock);
      await core.recordSlaBreaches(system, id);
      const recorded = await row(id);

      await retriage(id, "P4");

      const after = await row(id);
      expect(after.priority).toBe("P4");
      expect(dueOf(after, clock)).toEqual(dueOf(recorded, clock));
      expect(await reading(id, clock)).toBe("breached");
      expect(await breachEvents(id)).toHaveLength(1);
    }, 60_000);

    it("T14 I9 a retriage records a breach nobody had recorded, before it restamps", async () => {
      if (guard()) return expect(available).toBe(false);

      const id = await lateTicket(`${clock}: late, then retriaged first`, clock);
      const before = await row(id);

      await retriage(id, "P4");

      const after = await row(id);
      expect(breachedAtOf(after, clock)).toEqual(dueOf(before, clock));
      expect(dueOf(after, clock)).toEqual(dueOf(before, clock));
      expect(await reading(id, clock)).toBe("breached");
      const [event] = await breachEvents(id);
      expect(event!.payload).toMatchObject({ clock, priority: "P2", recorded_by: "retriage" });
    }, 60_000);

    it("I6 I9 records nothing, and changes nothing, when the breach event cannot be written", async () => {
      if (guard()) return expect(available).toBe(false);

      // The record, its event, and the change that saw the breach land
      // together or not at all. A downgrade and an outcome both record first,
      // so neither can go through without the record.
      const id = await lateTicket(`${clock}: event write fails`, clock);
      const before = await row(id);

      await withFailingBreachEvents(id, async () => {
        await expect(core.recordSlaBreaches(system, id)).rejects.toThrow(
          /injected breach event failure/,
        );
        await expect(
          core.overrideClassification(system, id, { category: "hardware", priority: "P4" }),
        ).rejects.toThrow(/injected breach event failure/);
        await expect(settle(id, clock)).rejects.toThrow(/injected breach event failure/);
        await expect(retriage(id, "P4")).rejects.toThrow(/injected breach event failure/);
      });

      expect(await row(id)).toEqual(before);
      expect(await breachEvents(id)).toHaveLength(0);
      expect((await core.getTicket(system, id))!.category).toBe("software");

      // With the log writable again, the same call records it.
      expect(await core.recordSlaBreaches(system, id)).toEqual([clock]);
      expect(await breachEvents(id)).toHaveLength(1);
    }, 60_000);
  });
}

// ---------------------------------------------------------------------------
// A reopen: the old clock's result is history, and a new clock starts.
// ---------------------------------------------------------------------------

describe("a reopen", () => {
  it("T13 I9 leaves the old clock's breach in history and starts a clock that is running", async () => {
    if (guard()) return expect(available).toBe(false);

    // Resolved five minutes late, so the resolution clock records its breach.
    const id = await lateTicket("resolved late, relabelled, reopened", "resolution");
    await core.setStatus(system, id, "resolved");
    const resolved = await row(id);
    const firstBreach = resolved.resolution_breached_at!;
    expect(firstBreach).toEqual(resolved.resolution_due_at);
    expect(resolved.resolution_clock_breached).toBe(true);

    // Re-marked P4 while resolved: the settled clock keeps its deadline (T15).
    await core.overrideClassification(system, id, { category: "software", priority: "P4" });
    expect((await row(id)).resolution_due_at).toEqual(resolved.resolution_due_at);

    // The reopen stamps a new clock for P4, three days long.
    await core.setStatus(system, id, "reopened");
    const reopened = await row(id);
    const p4 = await owed(id, "P4");
    expect(reopened.resolution_due_at).toEqual(p4.resolutionDueAt);
    // The old clock's breach is history, and the new clock runs on its own.
    expect(reopened.resolution_breached_at).toEqual(firstBreach);
    expect(reopened.resolution_clock_breached).toBe(false);
    expect(await reading(id, "resolution")).toBe("on_track");
    expect(await breachEvents(id)).toHaveLength(1);

    // The log says the clock ended, and how.
    const restarted = (await core.eventsFor(system, id)).filter(
      (e) => e.payload.stage === "sla_clock",
    );
    expect(restarted).toHaveLength(1);
    expect(restarted[0]!.payload).toMatchObject({
      clock: "resolution",
      action: "restarted",
      previous: "breached",
    });

    // Three days on, the new clock breaches in its turn. It records its own
    // breach, and the target's first breach stays the first.
    const untilDue = Math.ceil((p4.resolutionDueAt.getTime() - Date.now()) / 60_000);
    await elapse(id, untilDue + 5);
    const aged = await row(id);
    expect(await core.recordSlaBreaches(system, id)).toEqual(["resolution"]);

    const after = await row(id);
    expect(after.resolution_clock_breached).toBe(true);
    expect(after.resolution_breached_at).toEqual(aged.resolution_breached_at);
    const events = await breachEvents(id);
    expect(events).toHaveLength(2);
    expect(events[0]!.payload.breached_at).toBe(firstBreach.toISOString());
    expect(events[1]!.payload).toMatchObject({
      breached_at: aged.resolution_due_at!.toISOString(),
      priority: "P4",
      recorded_by: "sweep",
    });
  }, 60_000);

  it("T13 I9 D3 a reopen days after an on-time resolution records no breach", async () => {
    if (guard()) return expect(available).toBe(false);

    // Answered and resolved at once, with the whole eight hours in hand, then
    // three days pass before the requester reopens it. Before D3 the new clock
    // went back onto the old deadline, three days gone, and the reopen
    // recorded a permanent breach for time the ticket spent resolved.
    const id = await triagedTicket("resolved in time, reopened days later");
    await core.markFirstResponse(agent, id);
    await core.setStatus(system, id, "resolved");
    await elapse(id, 3 * 24 * 60);
    const resolved = await row(id);

    await core.setStatus(system, id, "reopened");

    const reopened = await row(id);
    const t = (await core.getTicket(system, id))!;
    expect(t.sla_resolved_minutes).toBeGreaterThanOrEqual(3 * 24 * 60);
    expect(t.sla_resolved_minutes).toBeLessThanOrEqual(3 * 24 * 60 + 1);
    expect(reopened.resolution_due_at!.getTime() - resolved.resolution_due_at!.getTime()).toBe(
      t.sla_resolved_minutes * 60_000,
    );
    expect(reopened.resolution_due_at).toEqual((await owed(id, "P2")).resolutionDueAt);
    expect(reopened.resolution_clock_breached).toBe(false);
    expect(reopened.resolution_breached_at).toBeNull();
    expect(await reading(id, "resolution")).toBe("on_track");
    expect(await breachEvents(id)).toHaveLength(0);

    // The first response was settled before the resolution and is untouched.
    expect(reopened.first_response_due_at).toEqual(resolved.first_response_due_at);

    // The log carries the credit, which is how a replay rebuilds it.
    const events = await core.eventsFor(system, id);
    expect(events.find((e) => e.payload.stage === "sla_clock")!.payload).toMatchObject({
      action: "restarted",
      previous: "met",
      resolved_minutes: t.sla_resolved_minutes,
    });
    expect(events.find((e) => e.payload.stage === "sla_restamp")!.payload).toMatchObject({
      reason: "reopen",
      resolved_minutes: t.sla_resolved_minutes,
      resolution_due_at: reopened.resolution_due_at!.toISOString(),
    });
  }, 60_000);

  it("T13 I9 D3 a reopen of a ticket resolved late is exactly as late, and records the new clock's breach", async () => {
    if (guard()) return expect(available).toBe(false);

    // Resolved five minutes late, then resolved for an hour. The hour is
    // credited, so the new clock is five minutes late at the reopen, as the old
    // one was at the resolution, and the reopen records its breach. The
    // target's first breach stays the first.
    const id = await lateTicket("resolved late, reopened an hour on", "resolution");
    await core.setStatus(system, id, "resolved");
    await elapse(id, 60);
    const resolved = await row(id);

    await core.setStatus(system, id, "reopened");

    const reopened = await row(id);
    const credited = (await core.getTicket(system, id))!.sla_resolved_minutes;
    expect(credited).toBeGreaterThanOrEqual(60);
    expect(credited).toBeLessThanOrEqual(61);
    expect(reopened.resolution_due_at!.getTime() - resolved.resolution_due_at!.getTime()).toBe(
      credited * 60_000,
    );
    expect(reopened.resolution_breached_at).toEqual(resolved.resolution_breached_at);
    expect(reopened.resolution_clock_breached).toBe(true);
    const events = await breachEvents(id);
    expect(events).toHaveLength(2);
    expect(events[1]!.payload).toMatchObject({
      breached_at: reopened.resolution_due_at!.toISOString(),
      recorded_by: "status_change",
      outcome_at: null,
    });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The sweep's candidates.
// ---------------------------------------------------------------------------

describe("the breach sweep", () => {
  it("T6 does not count a deadline that passed while the clock was stopped", async () => {
    if (guard()) return expect(available).toBe(false);

    // Paused with the deadline ahead, and a week goes by. Written in that
    // order: pausing after the deadline would record a real breach (T5).
    const id = await triagedTicket("deadline passed while waiting");
    await core.setStatus(agent, id, "awaiting_user");
    await core.query(
      `update tickets
          set sla_paused_at = now() - interval '7 days',
              first_response_due_at = now() - interval '20 minutes',
              first_response_warn_at = now() - interval '30 minutes'
        where id = $1`,
      [id],
    );

    expect(await core.ticketsWithUnrecordedBreaches(system, 10_000)).not.toContain(id);
    expect(await core.recordSlaBreaches(system, id)).toEqual([]);
    expect(await reading(id, "first_response")).toBe("paused");
  }, 60_000);

  it("T17 records a late result from before breaches were recorded, with its outcome", async () => {
    if (guard()) return expect(available).toBe(false);

    // A ticket resolved late before this release: the row says so, and no
    // write will come to record it. The sweep is the backfill.
    const id = await triagedTicket("resolved late last month");
    await core.query(
      `update tickets
          set status = 'closed',
              first_response_at = created_at + interval '10 minutes',
              resolved_at = resolution_due_at + interval '30 minutes',
              closed_at = resolution_due_at + interval '30 minutes'
        where id = $1`,
      [id],
    );
    await elapse(id, 2 * 24 * 60);
    const before = await row(id);

    expect(await core.ticketsWithUnrecordedBreaches(system, 10_000)).toContain(id);
    expect(await core.recordSlaBreaches(system, id)).toEqual(["resolution"]);

    const [event] = await breachEvents(id);
    expect(event!.payload).toMatchObject({
      clock: "resolution",
      breached_at: before.resolution_due_at!.toISOString(),
      outcome_at: before.resolved_at!.toISOString(),
      recorded_by: "sweep",
    });
  }, 60_000);

  it("leaves out a clock that was met", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await triagedTicket("answered and resolved in time");
    await core.markFirstResponse(agent, id);
    await core.setStatus(system, id, "resolved");
    await elapse(id, 3 * 24 * 60);

    expect(await core.ticketsWithUnrecordedBreaches(system, 10_000)).not.toContain(id);
    expect(await core.recordSlaBreaches(system, id)).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Two writers at once.
// ---------------------------------------------------------------------------

describe("a breach and a writer at once", () => {
  it("T15 I9 a downgrade waiting on the sweep finds the breach recorded and keeps it", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await lateTicket("lowered as the sweep ran", "first_response");
    const before = await row(id);

    await raceBehindLock(
      id,
      () => core.overrideClassification(system, id, { category: "software", priority: "P4" }),
      // The sweep's write, as far as the row and the log are concerned.
      `with recorded as (
         update tickets set first_response_breached_at = first_response_due_at
          where id = $1
         returning id)
       insert into ticket_events (ticket_id, actor, kind, payload)
       select id, 'system', 'note',
              '{"stage":"sla_breach","clock":"first_response","recorded_by":"sweep"}'::jsonb
         from recorded`,
      [id],
    );

    const after = await row(id);
    expect(after.priority).toBe("P4");
    expect(after.first_response_due_at).toEqual(before.first_response_due_at);
    expect(await reading(id, "first_response")).toBe("breached");
    expect(await breachEvents(id)).toHaveLength(1);
  }, 60_000);

  /**
   * A P2 ticket half an hour old that a person raises to P1 while a retriage
   * to P3 waits on the lock. P1's fifteen minutes went a quarter of an hour
   * ago, so the upgrade breaches the first response. The resolution clock, at
   * four hours, is still running.
   *
   * `recorded` says whether the upgrade's write records that breach, as
   * `overrideClassification` does, or leaves it for whoever locks the row next.
   */
  async function retriageBehindUpgrade(subject: string, recorded: boolean) {
    const id = await triagedTicket(subject, "P2");
    await elapse(id, 30);
    const p1 = await owed(id, "P1");

    await raceBehindLock(
      id,
      () => retriage(id, "P3"),
      `with upgraded as (
         update tickets
            set priority = 'P1',
                first_response_due_at = $2::timestamptz, resolution_due_at = $3,
                first_response_warn_at = $4, resolution_warn_at = $5,
                first_response_breached_at = case when $6::boolean then $2::timestamptz end
          where id = $1
         returning id)
       insert into ticket_events (ticket_id, actor, kind, payload)
       select id, 'system', 'note',
              '{"stage":"sla_breach","clock":"first_response","recorded_by":"reclassification"}'::jsonb
         from upgraded
        where $6::boolean`,
      [
        id,
        p1.firstResponseDueAt,
        p1.resolutionDueAt,
        p1.firstResponseWarnAt,
        p1.resolutionWarnAt,
        recorded,
      ],
    );
    return { id, p1 };
  }

  it("T14 I9 a retriage waiting on an upgrade that breached keeps the breach and stamps the rest", async () => {
    if (guard()) return expect(available).toBe(false);

    const { id, p1 } = await retriageBehindUpgrade("raised as it was retriaged", true);

    // The retriage is the last write, so its priority stands. The clock the
    // upgrade breached keeps the deadline it missed, and the running clock is
    // stamped for P3 from the row the retriage locked.
    const after = await row(id);
    expect(after.priority).toBe("P3");
    expect(after.first_response_due_at).toEqual(p1.firstResponseDueAt);
    expect(after.first_response_breached_at).toEqual(p1.firstResponseDueAt);
    expect(after.resolution_due_at).toEqual((await owed(id, "P3")).resolutionDueAt);
    expect(await reading(id, "first_response")).toBe("breached");
    expect(await reading(id, "resolution")).toBe("on_track");
    expect(await breachEvents(id)).toHaveLength(1);
  }, 60_000);

  it("T14 T17 a retriage waiting on an upgrade records the breach it finds before restamping", async () => {
    if (guard()) return expect(available).toBe(false);

    // The breach appeared in the row while the retriage was waiting. It is
    // read under the lock, so it is recorded before the P3 stamp could put
    // the deadline back in the future.
    const { id, p1 } = await retriageBehindUpgrade("raised, unrecorded, as it was retriaged", false);

    const after = await row(id);
    expect(after.priority).toBe("P3");
    expect(after.first_response_due_at).toEqual(p1.firstResponseDueAt);
    expect(after.first_response_breached_at).toEqual(p1.firstResponseDueAt);
    expect(await reading(id, "first_response")).toBe("breached");
    const events = await breachEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      clock: "first_response",
      priority: "P1",
      recorded_by: "retriage",
    });
  }, 60_000);

  it("I9 a sweep, a downgrade and a resolution at once record each breach once", async () => {
    if (guard()) return expect(available).toBe(false);

    // Both clocks late. Whatever order the lock serves them in, each clock's
    // breach is recorded by whichever gets there first, and never again.
    const id = await triagedTicket("everything at once");
    await elapse(id, 480 + 5);
    const before = await row(id);

    await Promise.all([
      core.recordSlaBreaches(system, id),
      core.overrideClassification(system, id, { category: "software", priority: "P4" }),
      core.setStatus(system, id, "resolved"),
      core.recordSlaBreaches(system, id),
    ]);

    const after = await row(id);
    expect(after.first_response_breached_at).toEqual(before.first_response_due_at);
    expect(after.resolution_breached_at).toEqual(before.resolution_due_at);
    expect(after.first_response_due_at).toEqual(before.first_response_due_at);
    expect(after.resolution_due_at).toEqual(before.resolution_due_at);
    const s = core.slaStatus((await core.getTicket(system, id))!);
    expect(s.firstResponse).toBe("breached");
    expect(s.resolution).toBe("breached");
    const events = await breachEvents(id);
    expect(events.map((e) => e.payload.clock).sort()).toEqual(["first_response", "resolution"]);
  }, 60_000);
});
