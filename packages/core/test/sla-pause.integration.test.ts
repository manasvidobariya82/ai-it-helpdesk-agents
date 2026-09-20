import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as core from "../src/index.js";

/**
 * The SLA pause, through a real database.
 *
 * `sla.test.ts` covers the arithmetic with no database: how much business time
 * a pause consumed, where the clocks land afterwards, what a paused ticket
 * reports. This covers the part that only a database can answer — that
 * `setStatus` stamps and clears the pause correctly across repeated cycles,
 * that a requester's reply restarts the clock, and that the warning sweep and
 * the console agree about a ticket whose deadline has moved.
 *
 * The bug being pinned: before this, `computeSla` stamped both deadlines from
 * `created_at` and nothing ever moved them. A ticket parked in `awaiting_user`
 * kept spending its resolution budget, so the resolution SLA measured how
 * quickly requesters answer their email.
 *
 * Skips itself when no database is reachable, like the other integration
 * suites: `npm run db:up && npm run db:migrate`.
 */

let available = true;
let businessId = "";
let system: core.TenantContext;
let agent: core.TenantContext;
let requesterEmail = "";
let intakeToken = "";

interface Clocks {
  status: string;
  priority: string | null;
  sla_paused_at: Date | null;
  sla_paused_minutes: number;
  first_response_due_at: Date | null;
  resolution_due_at: Date | null;
  first_response_warn_at: Date | null;
  resolution_warn_at: Date | null;
  first_response_at: Date | null;
}

async function clocks(id: string): Promise<Clocks> {
  return (await core.queryOne<Clocks>(
    `select status::text as status, priority::text as priority,
            sla_paused_at, sla_paused_minutes, first_response_at,
            first_response_due_at, resolution_due_at,
            first_response_warn_at, resolution_warn_at
       from tickets where id = $1`,
    [id],
  ))!;
}

/**
 * A triaged ticket with both clocks stamped.
 *
 * Priorities are all on the calendar clock in this tenant's settings, so the
 * assertions below can talk in wall-clock minutes. The business-hours case is
 * exhaustively covered in `sla.test.ts`, which does not need a database to
 * prove it.
 */
async function triagedTicket(subject: string): Promise<string> {
  const intake = await core.intakeMessage(system, {
    source: "email",
    source_message_id: `sla-pause-${crypto.randomUUID()}@example.test`,
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
      priority: "P3",
      confidence: 0.9,
      resolution_path: "human_only",
      status: "triaged",
    },
    await core.getSettings(businessId),
  );
  return intake.ticket.id;
}

/** Wind an existing pause backwards, so a measurable amount of time has passed. */
async function pausedFor(id: string, minutes: number): Promise<void> {
  await core.query(
    `update tickets set sla_paused_at = now() - ($2 || ' minutes')::interval
      where id = $1`,
    [id, String(minutes)],
  );
}

const minutesBetween = (a: Date | null, b: Date | null): number =>
  Math.round((new Date(a!).getTime() - new Date(b!).getTime()) / 60_000);

