import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as core from "../src/index.js";

/**
 * The P1 exit criterion: a ticket's full history reconstructs from
 * `ticket_events` alone, with no state that exists only as a column.
 *
 * This is the test that decides whether that line is true, so it is written to
 * be able to fail. `replay()` below reads nothing but the event log — never the
 * `tickets` row — folds the events into a state object, and the assertions
 * compare that reconstruction against the columns the application actually
 * maintains. A field that the log cannot account for shows up here as a
 * mismatch rather than as a paragraph in a document claiming it would work.
 *
 * What the criterion is protecting: the log is the only honest answer to "why
 * did the agent close this?" months later. The moment a state change is written
 * to a column and not to the log, that answer becomes partial, and it does so
 * silently — the ticket page still looks right, because it reads the column.
 */

let available = true;
let businessId = "";
let system: core.TenantContext;
let agent: core.TenantContext;
let console_: core.TenantContext;
let staffId = "";
let requesterEmail = "";

/**
 * A ticket's state, rebuilt from its events.
 *
 * Deliberately a fold with no access to the ticket row. Every field is set by
 * some event or stays at its opening value; anything the application changes
 * without writing an event is simply absent here, which is what makes the
 * comparison meaningful.
 */
interface Replayed {
  status: string;
  category: string | null;
  priority: string | null;
  confidence: number | null;
  assigned_to: string | null;
  first_response_at: Date | null;
  resolved_at: Date | null;
  paused_minutes: number;
  paused: boolean;
  resolved_minutes: number;
  first_response_breached_at: Date | null;
  resolution_breached_at: Date | null;
  resolution_clock_breached: boolean;
}

function replay(events: core.TicketEvent[]): Replayed {
  // The opening state of every ticket, from `createTicketFromMessage`.
  const state: Replayed = {
    status: "new",
    category: null,
    priority: null,
    confidence: null,
    assigned_to: null,
    first_response_at: null,
    resolved_at: null,
    paused_minutes: 0,
    paused: false,
    resolved_minutes: 0,
    first_response_breached_at: null,
    resolution_breached_at: null,
    resolution_clock_breached: false,
  };

  for (const e of events) {
    const p = e.payload as Record<string, unknown>;

    switch (e.kind) {
      case "triage": {
        // Two shapes: the agent's classification, and a human override that
        // records what it changed from and to.
        const to = (p.to ?? p) as Record<string, unknown>;
        if (typeof to.category === "string") state.category = to.category;
        if (typeof to.priority === "string") state.priority = to.priority;
        if (typeof p.confidence === "number") state.confidence = p.confidence;
        if (typeof p.status === "string") state.status = p.status;
        break;
      }

      case "status_change": {
        if (typeof p.status === "string") state.status = p.status;
        break;
      }

      case "reply": {
        // The first outbound reply is the first response, by definition. A
        // `reply` event is the record from before the conversation.
        if (p.inbound !== true) state.first_response_at ??= new Date(e.created_at);
        break;
      }

      case "message": {
        // Since the conversation: the first public message from the desk. A
        // copy of the old record is not a new response; its original already
        // counted above.
        if (
          p.kind === "message" &&
          p.visibility === "public" &&
          p.author_kind !== "requester" &&
          !p.legacy
        ) {
          state.first_response_at ??= new Date(e.created_at);
        }
        break;
      }

      case "note": {
        if (p.stage === "assignment") {
          state.assigned_to = (p.assigned_to as string | null) ?? null;
        }
        if (p.stage === "sla_pause") {
          if (p.action === "paused") state.paused = true;
          if (p.action === "resumed") {
            state.paused = false;
            state.paused_minutes += (p.paused_minutes as number) ?? 0;
          }
          // The pause event carries the status it moved the ticket to, so a
          // clock transition is self-describing even where the caller that
          // triggered it does not separately log one.
          if (typeof p.status === "string") state.status = p.status;
        }
        // A recorded breach. The first one for each target is the history
        // column, and the flag belongs to the resolution clock running now.
        if (p.stage === "sla_breach") {
          const at = new Date(p.breached_at as string);
          if (p.clock === "first_response") state.first_response_breached_at ??= at;
          if (p.clock === "resolution") {
            state.resolution_breached_at ??= at;
            state.resolution_clock_breached = true;
          }
        }
        // A reopen starts a new resolution clock. It is logged by the write
        // itself, ahead of any breach the new clock records, because the
        // caller's own status change is appended after the write returns. It
        // carries the time the ticket spent resolved, credited to that clock.
        if (p.stage === "sla_clock" && p.action === "restarted" && p.clock === "resolution") {
          state.resolution_clock_breached = false;
          state.resolved_minutes += (p.resolved_minutes as number) ?? 0;
        }
        break;
      }
    }

    // Resolved, and still resolved: the first resolution survives a close,
    // and a reopen clears it, as `setStatus` does.
    if (state.status === "resolved" || state.status === "closed") {
      state.resolved_at ??= new Date(e.created_at);
    } else {
      state.resolved_at = null;
    }
  }

  return state;
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
      `replay-${stamp}`,
      JSON.stringify({ sla: { calendar_priorities: ["P1", "P2", "P3", "P4"] } }),
      `support-replay-${stamp}@acme.test`,
    ],
  );
  businessId = row!.id;
  system = core.systemContext(businessId, { requestId: "replay-test" });
  agent = core.agentContext(businessId);

  const userId = await core.createUserUnaudited({
    email: `replay-admin-${stamp}@example.test`,
    fullName: "Replay Admin",
    password: "correct horse battery staple",
  });
  await core.addMembershipUnaudited(userId, businessId, "admin");
  console_ = core.humanContext({
    businessId,
    actorId: userId,
    actorEmail: `replay-admin-${stamp}@example.test`,
    role: "admin",
  });

  const staff = await core.upsertStaff({
    business_id: businessId,
    email: `desk-${stamp}@acme.test`,
    full_name: "Desk Person",
  });
  staffId = staff.id;
  requesterEmail = `person-${stamp}@acme.test`;
}, 60_000);

