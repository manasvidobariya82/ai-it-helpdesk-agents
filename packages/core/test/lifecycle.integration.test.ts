import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as core from "../src/index.js";

/**
 * A ticket's life after its first resolution, through a real database.
 *
 * Every test here pins a defect that only showed up once a ticket went round
 * more than once — resolved, reopened, resolved again — or was moved by
 * something other than the ticket page: the queue's bulk actions, a reply
 * arriving through the portal, a reply to a ticket that had been merged away.
 *
 * Skips itself when no database is reachable, like the other integration
 * suites: `npm run db:up && npm run db:migrate`.
 */

let available = true;
let businessId = "";
let system: core.TenantContext;
/** A person holding the `agent` role: may close, may not reopen or assign. */
let agentRole: core.TenantContext;
let requesterEmail = "";

interface Outcome {
  status: string;
  resolved_at: Date | null;
  closed_at: Date | null;
  reopened_count: number;
  sla_paused_at: Date | null;
}

async function outcome(id: string): Promise<Outcome> {
  return (await core.queryOne<Outcome>(
    `select status::text as status, resolved_at, closed_at, reopened_count, sla_paused_at
       from tickets where id = $1`,
    [id],
  ))!;
}

async function newTicket(subject: string): Promise<core.Ticket> {
  const intake = await core.intakeMessage(system, {
    source: "email",
    source_message_id: `lifecycle-${crypto.randomUUID()}@example.test`,
    requester_email: requesterEmail,
    requester_name: "Test Person",
    subject,
    body: "Something is broken.",
    attachments: [],
    received_at: new Date(),
    meta: {},
  });
  return intake.ticket;
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
     values ($1, 'it_services', '{}'::jsonb, $2) returning id`,
    [`lifecycle-${stamp}`, `support-lifecycle-${stamp}@acme.test`],
  );
  businessId = row!.id;
  system = core.systemContext(businessId, { requestId: "lifecycle-test" });
  agentRole = core.humanContext({
    businessId,
    actorId: null,
    actorEmail: `agent-${stamp}@acme.test`,
    role: "agent",
  });
  requesterEmail = `person-${stamp}@acme.test`;
}, 60_000);

afterAll(async () => {
  if (businessId) await core.purgeBusinessUnaudited(businessId);
  await core.closeQueues().catch(() => {});
  await core.closePool().catch(() => {});
});

function guard(): boolean {
  if (!available) {
    console.warn("[lifecycle] no database reachable; skipping. npm run db:up");
  }
  return !available;
}

// ---------------------------------------------------------------------------

describe("resolved_at means resolved, and still resolved", () => {
  it("is cleared by a reopen and stamped afresh by the next resolution", async () => {
    if (guard()) return expect(available).toBe(false);

    const { id } = await newTicket("comes back");
    await core.setStatus(system, id, "resolved");
    const first = await outcome(id);
    expect(first.resolved_at).not.toBeNull();

    // Pretend the first resolution was two days ago, which is what makes the
    // old behaviour visible: the follow-up sweep reads this column.
    await core.query(
      `update tickets set resolved_at = now() - interval '2 days' where id = $1`,
      [id],
    );

    await core.setStatus(system, id, "reopened");
    const reopened = await outcome(id);
    expect(reopened.resolved_at).toBeNull();
    expect(reopened.reopened_count).toBe(1);
    expect(core.slaStatus((await core.getTicket(system, id))!).resolution).not.toBe("met");

    await core.setStatus(system, id, "resolved");
    const again = await outcome(id);
    expect(again.resolved_at).not.toBeNull();
    expect(Date.now() - new Date(again.resolved_at!).getTime()).toBeLessThan(60_000);
  }, 60_000);

  it("keeps the resolution time when a resolved ticket is closed", async () => {
    if (guard()) return expect(available).toBe(false);

    const { id } = await newTicket("resolved then closed");
    await core.setStatus(system, id, "resolved");
    const resolved = await outcome(id);
    await core.setStatus(system, id, "closed");
    const closed = await outcome(id);

    expect(closed.resolved_at).toEqual(resolved.resolved_at);
    expect(closed.closed_at).not.toBeNull();

    await core.setStatus(system, id, "reopened");
    const reopened = await outcome(id);
    expect(reopened.closed_at).toBeNull();
    expect(reopened.resolved_at).toBeNull();
  }, 60_000);

  it("is not left behind when an undelivered reply puts the ticket back", async () => {
    if (guard()) return expect(available).toBe(false);

    // `announceUndelivered` moves a resolved ticket to `triaged`; a ticket in
    // triage with a resolution time reads as `met` in every SLA badge.
    const { id } = await newTicket("reply bounced");
    await core.setStatus(system, id, "resolved");
    await core.setStatus(system, id, "triaged");
    expect((await outcome(id)).resolved_at).toBeNull();
  }, 60_000);
});

describe("bulk status changes", () => {
  it("need the same permission a single change needs", async () => {
    if (guard()) return expect(available).toBe(false);

    // The `agent` role holds ticket:update and ticket:close but not
    // ticket:reopen. The bulk path used to check ticket:update and nothing
    // else, so it reopened in bulk what it could not reopen one at a time.
    const { id } = await newTicket("bulk reopen attempt");
    await core.setStatus(system, id, "closed");

    await expect(
      core.bulkUpdate(agentRole, [id], { status: "reopened" }),
    ).rejects.toBeInstanceOf(core.AuthorizationError);
    expect((await outcome(id)).status).toBe("closed");

    // And assignment is ticket:assign, which the agent role does not hold.
    await expect(
      core.bulkUpdate(agentRole, [id], { assigned_to: null }),
    ).rejects.toBeInstanceOf(core.AuthorizationError);
  }, 60_000);

  it("stamp the outcome and move the clock, like the ticket page does", async () => {
    if (guard()) return expect(available).toBe(false);

    const waiting = await newTicket("bulk resolve while paused");
    await core.setStatus(system, waiting.id, "awaiting_user");
    expect((await outcome(waiting.id)).sla_paused_at).not.toBeNull();

    const other = await newTicket("bulk resolve");
    const changed = await core.bulkUpdateTickets(
      agentRole,
      [waiting.id, other.id, "not-a-uuid", crypto.randomUUID()],
      { status: "resolved" },
    );
    expect(changed.sort()).toEqual([waiting.id, other.id].sort());

    for (const id of changed) {
      const row = await outcome(id);
      expect(row.status).toBe("resolved");
      // A bulk resolve used to leave this null, so the follow-up sweep — which
      // selects on it — never closed these tickets.
      expect(row.resolved_at).not.toBeNull();
      expect(row.sla_paused_at).toBeNull();
    }
  }, 60_000);
});

describe("a reply arriving through a low-privilege channel", () => {
  it("still reopens the ticket it threads onto", async () => {
    if (guard()) return expect(available).toBe(false);

    // The portal form runs with ticket:read and ticket:create only. The reopen
    // a reply triggers used to run with that context and throw.
    const ticket = await newTicket("portal follow-up");
    await core.setStatus(system, ticket.id, "resolved");

    const portal = core.portalContext(businessId);
    const result = await core.intakeMessage(portal, {
      source: "widget",
      source_message_id: `widget-${crypto.randomUUID()}`,
      requester_email: requesterEmail,
      requester_name: null,
      subject: `Still broken ${core.subjectTag(ticket.id)}`,
      body: "It stopped working again.",
      attachments: [],
      received_at: new Date(),
      meta: {},
    });

    expect(result.threaded).toBe(true);
    expect(result.ticket.id).toBe(ticket.id);
    expect((await outcome(ticket.id)).status).toBe("reopened");
  }, 60_000);
});

describe("a reply to a ticket that was merged away", () => {
  it("lands on the surviving ticket", async () => {
    if (guard()) return expect(available).toBe(false);

    const survivor = await newTicket("printer on floor 3");
    const duplicate = await newTicket("printer broken again");
    await core.mergeTicket(system, duplicate.id, survivor.id);

    // The requester's mail client still has the duplicate's subject tag.
    const result = await core.intakeMessage(system, {
      source: "email",
      source_message_id: `merged-reply-${crypto.randomUUID()}@example.test`,
      requester_email: requesterEmail,
      requester_name: null,
      subject: `Re: printer broken again ${core.subjectTag(duplicate.id)}`,
      body: "Any news?",
      attachments: [],
      received_at: new Date(),
      meta: {},
    });

    expect(result.threaded).toBe(true);
    expect(result.ticket.id).toBe(survivor.id);
    // The merged ticket stays closed: nobody works on it any more.
    expect((await outcome(duplicate.id)).status).toBe("closed");
  }, 60_000);
});