/**
 * Let `minutes` pass: every instant on the row moves that far into the past.
 *
 * `pausedFor` can only say how long ago a pause began. A first response
 * recorded during a pause needs time to pass after it too, before the resume,
 * which is what separates crediting the pause up to the response from
 * crediting all of it.
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
            sla_paused_at = sla_paused_at - $2::int * interval '1 minute'
      where id = $1`,
    [id, minutes],
  );
}

/**
 * Force one interleaving of two writers, deterministically.
 *
 * Holds the ticket's row lock, starts `racer`, waits until Postgres reports it
 * blocked on that lock, then makes the other writer's change in the holding
 * transaction and commits. A racer that read the row before the lock and wrote
 * after it shows up here as a lost write, every run, rather than one run in a
 * thousand.
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
  const row = await core.queryOne<{ id: string }>(
    `insert into businesses (name, type, settings, intake_address)
     values ($1, 'it_services', $2::jsonb, $3) returning id`,
    [
      `sla-pause-${stamp}`,
      JSON.stringify({
        // Every priority on the calendar clock, so "90 minutes paused" means
        // 90 minutes here whatever day the suite runs on.
        sla: { calendar_priorities: ["P1", "P2", "P3", "P4"] },
      }),
      `support-sla-${stamp}@acme.test`,
    ],
  );
  businessId = row!.id;
  system = core.systemContext(businessId, { requestId: "sla-pause-test" });
  agent = core.agentContext(businessId);
  requesterEmail = `person-${stamp}@acme.test`;

  const business = await core.getBusiness(businessId);
  intakeToken = business!.intake_token!;
}, 60_000);

afterAll(async () => {
  if (businessId) await core.purgeBusinessUnaudited(businessId);
  await core.closeQueues().catch(() => {});
  await core.closePool().catch(() => {});
});

function guard(): boolean {
  if (!available) {
    console.warn("[sla-pause] no database reachable; skipping. npm run db:up");
  }
  return !available;
}

// ---------------------------------------------------------------------------

describe("a ticket nobody is waiting on", () => {
  it("runs its clock the whole time", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await triagedTicket("ordinary ticket");
    const before = await clocks(id);
    expect(before.sla_paused_at).toBeNull();
    expect(before.sla_paused_minutes).toBe(0);

    // Statuses that are not `awaiting_user` leave the clock entirely alone.
    await core.setStatus(system, id, "in_progress");
    const after = await clocks(id);
    expect(after.sla_paused_at).toBeNull();
    expect(after.sla_paused_minutes).toBe(0);
    expect(after.resolution_due_at).toEqual(before.resolution_due_at);
    expect(after.resolution_warn_at).toEqual(before.resolution_warn_at);
  }, 60_000);
});

describe("waiting on the requester", () => {
  it("stops the clock on the way in", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await triagedTicket("needs more information");
    await core.setStatus(agent, id, "awaiting_user");

    const paused = await clocks(id);
    expect(paused.status).toBe("awaiting_user");
    expect(paused.sla_paused_at).not.toBeNull();
    // Nothing moves yet: the deadline shifts when the clock restarts, because
    // until then nobody knows how long the pause will be.
    expect(paused.sla_paused_minutes).toBe(0);
  }, 60_000);

  it("gives the time back on the way out, and says how much", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await triagedTicket("will be answered");
    const before = await clocks(id);

    await core.setStatus(agent, id, "awaiting_user");
    await pausedFor(id, 90);
    await core.setStatus(agent, id, "triaged");

    const after = await clocks(id);
    expect(after.sla_paused_at).toBeNull();
    expect(after.sla_paused_minutes).toBeGreaterThanOrEqual(89);
    expect(after.sla_paused_minutes).toBeLessThanOrEqual(91);

    // Every clock moves, including the warning — otherwise the warning would
    // fire relative to a deadline that had moved out from under it.
    for (const field of [
      "resolution_due_at",
      "resolution_warn_at",
      "first_response_due_at",
      "first_response_warn_at",
    ] as const) {
      const moved = minutesBetween(after[field], before[field]);
      expect(moved).toBeGreaterThanOrEqual(89);
      expect(moved).toBeLessThanOrEqual(91);
    }
  }, 60_000);

  it("does not restart the pause when the same status is set twice", async () => {
    if (guard()) return expect(available).toBe(false);

    // The property a naive implementation gets wrong: a second write of the
    // same status would reset `sla_paused_at` to now, and the ticket would be
    // handed back all the time it had already spent waiting.
    const id = await triagedTicket("asked twice");
    await core.setStatus(agent, id, "awaiting_user");
    await pausedFor(id, 60);
    const first = await clocks(id);

    await core.setStatus(agent, id, "awaiting_user");
    const second = await clocks(id);
    expect(second.sla_paused_at).toEqual(first.sla_paused_at);

    await core.setStatus(agent, id, "triaged");
    const resumed = await clocks(id);
    expect(resumed.sla_paused_minutes).toBeGreaterThanOrEqual(59);
  }, 60_000);

  it("accumulates across repeated cycles", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await triagedTicket("a long conversation");
    const before = await clocks(id);

    // Three rounds of question and answer: 30, 45 and 20 minutes.
    for (const minutes of [30, 45, 20]) {
      await core.setStatus(agent, id, "awaiting_user");
      await pausedFor(id, minutes);
      await core.setStatus(agent, id, "triaged");
    }

    const after = await clocks(id);
    expect(after.sla_paused_at).toBeNull();
    expect(after.sla_paused_minutes).toBeGreaterThanOrEqual(94);
    expect(after.sla_paused_minutes).toBeLessThanOrEqual(96);

    const moved = minutesBetween(after.resolution_due_at, before.resolution_due_at);
    expect(moved).toBeGreaterThanOrEqual(94);
    expect(moved).toBeLessThanOrEqual(96);
  }, 60_000);

  it("restarts when the requester actually replies", async () => {
    if (guard()) return expect(available).toBe(false);

    // The end-to-end path: a reply arrives at the intake address, threads onto
    // the open ticket, and the clock starts again without anybody in the
    // console touching it.
    const id = await triagedTicket("awaiting an answer by email");
    const ticket = await core.getTicket(system, id);
    await core.setStatus(agent, id, "awaiting_user");
    await pausedFor(id, 120);

    // Through the same door a real reply arrives by: the tenant comes out of
    // the intake credential, never out of the message.
    const tenant = await core.contextForIntakeToken(intakeToken);
    expect(tenant?.businessId).toBe(businessId);

    await core.intakeMessage(tenant!, {
      source: "email",
      source_message_id: `sla-reply-${crypto.randomUUID()}@example.test`,
      requester_email: requesterEmail,
      requester_name: "Test Person",
      // Threaded by the tag this platform puts in every outbound subject, which
      // is how a real reply finds its way back to an open ticket.
      subject: `Re: ${core.subjectTag(id)} ${ticket!.subject}`,
      body: "Here is the information you asked for.",
      attachments: [],
      received_at: new Date(),
      meta: {},
      in_reply_to: null,
      references: [],
    });

    const after = await clocks(id);
    expect(after.status).toBe("triaged");
    expect(after.sla_paused_at).toBeNull();
    expect(after.sla_paused_minutes).toBeGreaterThanOrEqual(119);
  }, 60_000);

  it("restarts when the ticket is resolved straight out of the pause", async () => {
    if (guard()) return expect(available).toBe(false);

    // Otherwise `resolved_at` would be judged against a deadline that was
    // still stopped, which is the one case where a paused clock could make a
    // breach look like a pass.
    const id = await triagedTicket("resolved while waiting");
    await core.setStatus(agent, id, "awaiting_user");
    await pausedFor(id, 45);
    await core.setStatus(system, id, "resolved");

    const after = await clocks(id);
    expect(after.status).toBe("resolved");
    expect(after.sla_paused_at).toBeNull();
    expect(after.sla_paused_minutes).toBeGreaterThanOrEqual(44);
  }, 60_000);
});

describe("what the rest of the system sees", () => {
  it("shows paused rather than a countdown", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await triagedTicket("paused in the console");
    await core.setStatus(agent, id, "awaiting_user");

    const ticket = await core.getTicket(system, id);
    const status = core.slaStatus(ticket!);
    expect(status.paused).toBe(true);
    expect(status.resolution).toBe("paused");
  }, 60_000);

  it("keeps a paused ticket out of the warning sweep", async () => {
    if (guard()) return expect(available).toBe(false);

    // A warning about a deadline that is going to move when the requester
    // replies is a warning people learn to ignore.
    const id = await triagedTicket("would otherwise warn");
    await core.query(
      `update tickets
          set resolution_warn_at = now() - interval '5 minutes',
              resolution_due_at = now() + interval '30 minutes'
        where id = $1`,
      [id],
    );

    const warnable = await core.ticketsNearingSla(system);
    expect(warnable.map((w) => w.ticket_id)).toContain(id);

    await core.setStatus(agent, id, "awaiting_user");
    const afterPause = await core.ticketsNearingSla(system);
    expect(afterPause.map((w) => w.ticket_id)).not.toContain(id);
  }, 60_000);

  it("agrees with the console about when a ticket is at risk", async () => {
    if (guard()) return expect(available).toBe(false);

    // The defect this whole change exists to remove: the sweep and the console
    // each decided "due soon" their own way, and disagreed. Both now read the
    // same stored instant, so the only way they can differ is if one of them
    // stops reading it.
    const id = await triagedTicket("at risk");
    await core.query(
      `update tickets
          set resolution_warn_at = now() - interval '1 minute',
              resolution_due_at = now() + interval '2 hours',
              first_response_at = now()
        where id = $1`,
      [id],
    );

    const ticket = await core.getTicket(system, id);
    expect(core.slaStatus(ticket!).resolution).toBe("due_soon");

    const warnable = await core.ticketsNearingSla(system);
    expect(warnable.some((w) => w.ticket_id === id && w.clock === "resolution")).toBe(
      true,
    );
  }, 60_000);

  it("does not warn about a ticket whose pause pushed the warning away", async () => {
    if (guard()) return expect(available).toBe(false);

    // The two fixes meeting: a ticket that was inside its warning window when
    // it paused should not be inside it any more once the requester's time is
    // given back.
    const id = await triagedTicket("rescued by the pause");
    await core.query(
      `update tickets
          set resolution_warn_at = now() - interval '10 minutes',
              resolution_due_at = now() + interval '20 minutes',
              first_response_at = now()
        where id = $1`,
      [id],
    );
    expect((await core.ticketsNearingSla(system)).map((w) => w.ticket_id)).toContain(id);

    await core.setStatus(agent, id, "awaiting_user");
    await pausedFor(id, 120);
    await core.setStatus(agent, id, "triaged");

    const after = await clocks(id);
    const ticket = await core.getTicket(system, id);
    expect(after.sla_paused_at).toBeNull();
    expect(core.slaStatus(ticket!).resolution).toBe("on_track");
    expect((await core.ticketsNearingSla(system)).map((w) => w.ticket_id)).not.toContain(
      id,
    );
  }, 60_000);
});

describe("a deadline that has already gone", () => {
  it("stays breached through a pause", async () => {
    if (guard()) return expect(available).toBe(false);

    // Pausing cannot un-breach a deadline that has passed, and reporting
    // "paused" instead would hide the one state somebody has to act on.
    const id = await triagedTicket("already late");
    await core.query(
      `update tickets
          set resolution_due_at = now() - interval '1 hour',
              resolution_warn_at = now() - interval '2 hours',
              first_response_at = now() - interval '3 hours'
        where id = $1`,
      [id],
    );

    await core.setStatus(agent, id, "awaiting_user");
    const ticket = await core.getTicket(system, id);
    expect(core.slaStatus(ticket!).resolution).toBe("breached");
  }, 60_000);

  it("is still breached after the time is given back, if it is still late", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await triagedTicket("late even after credit");
    await core.query(
      `update tickets
          set resolution_due_at = now() - interval '3 hours',
              resolution_warn_at = now() - interval '4 hours',
              first_response_at = now() - interval '5 hours'
        where id = $1`,
      [id],
    );

    await core.setStatus(agent, id, "awaiting_user");
    await pausedFor(id, 30);
    await core.setStatus(agent, id, "triaged");

    const ticket = await core.getTicket(system, id);
    // Thirty minutes back against three hours late is still late.
    expect(core.slaStatus(ticket!).resolution).toBe("breached");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Transitions from docs/sla.md that only a database can prove.
// ---------------------------------------------------------------------------

describe("which statuses stop the clock", () => {
  it("I7 stops for awaiting_user and for nothing else", async () => {
    if (guard()) return expect(available).toBe(false);

    // Waiting on an approver, or on our own work, is the desk's time.
    const id = await triagedTicket("the desk's own waits");
    for (const status of ["in_progress", "awaiting_approval", "triaged"] as const) {
      await core.setStatus(agent, id, status);
      expect((await clocks(id)).sla_paused_at, status).toBeNull();
    }
  }, 60_000);

  it("T11 closing straight out of the pause credits it, as resolving does", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await triagedTicket("closed without a reply");
    const before = await clocks(id);
    await core.setStatus(agent, id, "awaiting_user");
    await pausedFor(id, 40);
    await core.setStatus(system, id, "closed");

    const after = await clocks(id);
    expect(after.sla_paused_at).toBeNull();
    expect(after.sla_paused_minutes).toBeGreaterThanOrEqual(40);
    expect(after.sla_paused_minutes).toBeLessThanOrEqual(41);
    expect(minutesBetween(after.resolution_due_at, before.resolution_due_at)).toBe(
      after.sla_paused_minutes,
    );
  }, 60_000);
});

describe("a retriage landing on a paused ticket", () => {
  /**
   * The write a retriage makes, with whatever status the decision chose.
   * `applyTriage` stamps from `created_at` carrying the credit the locked row
   * has. Returns that stamp as it stands before the call, which is what the
   * retriage owes when nothing races it. The pipeline test drives the same
   * thing through `runPipeline`; this one pins the status routing inside
   * `applyTriage` without a model in the way.
   */
  async function retriage(
    id: string,
    status: core.TicketStatus,
    priority: core.TicketPriority = "P3",
  ): Promise<core.SlaTargets> {
    const t = (await core.getTicket(system, id))!;
    const settings = await core.getSettings(businessId);
    const owed = core.computeSla(
      new Date(t.created_at),
      priority,
      settings,
      t.sla_paused_minutes,
      t.sla_resolved_minutes,
    );
    await core.applyTriage(agent, id, triageOf(priority, status), settings);
    return owed;
  }

  const triageOf = (priority: core.TicketPriority, status: core.TicketStatus) => ({
    category: "software",
    subcategory: "broken",
    priority,
    confidence: 0.9,
    resolution_path: "human_only" as const,
    status,
  });

  it("T14 I4 keeps a settled first response's deadline, as a person's change does", async () => {
    if (guard()) return expect(available).toBe(false);

    // The two paths have to agree (D2), including on what they leave alone.
    const id = await triagedTicket("answered, then retriaged up");
    await core.query(
      `update tickets set first_response_at = created_at + interval '60 minutes' where id = $1`,
      [id],
    );
    const before = await clocks(id);

    const p1 = await retriage(id, "triaged", "P1");

    const after = await clocks(id);
    expect(after.first_response_due_at).toEqual(before.first_response_due_at);
    expect(after.first_response_warn_at).toEqual(before.first_response_warn_at);
    expect(after.resolution_due_at).toEqual(p1.resolutionDueAt);
    expect(core.slaStatus((await core.getTicket(system, id))!).firstResponse).toBe("met");
  }, 60_000);

  it("T14 leaves the pause through setStatus, so the wait is credited and logged", async () => {
    if (guard()) return expect(available).toBe(false);

    // Before, the status became `triaged` and `sla_paused_at` stayed set: the
    // desk held a ticket whose clock was stopped, the sweep skipped it, and it
    // read `paused` until somebody happened to change its status.
    const id = await triagedTicket("retriaged while waiting");
    const before = await clocks(id);
    await core.setStatus(agent, id, "awaiting_user");
    await pausedFor(id, 90);
    await retriage(id, "triaged");

    const after = await clocks(id);
    expect(after.status).toBe("triaged");
    expect(after.sla_paused_at).toBeNull();
    expect(after.sla_paused_minutes).toBeGreaterThanOrEqual(90);
    expect(after.sla_paused_minutes).toBeLessThanOrEqual(91);
    expect(minutesBetween(after.resolution_due_at, before.resolution_due_at)).toBe(
      after.sla_paused_minutes,
    );

    const ticket = await core.getTicket(system, id);
    expect(core.slaStatus(ticket!).paused).toBe(false);

    const resumes = (await core.eventsFor(system, id)).filter(
      (e) => e.payload.stage === "sla_pause" && e.payload.action === "resumed",
    );
    expect(resumes).toHaveLength(1);
  }, 60_000);

  it("T14 keeps the pause running when the retriage asks the requester again", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await triagedTicket("asked twice");
    await core.setStatus(agent, id, "awaiting_user");
    await pausedFor(id, 30);
    const pausedAt = (await clocks(id)).sla_paused_at;

    await retriage(id, "awaiting_user");

    const after = await clocks(id);
    expect(after.status).toBe("awaiting_user");
    expect(after.sla_paused_at).toEqual(pausedAt);
    expect(after.sla_paused_minutes).toBe(0);
  }, 60_000);

  it("T14 waiting on a resume restamps with the credit the resume gave", async () => {
    if (guard()) return expect(available).toBe(false);

    // The requester replies while the model is running. The pipeline used to
    // compute the stamp before the call, with no credit, and write it over the
    // deadline the resume had just moved. The retriage now waits on the lock
    // and stamps from what the resume committed.
    const id = await triagedTicket("replied as it was retriaged");
    await core.setStatus(agent, id, "awaiting_user");
    const settings = await core.getSettings(businessId);

    await raceBehindLock(
      id,
      async () => {
        await core.applyTriage(agent, id, triageOf("P2", "triaged"), settings);
      },
      `update tickets
          set status = 'triaged', sla_paused_at = null,
              sla_paused_minutes = sla_paused_minutes + 60,
              first_response_due_at = first_response_due_at + interval '60 minutes',
              resolution_due_at = resolution_due_at + interval '60 minutes',
              first_response_warn_at = first_response_warn_at + interval '60 minutes',
              resolution_warn_at = resolution_warn_at + interval '60 minutes'
        where id = $1`,
      [id],
    );

    const after = await clocks(id);
    const t = (await core.getTicket(system, id))!;
    const p2 = core.computeSla(new Date(t.created_at), "P2", settings, 60);
    expect(after.priority).toBe("P2");
    expect(after.sla_paused_at).toBeNull();
    expect(after.sla_paused_minutes).toBe(60);
    expect(after.first_response_due_at).toEqual(p2.firstResponseDueAt);
    expect(after.resolution_due_at).toEqual(p2.resolutionDueAt);
    expect(after.first_response_warn_at).toEqual(p2.firstResponseWarnAt);
    expect(after.resolution_warn_at).toEqual(p2.resolutionWarnAt);
  }, 60_000);

  it("T14 I5 a retriage and a resume at once land on the same deadlines in either order", async () => {
    if (guard()) return expect(available).toBe(false);

    // Whichever gets the lock first, the other builds on it. A retriage first
    // stamps P2 and the resume credits the wait onto it. A resume first
    // credits the wait, and the retriage stamps P2 carrying it. Both come to
    // the P2 stamp with the credit the ticket ends up with, so the order the
    // lock happens to serve them in cannot show in the result.
    const settings = await core.getSettings(businessId);
    const ids = await Promise.all(
      [1, 2, 3, 4].map(async (n) => {
        const id = await triagedTicket(`retriaged as the requester replied ${n}`);
        await core.setStatus(agent, id, "awaiting_user");
        await pausedFor(id, 60);
        return id;
      }),
    );

    await Promise.all(
      ids.flatMap((id, n) => {
        const retriaged = core.applyTriage(agent, id, triageOf("P2", "triaged"), settings);
        const resumed = core.setStatus(agent, id, "triaged");
        return n % 2 ? [retriaged, resumed] : [resumed, retriaged];
      }),
    );

    for (const id of ids) {
      const after = await clocks(id);
      const t = (await core.getTicket(system, id))!;
      const p2 = core.computeSla(new Date(t.created_at), "P2", settings, after.sla_paused_minutes);
      expect(after.priority).toBe("P2");
      expect(after.sla_paused_at).toBeNull();
      expect(after.sla_paused_minutes).toBeGreaterThanOrEqual(59);
      expect(after.sla_paused_minutes).toBeLessThanOrEqual(61);
      expect(after.first_response_due_at).toEqual(p2.firstResponseDueAt);
      expect(after.resolution_due_at).toEqual(p2.resolutionDueAt);
      expect(after.first_response_warn_at).toEqual(p2.firstResponseWarnAt);
      expect(after.resolution_warn_at).toEqual(p2.resolutionWarnAt);

      // One resume, whichever write made it.
      const resumes = (await core.eventsFor(system, id)).filter(
        (e) => e.payload.stage === "sla_pause" && e.payload.action === "resumed",
      );
      expect(resumes).toHaveLength(1);
    }
  }, 60_000);
});