afterAll(async () => {
  if (businessId) await core.purgeBusinessUnaudited(businessId);
  await core.closeQueues().catch(() => {});
  await core.closePool().catch(() => {});
});

function guard(): boolean {
  if (!available) {
    console.warn("[replay] no database reachable; skipping. npm run db:up");
  }
  return !available;
}

// ---------------------------------------------------------------------------

describe("a ticket's history reconstructs from its events alone", () => {
  it("survives a full lifecycle", async () => {
    if (guard()) return expect(available).toBe(false);

    // Everything a ticket does in a working week, in order: arrives, is
    // triaged, is assigned, is answered, waits on the requester twice, comes
    // back, and is resolved.
    const intake = await core.intakeMessage(system, {
      source: "email",
      source_message_id: `replay-${crypto.randomUUID()}@example.test`,
      requester_email: requesterEmail,
      requester_name: "Test Person",
      subject: "laptop will not connect to the vpn",
      body: "It worked yesterday.",
      attachments: [],
      received_at: new Date(),
      meta: {},
    });
    const id = intake.ticket.id;

    await core.applyTriage(
      system,
      id,
      {
        category: "network",
        subcategory: "vpn",
        priority: "P3",
        confidence: 0.82,
        resolution_path: "human_only",
        status: "triaged",
      },
      await core.getSettings(businessId),
    );
    await core.appendEvent(system, {
      ticket_id: id,
      actor: "agent",
      kind: "triage",
      payload: {
        category: "network",
        subcategory: "vpn",
        priority: "P3",
        confidence: 0.82,
        status: "triaged",
      },
    });

    await core.bulkUpdate(console_, [id], { assigned_to: staffId });
    await core.appendEvent(console_, {
      ticket_id: id,
      actor: core.actorString(console_),
      kind: "note",
      payload: { stage: "assignment", assigned_to: staffId, bulk: false },
    });

    await core.markFirstResponse(system, id);
    // The reply goes into the conversation, and its `message` event is what
    // the log says about it.
    await core.appendMessage(agent, id, {
      visibility: "public",
      channel: "email",
      body: "Which network are you on?",
      idempotencyKey: `replay-reply-${id}`,
      ai: { model: "stub-model" },
    });

    // Two rounds of waiting on the requester, which is where the clock stops.
    for (const minutes of [40, 25]) {
      await core.setStatus(agent, id, "awaiting_user");
      await core.query(
        `update tickets set sla_paused_at = now() - ($2 || ' minutes')::interval
          where id = $1`,
        [id, String(minutes)],
      );
      await core.setStatus(agent, id, "triaged");
    }

    await core.setStatus(console_, id, "resolved");
    await core.appendEvent(console_, {
      ticket_id: id,
      actor: core.actorString(console_),
      kind: "status_change",
      payload: { status: "resolved", source: "console" },
    });

    // ---- the comparison -------------------------------------------------
    const events = await core.eventsFor(system, id);
    const rebuilt = replay(events);
    const actual = (await core.getTicket(system, id))!;

    expect(rebuilt.status).toBe(actual.status);
    expect(rebuilt.category).toBe(actual.category);
    expect(rebuilt.priority).toBe(actual.priority);
    expect(rebuilt.confidence).toBeCloseTo(Number(actual.triage_confidence), 2);
    expect(rebuilt.assigned_to).toBe(actual.assigned_to);
    expect(rebuilt.paused).toBe(actual.sla_paused_at !== null);

    // The field this criterion nearly lost. The SLA pause moves a deadline, and
    // a deadline that moved without an event would make a replay disagree with
    // the record about whether the ticket met its target.
    expect(rebuilt.paused_minutes).toBeGreaterThanOrEqual(
      actual.sla_paused_minutes - 2,
    );
    expect(rebuilt.paused_minutes).toBeLessThanOrEqual(actual.sla_paused_minutes + 2);

    // Timestamps to the minute: the log records when something happened, the
    // column records the same instant, and they are written milliseconds apart.
    const sameMinute = (a: Date | null, b: Date | null) =>
      Math.abs(new Date(a!).getTime() - new Date(b!).getTime()) < 60_000;
    expect(sameMinute(rebuilt.first_response_at, actual.first_response_at)).toBe(true);
    expect(sameMinute(rebuilt.resolved_at, actual.resolved_at)).toBe(true);
  }, 60_000);

  it("reconstructs a human overriding the agent", async () => {
    if (guard()) return expect(available).toBe(false);

    // The override event records `from` and `to` rather than a bare value, and
    // a replay has to read the `to` half or it reports the agent's answer for
    // ever.
    const intake = await core.intakeMessage(system, {
      source: "email",
      source_message_id: `replay-override-${crypto.randomUUID()}@example.test`,
      requester_email: requesterEmail,
      requester_name: "Test Person",
      subject: "printer jam",
      body: "Third floor.",
      attachments: [],
      received_at: new Date(),
      meta: {},
    });
    const id = intake.ticket.id;

    await core.applyTriage(
      system,
      id,
      {
        category: "software",
        subcategory: "guess",
        priority: "P4",
        confidence: 0.4,
        resolution_path: "human_only",
        status: "triaged",
      },
      await core.getSettings(businessId),
    );
    await core.appendEvent(system, {
      ticket_id: id,
      actor: "agent",
      kind: "triage",
      payload: { category: "software", priority: "P4", confidence: 0.4 },
    });

    await core.overrideClassification(console_, id, {
      category: "hardware",
      priority: "P2",
    });
    await core.appendEvent(console_, {
      ticket_id: id,
      actor: core.actorString(console_),
      kind: "triage",
      payload: {
        stage: "override",
        from: { category: "software", priority: "P4" },
        to: { category: "hardware", priority: "P2" },
      },
    });

    const rebuilt = replay(await core.eventsFor(system, id));
    const actual = (await core.getTicket(system, id))!;
    expect(rebuilt.category).toBe(actual.category);
    expect(rebuilt.priority).toBe(actual.priority);
    expect(rebuilt.category).toBe("hardware");
  }, 60_000);

  it("reconstructs a reopen after resolution", async () => {
    if (guard()) return expect(available).toBe(false);

    const intake = await core.intakeMessage(system, {
      source: "email",
      source_message_id: `replay-reopen-${crypto.randomUUID()}@example.test`,
      requester_email: requesterEmail,
      requester_name: "Test Person",
      subject: "still broken",
      body: "It came back.",
      attachments: [],
      received_at: new Date(),
      meta: {},
    });
    const id = intake.ticket.id;

    for (const status of ["resolved", "reopened", "closed"] as const) {
      await core.setStatus(console_, id, status);
      await core.appendEvent(console_, {
        ticket_id: id,
        actor: core.actorString(console_),
        kind: "status_change",
        payload: { status, source: "console" },
      });
    }

    const rebuilt = replay(await core.eventsFor(system, id));
    const actual = (await core.getTicket(system, id))!;
    expect(rebuilt.status).toBe("closed");
    expect(rebuilt.status).toBe(actual.status);
  }, 60_000);

  it("orders strictly, so two events in the same millisecond still replay", async () => {
    if (guard()) return expect(available).toBe(false);

    // A fold is only correct if the order is. `eventsFor` has to be
    // deterministic even when timestamps collide, or a replay of a busy ticket
    // is a coin toss.
    const intake = await core.intakeMessage(system, {
      source: "email",
      source_message_id: `replay-order-${crypto.randomUUID()}@example.test`,
      requester_email: requesterEmail,
      requester_name: "Test Person",
      subject: "rapid fire",
      body: "Lots happening.",
      attachments: [],
      received_at: new Date(),
      meta: {},
    });
    const id = intake.ticket.id;

    await Promise.all(
      (["triaged", "in_progress", "resolved"] as const).map((status) =>
        core.appendEvent(system, {
          ticket_id: id,
          actor: "system",
          kind: "status_change",
          payload: { status },
        }),
      ),
    );

    const once = (await core.eventsFor(system, id)).map((e) => e.id);
    const twice = (await core.eventsFor(system, id)).map((e) => e.id);
    expect(once).toEqual(twice);
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("replay under awkward event sequences", () => {
  async function ticketWithClocks(subject: string): Promise<string> {
    const intake = await core.intakeMessage(system, {
      source: "email",
      source_message_id: `replay-x-${crypto.randomUUID()}@example.test`,
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
        category: "network",
        subcategory: "vpn",
        priority: "P3",
        confidence: 0.8,
        resolution_path: "human_only",
        status: "triaged",
      },
      await core.getSettings(businessId),
    );
    return intake.ticket.id;
  }

  it("reconstructs paused minutes across three cycles from events alone", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await ticketWithClocks("three cycles");
    for (const minutes of [15, 25, 35]) {
      await core.setStatus(agent, id, "awaiting_user");
      await core.query(
        `update tickets set sla_paused_at = now() - ($2 || ' minutes')::interval
          where id = $1`,
        [id, String(minutes)],
      );
      await core.setStatus(agent, id, "triaged");
    }

    const rebuilt = replay(await core.eventsFor(system, id));
    const actual = (await core.getTicket(system, id))!;
    expect(rebuilt.paused_minutes).toBe(actual.sla_paused_minutes);
    expect(rebuilt.paused).toBe(false);
  }, 60_000);

  it("reconstructs a resolution taken straight out of a pause", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await ticketWithClocks("resolved from paused");
    await core.setStatus(agent, id, "awaiting_user");
    await core.query(
      `update tickets set sla_paused_at = now() - interval '40 minutes' where id = $1`,
      [id],
    );
    await core.setStatus(system, id, "resolved");

    const rebuilt = replay(await core.eventsFor(system, id));
    const actual = (await core.getTicket(system, id))!;
    expect(rebuilt.status).toBe("resolved");
    expect(rebuilt.paused).toBe(false);
    expect(rebuilt.paused_minutes).toBe(actual.sla_paused_minutes);
  }, 60_000);

  it("reconstructs the time credited for being resolved across two reopens", async () => {
    if (guard()) return expect(available).toBe(false);

    // D3: each reopen gives the resolution clock back the time since the
    // resolution. The column has to be rebuilt from the log like the pause
    // total, or a replay would misplace the deadline of every reopened ticket.
    const id = await ticketWithClocks("resolved, reopened, twice");
    for (const minutes of [45, 90]) {
      await core.setStatus(system, id, "resolved");
      await core.query(
        `update tickets set resolved_at = now() - ($2 || ' minutes')::interval where id = $1`,
        [id, String(minutes)],
      );
      await core.setStatus(console_, id, "reopened");
    }

    const rebuilt = replay(await core.eventsFor(system, id));
    const actual = (await core.getTicket(system, id))!;
    expect(actual.sla_resolved_minutes).toBe(135);
    expect(rebuilt.resolved_minutes).toBe(actual.sla_resolved_minutes);
  }, 60_000);

  it("reconstructs a pause closed by a requester's reply", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await ticketWithClocks("reply closes the pause");
    const ticket = await core.getTicket(system, id);
    await core.setStatus(agent, id, "awaiting_user");
    await core.query(
      `update tickets set sla_paused_at = now() - interval '50 minutes' where id = $1`,
      [id],
    );
    await core.intakeMessage(system, {
      source: "email",
      source_message_id: `replay-reply-${crypto.randomUUID()}@example.test`,
      requester_email: requesterEmail,
      requester_name: "Test Person",
      subject: `Re: ${core.subjectTag(id)} ${ticket!.subject}`,
      body: "Answering your question.",
      attachments: [],
      received_at: new Date(),
      meta: {},
    });

    const events = await core.eventsFor(system, id);
    const rebuilt = replay(events);
    const actual = (await core.getTicket(system, id))!;
    expect(rebuilt.status).toBe(actual.status);
    expect(rebuilt.paused).toBe(false);
    expect(rebuilt.paused_minutes).toBe(actual.sla_paused_minutes);

    // The fold above can reach the right status from the pause note alone,
    // which carries one. That note is only written by whichever writer wins
    // the resume, though: a reply that loses the race to a console change
    // still moves the status and writes no note. So the reply has to record
    // the transition itself.
    expect(
      events.some(
        (e) =>
          e.kind === "status_change" &&
          e.payload.status === "triaged" &&
          typeof e.payload.reason === "string" &&
          e.payload.reason.includes("awaiting"),
      ),
    ).toBe(true);
  }, 60_000);

  it("is unchanged by a duplicated event", async () => {
    if (guard()) return expect(available).toBe(false);

    // Nothing in this system deduplicates the event log, so a retried writer
    // can append the same status twice. A fold over statuses is idempotent; a
    // fold that *summed* something would not be, which is why the pause credit
    // is carried on the resume event rather than inferred from pause/resume
    // pairs.
    const id = await ticketWithClocks("duplicated event");
    for (let i = 0; i < 2; i++) {
      await core.appendEvent(system, {
        ticket_id: id,
        actor: "system",
        kind: "status_change",
        payload: { status: "in_progress" },
      });
    }

    const rebuilt = replay(await core.eventsFor(system, id));
    expect(rebuilt.status).toBe("in_progress");
  }, 60_000);

  it("is deterministic for events written in the same millisecond", async () => {
    if (guard()) return expect(available).toBe(false);

    // `eventsFor` orders by (created_at, id), and `id` is a bigserial — so the
    // tiebreak is insertion order rather than an arbitrary key. Ten reads must
    // give one answer, and it must be the last-written status.
    const id = await ticketWithClocks("same millisecond");
    await core.query(
      `insert into ticket_events (ticket_id, actor, kind, payload, created_at)
       values ($1,'system','status_change','{"status":"triaged"}'::jsonb, now()),
              ($1,'system','status_change','{"status":"in_progress"}'::jsonb, now()),
              ($1,'system','status_change','{"status":"resolved"}'::jsonb, now())`,
      [id],
    );

    const answers = new Set<string>();
    for (let i = 0; i < 10; i++) {
      answers.add(replay(await core.eventsFor(system, id)).status);
    }
    expect([...answers]).toEqual(["resolved"]);
  }, 60_000);

  it("reconstructs a partial lifecycle that never reached a terminal state", async () => {
    if (guard()) return expect(available).toBe(false);

    // A ticket abandoned mid-pause: the log has a start and no end. The replay
    // must report it as still paused rather than quietly closing the pause.
    const id = await ticketWithClocks("abandoned mid pause");
    await core.setStatus(agent, id, "awaiting_user");

    const rebuilt = replay(await core.eventsFor(system, id));
    const actual = (await core.getTicket(system, id))!;
    expect(rebuilt.paused).toBe(true);
    expect(actual.sla_paused_at).not.toBeNull();
    expect(rebuilt.paused_minutes).toBe(0);
    expect(rebuilt.status).toBe("awaiting_user");
  }, 60_000);
});

describe("recorded breaches", () => {
  it("reconstruct from the log alone, across a downgrade, a reopen and an upgrade", async () => {
    if (guard()) return expect(available).toBe(false);

    // D1 added three columns, and the criterion covers them like any other:
    // the history column for each target, and the flag for the resolution
    // clock running now, have to be derivable from `sla_breach` events and
    // the reopen that restarts the clock.
    const intake = await core.intakeMessage(system, {
      source: "email",
      source_message_id: `replay-breach-${crypto.randomUUID()}@example.test`,
      requester_email: requesterEmail,
      requester_name: "Test Person",
      subject: "late, then relabelled twice",
      body: "Nobody has looked at this.",
      attachments: [],
      received_at: new Date(),
      meta: {},
    });
    const id = intake.ticket.id;
    await core.applyTriage(
      system,
      id,
      {
        category: "software",
        subcategory: "broken",
        priority: "P2",
        confidence: 0.9,
        resolution_path: "human_only",
        status: "triaged",
      },
      await core.getSettings(businessId),
    );

    // Eight hours and five minutes pass with nobody touching it: both P2
    // clocks are late, and nothing has recorded either breach.
    await core.query(
      `update tickets
          set created_at = created_at - interval '485 minutes',
              first_response_due_at = first_response_due_at - interval '485 minutes',
              first_response_warn_at = first_response_warn_at - interval '485 minutes',
              resolution_due_at = resolution_due_at - interval '485 minutes',
              resolution_warn_at = resolution_warn_at - interval '485 minutes'
        where id = $1`,
      [id],
    );

    const compare = async () => {
      const rebuilt = replay(await core.eventsFor(system, id));
      const actual = (await core.getTicket(system, id))!;
      expect(rebuilt.first_response_breached_at).toEqual(actual.first_response_breached_at);
      expect(rebuilt.resolution_breached_at).toEqual(actual.resolution_breached_at);
      expect(rebuilt.resolution_clock_breached).toBe(actual.resolution_clock_breached);
      expect(rebuilt.resolved_minutes).toBe(actual.sla_resolved_minutes);
      return actual;
    };

    // The downgrade records both breaches before it restamps.
    await core.overrideClassification(console_, id, { category: "software", priority: "P4" });
    await core.setStatus(console_, id, "resolved");
    const resolved = await compare();
    expect(resolved.resolution_clock_breached).toBe(true);

    // Reopened, the resolution clock starts again at P4, three days long.
    await core.setStatus(console_, id, "reopened");
    const reopened = await compare();
    expect(reopened.resolution_clock_breached).toBe(false);
    expect(reopened.resolution_breached_at).toEqual(resolved.resolution_breached_at);

    // Raised to P1, the new clock is stamped onto a deadline that has gone,
    // and breaches at once. The first breach of the target stays the first.
    await core.overrideClassification(console_, id, { category: "software", priority: "P1" });
    const raised = await compare();
    expect(raised.resolution_clock_breached).toBe(true);
    expect(raised.resolution_breached_at).toEqual(resolved.resolution_breached_at);
    expect(
      (await core.eventsFor(system, id)).filter((e) => e.payload.stage === "sla_breach"),
    ).toHaveLength(3);
  }, 60_000);
});
