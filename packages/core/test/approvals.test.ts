import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as core from "../src/index.js";

/**
 * Approval expiry, against a real database.
 *
 * `ApprovalStatus.expired` existed from the first migration and nothing ever
 * set it. A request raised on Friday afternoon sat `pending` all weekend and
 * was as executable on Monday as it had been when the agent asked.
 *
 * The worse half, found while fixing that: the tool registry unlocked on
 * `Boolean(ctx.approvalId)`. It checked that an approval id was present, never
 * that it was valid — so a rejected id, an already-executed one, one from
 * another tenant, or the literal string "yes" all ran a destructive tool.
 * `checkApproval` is what closed that, and most of this file is about it.
 */

const REQUIRE_DB = process.env.REQUIRE_DB === "1";
let available = true;

const { humanContext, systemContext, agentContext } = core;

let businessId = "";
let otherBusinessId = "";
let ticketId = "";
let otherTicketId = "";
let manager: core.TenantContext;
let otherManager: core.TenantContext;
let agent: core.TenantContext;
const userIds: string[] = [];

async function seedTenant(label: string, expiryHours: number) {
  const stamp = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const biz = await core.queryOne<{ id: string }>(
    `insert into businesses (name, type, settings) values ($1,'it_services',$2::jsonb)
     returning id`,
    [
      `approvals-${stamp}`,
      JSON.stringify(core.BusinessSettings.parse({ approval_expiry_hours: expiryHours })),
    ],
  );
  const id = biz!.id;

  const userId = await core.createUserUnaudited({
    email: `mgr-${stamp}@example.test`,
    fullName: `Manager ${label}`,
    password: "correct horse battery staple",
  });
  await core.addMembershipUnaudited(userId, id, "admin");
  userIds.push(userId);

  const sys = systemContext(id);
  const requester = await core.upsertRequester({
    business_id: id,
    email: `user-${stamp}@example.test`,
    full_name: "Requester",
  });
  const { ticket } = await core.createTicketFromMessage(
    sys,
    {
      source: "email",
      source_message_id: `appr-${stamp}`,
      requester_email: requester.email,
      requester_name: requester.full_name,
      subject: "Locked out",
      body: "Cannot sign in",
      attachments: [],
      received_at: new Date(),
      meta: {},
    },
    requester.id,
    null,
  );

  return {
    businessId: id,
    ticketId: ticket.id,
    ctx: humanContext({
      businessId: id,
      actorId: userId,
      actorEmail: `mgr-${stamp}@example.test`,
      role: "admin",
    }),
  };
}