describe("a human reclassification", () => {
  /** What a retriage to `priority` would stamp on this ticket now. */
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

  const restamps = async (id: string) =>
    (await core.eventsFor(system, id)).filter((e) => e.payload.stage === "sla_restamp");

  it("T15 restamps the deadlines from created_at for the new priority, and logs it", async () => {
    if (guard()) return expect(available).toBe(false);

    // D2. It used to change the priority only, so a P3 re-marked as P1 by a
    // person kept its P3 deadline, while a retriage making the same correction
    // moved it.
    const id = await triagedTicket("actually an outage");
    const before = await clocks(id);
    await core.overrideClassification(system, id, { category: "software", priority: "P1" });

    const after = await clocks(id);
    const p1 = await owed(id, "P1");
    expect(after.priority).toBe("P1");
    expect(after.first_response_due_at).toEqual(p1.firstResponseDueAt);
    expect(after.resolution_due_at).toEqual(p1.resolutionDueAt);
    expect(after.first_response_warn_at).toEqual(p1.firstResponseWarnAt);
    expect(after.resolution_warn_at).toEqual(p1.resolutionWarnAt);
    expect(after.resolution_due_at!.getTime()).toBeLessThan(before.resolution_due_at!.getTime());

    const events = await restamps(id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      from_priority: "P3",
      to_priority: "P1",
      credit_minutes: 0,
      resolution_due_at: after.resolution_due_at!.toISOString(),
    });
  }, 60_000);

  it("T15 I5 carries the credit already given back", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await triagedTicket("waited, then upgraded");
    await core.setStatus(agent, id, "awaiting_user");
    await pausedFor(id, 90);
    await core.setStatus(agent, id, "triaged");
    const credited = (await clocks(id)).sla_paused_minutes;
    expect(credited).toBeGreaterThanOrEqual(89);

    await core.overrideClassification(system, id, { category: "software", priority: "P2" });

    const after = await clocks(id);
    const p2 = await owed(id, "P2");
    expect(after.sla_paused_minutes).toBe(credited);
    expect(after.resolution_due_at).toEqual(p2.resolutionDueAt);
    expect(after.first_response_due_at).toEqual(p2.firstResponseDueAt);
    expect((await restamps(id))[0]!.payload.credit_minutes).toBe(credited);
  }, 60_000);

  it("T15 leaves an open pause open, and the resume credits it onto the new deadlines", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await triagedTicket("upgraded while waiting");
    await core.setStatus(agent, id, "awaiting_user");
    await pausedFor(id, 60);
    const pausedAt = (await clocks(id)).sla_paused_at;

    await core.overrideClassification(system, id, { category: "software", priority: "P2" });

    const during = await clocks(id);
    expect(during.status).toBe("awaiting_user");
    expect(during.sla_paused_at).toEqual(pausedAt);
    expect(during.sla_paused_minutes).toBe(0);
    expect(during.resolution_due_at).toEqual((await owed(id, "P2")).resolutionDueAt);

    await core.setStatus(agent, id, "triaged");
    const after = await clocks(id);
    expect(after.sla_paused_minutes).toBeGreaterThanOrEqual(59);
    expect(minutesBetween(after.resolution_due_at, during.resolution_due_at)).toBe(
      after.sla_paused_minutes,
    );
  }, 60_000);

  it("T15 is not undone by a resume that was waiting to write", async () => {
    if (guard()) return expect(available).toBe(false);

    // The resume is blocked while the priority change commits. `setStatus`
    // used to read the row without a lock, so it computed its shift from the
    // P3 deadlines, waited, and then wrote those back over the P2 stamp.
    const id = await triagedTicket("upgraded as the requester replied");
    await core.setStatus(agent, id, "awaiting_user");
    await pausedFor(id, 60);
    const p2 = await owed(id, "P2");

    await raceBehindLock(
      id,
      () => core.setStatus(agent, id, "triaged"),
      `update tickets
          set priority = 'P2',
              first_response_due_at = $2, resolution_due_at = $3,
              first_response_warn_at = $4, resolution_warn_at = $5
        where id = $1`,
      [id, p2.firstResponseDueAt, p2.resolutionDueAt, p2.firstResponseWarnAt, p2.resolutionWarnAt],
    );

    const after = await clocks(id);
    expect(after.priority).toBe("P2");
    expect(after.sla_paused_at).toBeNull();
    expect(after.sla_paused_minutes).toBeGreaterThanOrEqual(59);
    const expected = await owed(id, "P2");
    expect(after.resolution_due_at).toEqual(expected.resolutionDueAt);
    expect(after.first_response_due_at).toEqual(expected.firstResponseDueAt);
  }, 60_000);

  it("T15 waiting on a resume restamps with the credit the resume gave", async () => {
    if (guard()) return expect(available).toBe(false);

    // The other order: the priority change is blocked while a resume commits,
    // and has to stamp with the credit that resume added.
    const id = await triagedTicket("replied as it was upgraded");
    await core.setStatus(agent, id, "awaiting_user");

    await raceBehindLock(
      id,
      () => core.overrideClassification(system, id, { category: "software", priority: "P2" }),
      `update tickets
          set status = 'triaged', sla_paused_at = null,
              sla_paused_minutes = sla_paused_minutes + 60
        where id = $1`,
      [id],
    );

    const after = await clocks(id);
    expect(after.sla_paused_minutes).toBe(60);
    const expected = await owed(id, "P2");
    expect(after.resolution_due_at).toEqual(expected.resolutionDueAt);
    expect((await restamps(id))[0]!.payload.credit_minutes).toBe(60);
  }, 60_000);

  /** Record an outcome `minutes` after the ticket arrived. */
  const settleAt = (id: string, column: "first_response_at" | "resolved_at", minutes: number) =>
    core.query(
      `update tickets set ${column} = created_at + ($2 || ' minutes')::interval where id = $1`,
      [id, String(minutes)],
    );

  it("T15 I4 keeps a settled first response's result and restamps the running resolution clock", async () => {
    if (guard()) return expect(available).toBe(false);

    // Answered after an hour: inside P3's four hours, far outside P1's fifteen
    // minutes. Re-marking it P1 used to turn that met target into a breach.
    const id = await triagedTicket("answered, then upgraded");
    await settleAt(id, "first_response_at", 60);
    const before = await clocks(id);

    await core.overrideClassification(system, id, { category: "software", priority: "P1" });

    const after = await clocks(id);
    expect(after.first_response_due_at).toEqual(before.first_response_due_at);
    expect(after.first_response_warn_at).toEqual(before.first_response_warn_at);
    expect(after.resolution_due_at).toEqual((await owed(id, "P1")).resolutionDueAt);
    expect(core.slaStatus((await core.getTicket(system, id))!).firstResponse).toBe("met");

    const [event] = await restamps(id);
    expect(event!.payload).toMatchObject({
      settled: ["first_response"],
      first_response_due_at: null,
      resolution_due_at: after.resolution_due_at!.toISOString(),
    });
  }, 60_000);

  it("T15 I4 T13 keeps a resolved ticket's results, and a reopen stamps it for the new priority", async () => {
    if (guard()) return expect(available).toBe(false);

    // Resolved after five hours: met at P3, a breach at P1.
    const id = await triagedTicket("closed, relabelled, reopened");
    await settleAt(id, "first_response_at", 60);
    await core.setStatus(system, id, "resolved");
    await settleAt(id, "resolved_at", 300);
    const before = await clocks(id);

    await core.overrideClassification(system, id, { category: "software", priority: "P1" });

    const relabelled = await clocks(id);
    expect(relabelled.priority).toBe("P1");
    expect(relabelled.first_response_due_at).toEqual(before.first_response_due_at);
    expect(relabelled.resolution_due_at).toEqual(before.resolution_due_at);
    const sla = core.slaStatus((await core.getTicket(system, id))!);
    expect(sla.firstResponse).toBe("met");
    expect(sla.resolution).toBe("met");
    // Nothing moved, so there is nothing for the timeline to explain.
    expect(await restamps(id)).toHaveLength(0);

    // Reopened, the resolution clock is running again and now runs at P1.
    await core.setStatus(system, id, "reopened");
    const reopened = await clocks(id);
    const p1 = await owed(id, "P1");
    expect(reopened.resolution_due_at).toEqual(p1.resolutionDueAt);
    expect(reopened.resolution_warn_at).toEqual(p1.resolutionWarnAt);
    expect(reopened.first_response_due_at).toEqual(before.first_response_due_at);

    const events = await restamps(id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      reason: "reopen",
      priority: "P1",
      resolution_due_at: p1.resolutionDueAt.toISOString(),
    });
  }, 60_000);

  it("T13 a reopen moves nothing when nothing changed while it was resolved", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await triagedTicket("reopened as it was");
    await core.setStatus(agent, id, "awaiting_user");
    await pausedFor(id, 30);
    await core.setStatus(system, id, "resolved");
    const resolved = await clocks(id);

    await core.setStatus(system, id, "reopened");

    const reopened = await clocks(id);
    expect(reopened.resolution_due_at).toEqual(resolved.resolution_due_at);
    expect(reopened.resolution_warn_at).toEqual(resolved.resolution_warn_at);
    expect(await restamps(id)).toHaveLength(0);
  }, 60_000);

  it("T15 moves nothing when only the category changes", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await triagedTicket("wrong category, right priority");
    const before = await clocks(id);
    await core.overrideClassification(system, id, { category: "hardware", priority: "P3" });

    const after = await clocks(id);
    expect(after.resolution_due_at).toEqual(before.resolution_due_at);
    expect(after.first_response_due_at).toEqual(before.first_response_due_at);
    expect(after.resolution_warn_at).toEqual(before.resolution_warn_at);
    expect(await restamps(id)).toHaveLength(0);
  }, 60_000);
});

