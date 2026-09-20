import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The follow-up sweep, through a real database.
 *
 * Two defects, both of which left resolved tickets unclosed for ever.
 *
 * A reopened-then-resolved-again ticket kept its first `resolved_at`, so the
 * requester's reply that caused the reopen was always "after the resolution"
 * and the sweep reopened the ticket again. It did so with the agent's context,
 * which does not hold `ticket:reopen`, so the call threw — on the same ticket,
 * every run — and every ticket after it in the sweep was never reached.
 *
 * Skips itself when no database is reachable:
 *
 *   npm run db:up && npm run db:migrate
 */

const core = await import("@hd/core");
const { runFollowups } = await import("../src/followup.js");

let businessId = "";
let system: import("@hd/core").TenantContext;
let available = true;

async function status(id: string): Promise<string> {
  return (await core.queryOne<{ status: string }>(
    `select status::text as status from tickets where id = $1`,
    [id],
  ))!.status;
}

async function resolvedTicket(subject: string): Promise<string> {
  const intake = await core.intakeMessage(system, {
    source: "email",
    source_message_id: `followup-${crypto.randomUUID()}@example.test`,
    requester_email: `person-${Date.now()}@acme.test`,
    requester_name: null,
    subject,
    body: "Something is broken.",
    attachments: [],
    received_at: new Date(),
    meta: {},
  });
  await core.setStatus(system, intake.ticket.id, "resolved");
  return intake.ticket.id;
}

/**
 * The requester's reply, recorded in the conversation and nothing more: no
 * status change, which is the case the sweep exists to catch.
 */
async function requesterSays(id: string, body: string): Promise<void> {
  const ticket = (await core.getTicket(system, id))!;
  await core.appendMessage(system, id, {
    visibility: "public",
    channel: "email",
    body,
    idempotencyKey: `followup-test:${crypto.randomUUID()}`,
    requesterId: ticket.requester_id!,
  });
}

/**
 * Move a ticket's resolution, and everything on its timeline, into the past.
 * A null `resolved_at` stays null.
 */
async function age(id: string, hours: number): Promise<void> {
  await core.query(
    `update tickets set resolved_at = resolved_at - ($2 || ' hours')::interval where id = $1`,
    [id, String(hours)],
  );
  await core.query(
    `update ticket_events set created_at = created_at - ($2 || ' hours')::interval
      where ticket_id = $1`,
    [id, String(hours)],
  );
}

beforeAll(async () => {
  try {
    await core.query("select 1");
  } catch {
    available = false;
    return;
  }
  const row = await core.queryOne<{ id: string }>(
    `insert into businesses (name, type, settings) values ($1, 'it_services', $2::jsonb)
     returning id`,
    [`followup-${Date.now()}`, JSON.stringify({ followup_hours: 1 })],
  );
  businessId = row!.id;
  system = core.systemContext(businessId, { requestId: "followup-test" });
}, 60_000);

afterAll(async () => {
  if (businessId) await core.purgeBusinessUnaudited(businessId);
  await core.closeQueues().catch(() => {});
  await core.closePool().catch(() => {});
});

function guard(): boolean {
  if (!available) {
    console.warn("[followup] no database reachable; skipping. npm run db:up");
  }
  return !available;
}

describe("the follow-up sweep", () => {
  it("closes a ticket that was reopened and resolved again", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await resolvedTicket("came back once");
    // The requester replied after the first resolution; intake reopened it.
    await requesterSays(id, "Still broken.");
    await core.setStatus(system, id, "reopened");
    await age(id, 5);

    // Fixed and resolved again, and quiet for two hours since. Aged rather than
    // stamped, so the test sees whatever `resolved_at` the second resolution
    // actually wrote — which used to be the first one's.
    await core.setStatus(system, id, "resolved");
    await age(id, 2);

    const summary = await runFollowups(businessId);
    expect(summary.reopened).toBe(0);
    expect(await status(id)).toBe("closed");
  }, 60_000);

  it("reopens on a reply since the resolution, and keeps going", async () => {
    if (guard()) return expect(available).toBe(false);

    const replied = await resolvedTicket("replied after resolution");
    const quiet = await resolvedTicket("nobody replied");
    await age(replied, 3);
    await age(quiet, 3);
    await requesterSays(replied, "That did not work.");

    const summary = await runFollowups(businessId);
    expect(await status(replied)).toBe("reopened");
    expect(await status(quiet)).toBe("closed");
    expect(summary.reopened).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