beforeAll(async () => {
  try {
    await core.query("select 1");
  } catch (err) {
    if (REQUIRE_DB) {
      throw new Error(
        "REQUIRE_DB=1 but no database is reachable, so these would have skipped: " +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    available = false;
    return;
  }

  const a = await seedTenant("a", 24);
  businessId = a.businessId;
  ticketId = a.ticketId;
  manager = a.ctx;
  agent = agentContext(businessId);

  const b = await seedTenant("b", 24);
  otherBusinessId = b.businessId;
  otherTicketId = b.ticketId;
  otherManager = b.ctx;
}, 120_000);

afterAll(async () => {
  if (available) {
    for (const id of [businessId, otherBusinessId]) {
      if (id) await core.purgeBusinessUnaudited(id);
    }
    if (userIds.length) {
      await core.query(`delete from users where id = any($1::uuid[])`, [userIds]);
    }
  }
  await core.closePool().catch(() => {});
});

const guard = () => !available;

async function raise(
  ctx: core.TenantContext,
  ticket: string,
  args: Record<string, unknown> = { email: "someone@example.test" },
) {
  return core.requestApproval(ctx, {
    ticket_id: ticket,
    tool_name: "identity.reset_password",
    args,
    risk_tier: "sensitive",
    rationale: "Password expired and the requester is locked out",
  });
}

/** Move a request's deadline into the past, as the clock would. */
async function expireNow(id: string) {
  await core.query(
    `update action_requests set expires_at = now() - interval '1 minute' where id = $1`,
    [id],
  );
}

// ---------------------------------------------------------------------------

describe("a request is born with a deadline", () => {
  it("stamps expires_at from the tenant setting", async () => {
    if (guard()) return expect(available).toBe(false);
    const request = await raise(agent, ticketId);

    expect(request.expires_at).toBeTruthy();
    const hours =
      (new Date(request.expires_at!).getTime() - new Date(request.created_at).getTime()) /
      3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThan(25);
  });

  it("records a hash of the arguments the approver will see", async () => {
    if (guard()) return expect(available).toBe(false);
    const request = await raise(agent, ticketId, { email: "alice@example.test" });
    expect(request.args_hash).toBe(
      core.hashArgs({ email: "alice@example.test" }),
    );
  });

  it("hashes equal argument objects equally, whatever the key order", () => {
    // Without this a re-serialization somewhere in the stack would invalidate a
    // perfectly good approval, and the check would be disabled by whoever got
    // tired of it.
    expect(core.hashArgs({ a: 1, b: { c: 2, d: 3 } })).toBe(
      core.hashArgs({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(core.hashArgs({ a: 1 })).not.toBe(core.hashArgs({ a: 2 }));
  });
});

describe("expiry", () => {
  it("drops an expired request out of the pending queue", async () => {
    if (guard()) return expect(available).toBe(false);
    const request = await raise(agent, ticketId);
    expect((await core.pendingApprovals(manager)).map((a) => a.id)).toContain(request.id);

    await expireNow(request.id);
    expect((await core.pendingApprovals(manager)).map((a) => a.id)).not.toContain(
      request.id,
    );
  });

  /** The stated bug: pending → approved/rejected/expired, and expired is terminal. */
  it("refuses to approve an expired request", async () => {
    if (guard()) return expect(available).toBe(false);
    const request = await raise(agent, ticketId);
    await expireNow(request.id);

    await expect(
      core.decideApproval(manager, request.id, "approved"),
    ).rejects.toBeInstanceOf(core.ApprovalExpiredError);

    const after = await core.getApproval(manager, request.id);
    expect(after?.status).toBe("expired");
    expect(after?.decided_at).toBeNull();
  });

  it("refuses to reject an expired request too", async () => {
    if (guard()) return expect(available).toBe(false);
    const request = await raise(agent, ticketId);
    await expireNow(request.id);
    await expect(
      core.decideApproval(manager, request.id, "rejected"),
    ).rejects.toBeInstanceOf(core.ApprovalExpiredError);
  });

  it("audits the attempt to decide a lapsed request", async () => {
    if (guard()) return expect(available).toBe(false);
    const rows = await core.listAudit(manager, { action: "approval.decide" });
    const lapsed = rows.find(
      (r) => (r.new_value as { status?: string })?.status === "expired",
    );
    expect(lapsed, "an expired decision attempt should be audited").toBeTruthy();
    expect(lapsed!.reason).toMatch(/expired/i);
  });

  it("sweeps lapsed requests and names them for the caller to notify", async () => {
    if (guard()) return expect(available).toBe(false);
    const request = await raise(agent, ticketId);
    await expireNow(request.id);

    const swept = await core.expireApprovals();
    expect(swept.map((r) => r.id)).toContain(request.id);
    const row = swept.find((r) => r.id === request.id)!;
    expect(row.ticket_id).toBe(ticketId);
    expect(row.tool_name).toBe("identity.reset_password");
  });

  it("expires an approved-but-never-executed request", async () => {
    if (guard()) return expect(available).toBe(false);
    const request = await raise(agent, ticketId);
    await core.decideApproval(manager, request.id, "approved");
    await expireNow(request.id);

    // Somebody said yes and then nothing happened in time. The window still
    // closes; an approval is permission to act now, not a standing permission.
    await core.expireApprovals();
    expect((await core.getApproval(manager, request.id))?.status).toBe("expired");
  });

  it("leaves a live request alone", async () => {
    if (guard()) return expect(available).toBe(false);
    const request = await raise(agent, ticketId);
    await core.expireApprovals();
    expect((await core.getApproval(manager, request.id))?.status).toBe("pending");
  });
});

describe("an approval id is not a password", () => {
  it("accepts the approval it was issued for", async () => {
    if (guard()) return expect(available).toBe(false);
    const args = { email: "bob@example.test" };
    const request = await raise(agent, ticketId, args);
    await core.decideApproval(manager, request.id, "approved");

    const check = await core.checkApproval(
      manager,
      request.id,
      "identity.reset_password",
      args,
    );
    expect(check.ok).toBe(true);
  });

  it("refuses an approval that is still pending", async () => {
    if (guard()) return expect(available).toBe(false);
    const args = { email: "carol@example.test" };
    const request = await raise(agent, ticketId, args);

    const check = await core.checkApproval(
      manager,
      request.id,
      "identity.reset_password",
      args,
    );
    expect(check).toEqual({ ok: false, reason: "not_approved" });
  });

  it("refuses a rejected approval", async () => {
    if (guard()) return expect(available).toBe(false);
    const args = { email: "dan@example.test" };
    const request = await raise(agent, ticketId, args);
    await core.decideApproval(manager, request.id, "rejected");

    const check = await core.checkApproval(
      manager,
      request.id,
      "identity.reset_password",
      args,
    );
    expect(check).toEqual({ ok: false, reason: "not_approved" });
  });

  it("refuses an expired approval and marks it so", async () => {
    if (guard()) return expect(available).toBe(false);
    const args = { email: "erin@example.test" };
    const request = await raise(agent, ticketId, args);
    await core.decideApproval(manager, request.id, "approved");
    await expireNow(request.id);

    const check = await core.checkApproval(
      manager,
      request.id,
      "identity.reset_password",
      args,
    );
    expect(check).toEqual({ ok: false, reason: "expired" });
    expect((await core.getApproval(manager, request.id))?.status).toBe("expired");
  });

  /**
   * The one that matters most. Without it, an approval to reset one person's
   * password is a capability to reset anybody's.
   */
  it("refuses when the arguments are not the ones that were approved", async () => {
    if (guard()) return expect(available).toBe(false);
    const request = await raise(agent, ticketId, { email: "frank@example.test" });
    await core.decideApproval(manager, request.id, "approved");

    const check = await core.checkApproval(manager, request.id, "identity.reset_password", {
      email: "ceo@example.test",
    });
    expect(check).toEqual({ ok: false, reason: "args_changed" });
  });

  it("refuses when the tool is not the one that was approved", async () => {
    if (guard()) return expect(available).toBe(false);
    const args = { email: "gina@example.test" };
    const request = await raise(agent, ticketId, args);
    await core.decideApproval(manager, request.id, "approved");

    const check = await core.checkApproval(manager, request.id, "mdm.wipe_device", args);
    expect(check).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses an approval belonging to another tenant", async () => {
    if (guard()) return expect(available).toBe(false);
    const args = { email: "hank@example.test" };
    const theirs = await raise(agentContext(otherBusinessId), otherTicketId, args);
    await core.decideApproval(otherManager, theirs.id, "approved");

    // A valid, approved, unexpired id — in somebody else's business.
    const check = await core.checkApproval(
      manager,
      theirs.id,
      "identity.reset_password",
      args,
    );
    expect(check).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses an id that is not an approval at all", async () => {
    if (guard()) return expect(available).toBe(false);
    const check = await core.checkApproval(
      manager,
      "00000000-0000-0000-0000-000000000000",
      "identity.reset_password",
      {},
    );
    expect(check).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses to replay an approval that already executed", async () => {
    if (guard()) return expect(available).toBe(false);
    const args = { email: "iris@example.test" };
    const request = await raise(agent, ticketId, args);
    await core.decideApproval(manager, request.id, "approved");
    await core.recordApprovalOutcome(manager, request.id, true, { ok: true }, null);

    // An approval is permission for one call. A second one is an action
    // nobody signed off.
    const check = await core.checkApproval(
      manager,
      request.id,
      "identity.reset_password",
      args,
    );
    expect(check).toEqual({ ok: false, reason: "not_approved" });
  });
});

describe("who may decide", () => {
  it("refuses a decision from the agent that asked", async () => {
    if (guard()) return expect(available).toBe(false);
    const request = await raise(agent, ticketId);
    await expect(
      core.decideApproval(agent, request.id, "approved"),
    ).rejects.toBeInstanceOf(core.AuthorizationError);
  });

  it("refuses a decision on another tenant's request", async () => {
    if (guard()) return expect(available).toBe(false);
    const theirs = await raise(agentContext(otherBusinessId), otherTicketId);
    expect(await core.decideApproval(manager, theirs.id, "approved")).toBeNull();
    expect((await core.getApproval(otherManager, theirs.id))?.status).toBe("pending");
  });
});