describe("a first response and a pause", () => {
  const firstResponse = async (id: string) =>
    core.slaStatus((await core.getTicket(system, id))!).firstResponse;

  const credits = async (id: string) =>
    (await core.eventsFor(system, id)).filter(
      (e) => e.payload.stage === "sla_pause" && e.payload.action === "credited",
    );

  const resumeEvent = async (id: string) =>
    (await core.eventsFor(system, id)).find(
      (e) => e.payload.stage === "sla_pause" && e.payload.action === "resumed",
    )!;

  it("T7 I4 a pause after a late first response does not make it met", async () => {
    if (guard()) return expect(available).toBe(false);

    // Due six hours ago, answered five hours ago, then waiting on the
    // requester for three. The resume used to move both deadlines, which put
    // the first response's two hours after the late answer and read `met`.
    const id = await triagedTicket("answered late, then waiting");
    await core.query(
      `update tickets
          set first_response_due_at = now() - interval '6 hours',
              first_response_warn_at = now() - interval '7 hours',
              first_response_at = now() - interval '5 hours'
        where id = $1`,
      [id],
    );
    const before = await clocks(id);
    expect(await firstResponse(id)).toBe("breached");

    await core.setStatus(agent, id, "awaiting_user");
    await pausedFor(id, 180);
    await core.setStatus(agent, id, "triaged");

    const after = await clocks(id);
    expect(after.first_response_due_at).toEqual(before.first_response_due_at);
    expect(after.first_response_warn_at).toEqual(before.first_response_warn_at);
    expect(await firstResponse(id)).toBe("breached");
    // The resolution clock was running, and is credited as before.
    expect(minutesBetween(after.resolution_due_at, before.resolution_due_at)).toBe(
      after.sla_paused_minutes,
    );

    // The resume event says which clock it left alone.
    expect((await resumeEvent(id)).payload).toMatchObject({
      settled: ["first_response"],
      first_response_due_at: null,
      resolution_due_at: after.resolution_due_at!.toISOString(),
    });
  }, 60_000);

  it("T12 I4 a first response while paused is credited the pause before it, when it is recorded", async () => {
    if (guard()) return expect(available).toBe(false);

    // Stopped with ten minutes in hand an hour ago, so the stored deadline
    // passed fifty minutes into the pause. The answer is in time, and says so
    // the moment it is recorded rather than after the requester replies.
    const id = await triagedTicket("answered while waiting");
    await core.query(
      `update tickets
          set first_response_due_at = now() + interval '10 minutes',
              first_response_warn_at = now() + interval '5 minutes'
        where id = $1`,
      [id],
    );
    await core.setStatus(agent, id, "awaiting_user");
    await elapse(id, 60);
    const before = await clocks(id);

    await core.markFirstResponse(agent, id);

    const answered = await clocks(id);
    expect(answered.sla_paused_at).toEqual(before.sla_paused_at);
    expect(answered.sla_paused_minutes).toBe(0);
    const credit = minutesBetween(answered.first_response_due_at, before.first_response_due_at);
    expect(credit).toBeGreaterThanOrEqual(60);
    expect(credit).toBeLessThanOrEqual(61);
    expect(minutesBetween(answered.first_response_warn_at, before.first_response_warn_at)).toBe(
      credit,
    );
    expect(await firstResponse(id)).toBe("met");

    const [event] = await credits(id);
    expect(event!.payload).toMatchObject({
      clock: "first_response",
      credit_minutes: credit,
      first_response_due_at: answered.first_response_due_at!.toISOString(),
    });
    expect(event!.payload.status).toBeUndefined();

    // Two more hours of waiting, then the reply. The answer is judged against
    // the deadline it was recorded with, and the resolution clock gets all
    // three hours.
    await elapse(id, 120);
    const waited = await clocks(id);
    await core.setStatus(agent, id, "triaged");

    const after = await clocks(id);
    expect(after.first_response_due_at).toEqual(waited.first_response_due_at);
    expect(await firstResponse(id)).toBe("met");
    expect(after.sla_paused_minutes).toBeGreaterThanOrEqual(180);
    expect(after.sla_paused_minutes).toBeLessThanOrEqual(181);
    expect(minutesBetween(after.resolution_due_at, waited.resolution_due_at)).toBe(
      after.sla_paused_minutes,
    );
  }, 60_000);

  it("T12 I4 a first response while paused stays late if the clock stopped late", async () => {
    if (guard()) return expect(available).toBe(false);

    // Thirty minutes late when it stopped an hour ago, answered now, and the
    // requester replies two hours later. Crediting the whole pause at the
    // resume moved the deadline past the answer and read `met`.
    const id = await triagedTicket("late, then answered while waiting");
    await core.query(
      `update tickets
          set first_response_due_at = now() - interval '30 minutes',
              first_response_warn_at = now() - interval '40 minutes'
        where id = $1`,
      [id],
    );
    await core.setStatus(agent, id, "awaiting_user");
    await elapse(id, 60);
    const before = await clocks(id);

    await core.markFirstResponse(agent, id);
    expect((await clocks(id)).first_response_due_at).toEqual(before.first_response_due_at);
    expect(await firstResponse(id)).toBe("breached");
    // Nothing moved, so there is nothing for the timeline to explain.
    expect(await credits(id)).toHaveLength(0);

    await elapse(id, 120);
    await core.setStatus(agent, id, "triaged");
    expect(await firstResponse(id)).toBe("breached");
  }, 60_000);

  it("T12 records a second response as nothing at all", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await triagedTicket("answered twice while waiting");
    await core.setStatus(agent, id, "awaiting_user");
    await elapse(id, 30);
    await core.markFirstResponse(agent, id);
    const first = await clocks(id);

    await elapse(id, 30);
    const aged = await clocks(id);
    await core.markFirstResponse(agent, id);

    expect(await clocks(id)).toEqual(aged);
    expect(aged.first_response_at!.getTime()).toBe(first.first_response_at!.getTime() - 30 * 60_000);
    expect(await credits(id)).toHaveLength(1);
  }, 60_000);

  it("T12 a first response waiting on a resume is judged against the resumed deadline", async () => {
    if (guard()) return expect(available).toBe(false);

    // The resume commits first. The response then finds the clock running and
    // credits nothing: the resume already gave the whole pause to both clocks.
    const id = await triagedTicket("replied as it was answered");
    await core.setStatus(agent, id, "awaiting_user");
    await pausedFor(id, 60);
    const before = await clocks(id);

    await raceBehindLock(
      id,
      () => core.markFirstResponse(agent, id),
      `update tickets
          set status = 'triaged', sla_paused_at = null,
              sla_paused_minutes = sla_paused_minutes + 60,
              first_response_due_at = first_response_due_at + interval '60 minutes',
              first_response_warn_at = first_response_warn_at + interval '60 minutes'
        where id = $1`,
      [id],
    );

    const after = await clocks(id);
    expect(after.first_response_at).not.toBeNull();
    expect(minutesBetween(after.first_response_due_at, before.first_response_due_at)).toBe(60);
    expect(await credits(id)).toHaveLength(0);
  }, 60_000);

  it("T7 a resume waiting on a first response leaves that clock where the response put it", async () => {
    if (guard()) return expect(available).toBe(false);

    // The other order. The response commits first, and the resume has to see
    // it: a resume that read the row before the lock would still think the
    // first-response clock was running and credit it the whole pause.
    const id = await triagedTicket("answered as the requester replied");
    await core.setStatus(agent, id, "awaiting_user");
    await pausedFor(id, 60);
    const before = await clocks(id);

    await raceBehindLock(
      id,
      () => core.setStatus(agent, id, "triaged"),
      `update tickets set first_response_at = now() where id = $1`,
      [id],
    );

    const after = await clocks(id);
    expect(after.sla_paused_at).toBeNull();
    expect(after.first_response_due_at).toEqual(before.first_response_due_at);
    expect(minutesBetween(after.resolution_due_at, before.resolution_due_at)).toBe(
      after.sla_paused_minutes,
    );
    expect((await resumeEvent(id)).payload.settled).toEqual(["first_response"]);
  }, 60_000);
});
