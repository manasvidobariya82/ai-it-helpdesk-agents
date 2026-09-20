import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as core from "../src/index.js";
// The knowledge base lives in @hd/rag; it is scoped by the same context.
import { kbStats, listKbDocuments } from "../../rag/src/ingest.js";

/**
 * Cross-tenant attack tests.
 *
 * Two tenants, two sets of data, and then every read and write this codebase
 * exposes is attempted from the wrong side. The rule being tested is one
 * sentence: a caller holding a valid id from another business must get nothing
 * and change nothing.
 *
 * Some of these assert 404 rather than 403, and the distinction is deliberate.
 * Within a tenant, a missing permission is a plain 403 because the resource's
 * existence is not the secret. Across tenants, "exists but forbidden" and "does
 * not exist" have to be indistinguishable, or the console becomes an id
 * enumeration oracle: guess a uuid, read the status code, learn whether a
 * competitor's ticket is real.
 *
 * Skips itself rather than failing when no database is reachable, so `npm test`
 * works on a laptop with nothing running:
 *
 *   npm run db:up && npm run db:migrate
 *
 * CI sets `REQUIRE_DB=1`, which turns that skip into a hard failure. Without it
 * a CI job whose Postgres service failed to start would go green having proved
 * nothing at all — which is the worst outcome available, because it is the one
 * that looks like success.
 */

const {
  agentContext,
  humanContext,
  systemContext,
  AuthorizationError,
  NotFoundError,
} = core;

let available = true;

/** Set in CI. Makes "no database" an error instead of a quiet pass. */
const REQUIRE_DB = process.env.REQUIRE_DB === "1";

/** Everything one tenant needs in order to be attacked. */
interface Fixture {
  businessId: string;
  admin: core.TenantContext;
  security: core.TenantContext;
  viewer: core.TenantContext;
  agent: core.TenantContext;
  adminUserId: string;
  securityUserId: string;
  securityEmail: string;
  ticketId: string;
  requesterId: string;
  staffId: string;
  approvalId: string;
  docId: string;
}

let A: Fixture;
let B: Fixture;

async function makeTenant(label: string): Promise<Fixture> {
  const biz = await core.queryOne<{ id: string }>(
    `insert into businesses (name, type, settings) values ($1,'it_services','{}'::jsonb)
     returning id`,
    [`isolation-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`],
  );
  const businessId = biz!.id;
  const sys = systemContext(businessId);

  const adminUserId = await core.createUserUnaudited({
    email: `admin-${label}-${Date.now()}@example.test`,
    fullName: `Admin ${label}`,
    password: "correct horse battery staple",
  });
  await core.addMembershipUnaudited(adminUserId, businessId, "admin");

  const securityEmail = `sec-${label}-${Date.now()}@example.test`;
  const securityUserId = await core.createUserUnaudited({
    email: securityEmail,
    fullName: `Security ${label}`,
    password: "correct horse battery staple",
  });
  await core.addMembershipUnaudited(securityUserId, businessId, "security_admin");

  const ctxFor = (userId: string, role: core.Role) =>
    humanContext({
      businessId,
      actorId: userId,
      actorEmail: `${role}-${label}@example.test`,
      role,
    });

  const admin = ctxFor(adminUserId, "admin");
  const security = ctxFor(securityUserId, "security_admin");
  const viewer = ctxFor(adminUserId, "viewer");
  const agent = agentContext(businessId);

  const requester = await core.upsertRequester({
    business_id: businessId,
    email: `person-${label}-${Date.now()}@example.test`,
    full_name: `Person ${label}`,
  });

  // Directory groups live in `requesters.metadata`, so they inherit the
  // requester's tenant rather than having one of their own.
  await core.query(`update requesters set metadata = $2::jsonb where id = $1`, [
    requester.id,
    JSON.stringify({ groups: [`${label}-Finance-Team`, `${label}-VPN-Users`] }),
  ]);

  await core.query(
    `insert into assets (business_id, requester_id, asset_tag, kind, os)
     values ($1,$2,$3,'laptop','Windows 11')`,
    [businessId, requester.id, `TAG-${label}-${Date.now()}`],
  );

  const staff = await core.upsertStaff({
    business_id: businessId,
    email: `staff-${label}-${Date.now()}@example.test`,
    full_name: `Staff ${label}`,
  });

  const { ticket } = await core.createTicketFromMessage(
    sys,
    {
      source: "email",
      source_message_id: `iso-${label}-${Date.now()}-${Math.random()}`,
      requester_email: requester.email,
      requester_name: requester.full_name,
      subject: `${label} confidential subject`,
      body: `${label} confidential body`,
      // Attachments are a jsonb column on the ticket, so they inherit its
      // tenant. Named per tenant here so a leak is visible in a string match.
      attachments: [
        {
          filename: `${label}-payroll.xlsx`,
          content_type: "application/vnd.ms-excel",
          size_bytes: 1024,
          storage_key: null,
        },
      ],
      received_at: new Date(),
      meta: {},
    },
    requester.id,
    null,
  );

  await core.appendEvent(sys, {
    ticket_id: ticket.id,
    actor: "system",
    kind: "note",
    payload: { stage: "fixture" },
  });

  // A conversation: the requester's message with an attachment, and a note
  // from the desk. Named per tenant, so a leak is visible in a string match.
  await core.appendMessage(sys, ticket.id, {
    visibility: "public",
    channel: "email",
    body: `${label} conversation message`,
    idempotencyKey: `iso-${label}-message`,
    requesterId: requester.id,
    attachments: [{ filename: `${label}-screenshot.png` }],
  });
  await core.appendMessage(admin, ticket.id, {
    visibility: "internal",
    channel: "internal",
    body: `${label} internal note`,
    idempotencyKey: `iso-${label}-note`,
  });

  await core.recordShadow(sys, {
    ticket_id: ticket.id,
    agent_category: "access_identity",
    agent_priority: "P2",
    agent_confidence: 0.9,
    agent_path: "auto_reply",
  });
  await core.reconcileShadow(sys, {
    ticket_id: ticket.id,
    human_category: "access_identity",
    human_priority: "P2",
  });

  const approval = await core.requestApproval(sys, {
    ticket_id: ticket.id,
    tool_name: "identity.reset_password",
    args: { email: requester.email },
    risk_tier: "sensitive",
    rationale: `${label} rationale`,
  });

  const doc = await core.queryOne<{ id: string }>(
    `insert into kb_documents (business_id, title, origin, categories, content_hash)
     values ($1,$2,'runbook','{}',$3) returning id`,
    [businessId, `${label} runbook`, `hash-${label}-${Date.now()}`],
  );

  // One chunk each, so the statistics below have something to be wrong about.
  const zeroVector = `[${new Array(1536).fill(0).join(",")}]`;
  await core.query(
    `insert into kb_chunks
       (business_id, doc_id, doc_title, origin, content, embedding)
     values ($1,$2,$3,'runbook',$4,$5::vector)`,
    [businessId, doc!.id, `${label} runbook`, `${label} chunk body`, zeroVector],
  );

  await core.putCredential(security, {
    provider: "entra",
    label: `${label} tenant`,
    secret: `${label}-SUPER-SECRET-VALUE`,
  });

  await core.audit(admin, {
    action: "config.update",
    resource_type: "business_settings",
    resource_id: "signature",
    old_value: "old",
    new_value: `${label} new`,
  });

  return {
    businessId,
    admin,
    security,
    viewer,
    agent,
    adminUserId,
    securityUserId,
    securityEmail,
    ticketId: ticket.id,
    requesterId: requester.id,
    staffId: staff.id,
    approvalId: approval.id,
    docId: doc!.id,
  };
}

beforeAll(async () => {
  try {
    await core.query("select 1");
  } catch (err) {
    if (REQUIRE_DB) {
      throw new Error(
        "REQUIRE_DB=1 but no database is reachable, so the cross-tenant tests " +
          `would have skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    available = false;
    return;
  }
  A = await makeTenant("a");
  B = await makeTenant("b");
}, 120_000);

afterAll(async () => {
  if (available) {
    for (const f of [A, B]) {
      if (f?.businessId) {
        // Deleting a tenant cascades into the append-only tables, which refuse
        // it unless the purge flag is set for the transaction.
        await core.purgeBusinessUnaudited(f.businessId);
      }
      if (f?.adminUserId) {
        await core.query(`delete from users where id = $1`, [f.adminUserId]);
      }
    }
  }
  await core.closePool().catch(() => {});
});

/**
 * Every test below is a no-op without a database.
 *
 * The bodies read `if (guard()) return expect(available).toBe(false);` so a
 * skipped run is visibly a skipped run rather than a silent pass, and
 * `REQUIRE_DB` above makes sure that never happens where it matters.
 */
const guard = () => !available;

describe("tickets", () => {
  it("does not return another tenant's ticket by id", async () => {
    if (guard()) return expect(available).toBe(false);
    expect(await core.getTicket(A.admin, B.ticketId)).toBeNull();
    expect(await core.getTicket(B.admin, A.ticketId)).toBeNull();
  });

  it("still returns the tenant's own ticket, so the test is not vacuous", async () => {
    if (guard()) return expect(available).toBe(false);
    expect((await core.getTicket(A.admin, A.ticketId))?.id).toBe(A.ticketId);
  });

  it("never lists another tenant's tickets", async () => {
    if (guard()) return expect(available).toBe(false);
    const rows = await core.listTickets(A.admin, { limit: 500 });
    expect(rows.map((r) => r.id)).not.toContain(B.ticketId);
    expect(rows.every((r) => r.business_id === A.businessId)).toBe(true);
  });

  it("cannot search its way to another tenant's ticket", async () => {
    if (guard()) return expect(available).toBe(false);
    // The text is unique to B and matches B's subject exactly.
    const rows = await core.listTickets(A.admin, { search: "b confidential" });
    expect(rows).toEqual([]);
  });

  it("refuses to change another tenant's ticket status", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(core.setStatus(A.admin, B.ticketId, "closed")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const untouched = await core.getTicket(B.admin, B.ticketId);
    expect(untouched?.status).not.toBe("closed");
  });

  it("refuses to reclassify another tenant's ticket", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      core.overrideClassification(A.admin, B.ticketId, {
        category: "security_incident",
        priority: "P1",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const after = await core.getTicket(B.admin, B.ticketId);
    expect(after?.priority).not.toBe("P1");
  });

  it("ignores another tenant's ids in a bulk update", async () => {
    if (guard()) return expect(available).toBe(false);
    const n = await core.bulkUpdate(A.admin, [A.ticketId, B.ticketId], {
      status: "in_progress",
    });
    // One of the two matched. The other belonged to B and matched nothing.
    expect(n).toBe(1);
    const bAfter = await core.getTicket(B.admin, B.ticketId);
    expect(bAfter?.status).not.toBe("in_progress");
  });

  it("refuses a bulk assignment to another tenant's staff", async () => {
    if (guard()) return expect(available).toBe(false);
    // `assignTicket` checked the staff row against the tenant; the bulk path
    // did not, and put another company's engineer on this tenant's tickets.
    await expect(
      core.bulkUpdate(A.admin, [A.ticketId], { assigned_to: B.staffId }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const after = await core.getTicket(A.admin, A.ticketId);
    expect(after?.assigned_to).not.toBe(B.staffId);
  });

  it("refuses to merge across tenants", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(core.mergeTicket(A.admin, A.ticketId, B.ticketId)).rejects.toThrow();
    const bAfter = await core.getTicket(B.admin, B.ticketId);
    expect(bAfter?.merged_into_id).toBeNull();
  });

  it("refuses to assign another tenant's ticket", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      core.assignTicket(A.admin, B.ticketId, A.staffId),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses to assign its own ticket to another tenant's staff", async () => {
    if (guard()) return expect(available).toBe(false);
    // The update matches, but the staff subquery does not, so the assignment
    // lands as null rather than pointing at a person in another company.
    await core.assignTicket(A.admin, A.ticketId, B.staffId);
    const after = await core.getTicket(A.admin, A.ticketId);
    expect(after?.assigned_to).toBeNull();
  });
});

describe("ticket events", () => {
  it("returns nothing for another tenant's ticket", async () => {
    if (guard()) return expect(available).toBe(false);
    expect(await core.eventsFor(A.admin, B.ticketId)).toEqual([]);
    expect((await core.eventsFor(B.admin, B.ticketId)).length).toBeGreaterThan(0);
  });

  it("cannot append an event to another tenant's ticket", async () => {
    if (guard()) return expect(available).toBe(false);
    const before = (await core.eventsFor(B.admin, B.ticketId)).length;
    await core.appendEvent(A.admin, {
      ticket_id: B.ticketId,
      actor: "human:attacker",
      kind: "note",
      payload: { injected: true },
    });
    expect((await core.eventsFor(B.admin, B.ticketId)).length).toBe(before);
  });

  it("does not leak the latest draft of another tenant's ticket", async () => {
    if (guard()) return expect(available).toBe(false);
    expect(await core.latestEventOfKind(A.admin, B.ticketId, "note")).toBeNull();
  });
});

describe("conversations", () => {
  it("returns nothing of another tenant's conversation", async () => {
    if (guard()) return expect(available).toBe(false);
    expect(await core.messagesFor(A.admin, B.ticketId)).toEqual([]);
    expect(await core.conversationFor(A.admin, B.ticketId)).toBeNull();

    // The fixture made the ticket without intake, so its first message copied
    // the opening words from the ticket row before itself (D4).
    const own = await core.messagesFor(A.admin, A.ticketId);
    expect(own.map((m) => m.body)).toEqual([
      "a confidential body",
      "a conversation message",
      "a internal note",
    ]);
    expect(JSON.stringify(own)).not.toContain("b-screenshot.png");
  });

  it("cannot append to another tenant's conversation, by any context", async () => {
    if (guard()) return expect(available).toBe(false);
    const before = await core.messagesFor(B.admin, B.ticketId);
    const attempt = {
      visibility: "public" as const,
      channel: "console" as const,
      body: "injected",
      idempotencyKey: `attack-${Date.now()}`,
    };

    // 404, not 403: a foreign ticket and a missing one read the same.
    await expect(core.appendMessage(A.admin, B.ticketId, attempt)).rejects.toThrow(
      NotFoundError,
    );
    await expect(
      core.appendMessage(A.agent, B.ticketId, { ...attempt, ai: { model: "m" } }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      core.appendMessage(systemContext(A.businessId), B.ticketId, {
        ...attempt,
        requesterId: B.requesterId,
      }),
    ).rejects.toThrow(NotFoundError);

    expect(await core.messagesFor(B.admin, B.ticketId)).toEqual(before);
  });

  it("cannot write as another tenant's requester on its own ticket", async () => {
    if (guard()) return expect(available).toBe(false);
    // The database refuses the pairing whatever the query said (C3).
    await expect(
      core.appendMessage(systemContext(A.businessId), A.ticketId, {
        visibility: "public",
        channel: "email",
        body: "spoofed",
        idempotencyKey: `spoof-${Date.now()}`,
        requesterId: B.requesterId,
      }),
    ).rejects.toThrow(/foreign key/);
  });

  it("keeps idempotency keys per tenant, so a known key reveals nothing", async () => {
    if (guard()) return expect(available).toBe(false);
    // B's key, used in A, is a new message in A rather than B's message back.
    const { message, created } = await core.appendMessage(A.admin, A.ticketId, {
      visibility: "internal",
      channel: "internal",
      body: "a note under b's key",
      idempotencyKey: "iso-b-note",
    });
    expect(created).toBe(true);
    expect(message.business_id).toBe(A.businessId);
    expect(message.body).toBe("a note under b's key");
  });
});

describe("attachments and directory groups", () => {
  /**
   * Neither has a table of its own: attachments are a jsonb column on the
   * ticket, groups are a jsonb key on the requester. They are listed separately
   * here because "we only tested /tickets" is how this class of bug survives —
   * the data inherits a tenant rather than declaring one, and inherited scoping
   * is the kind that breaks quietly when a query is rewritten.
   */
  it("does not expose another tenant's attachments through the ticket", async () => {
    if (guard()) return expect(available).toBe(false);
    expect(await core.getTicket(A.admin, B.ticketId)).toBeNull();

    const own = await core.getTicket(A.admin, A.ticketId);
    expect(JSON.stringify(own?.attachments)).toContain("a-payroll.xlsx");

    const list = await core.listTickets(A.admin, { limit: 500 });
    expect(JSON.stringify(list)).not.toContain("b-payroll.xlsx");
  });

  it("does not expose another tenant's directory groups", async () => {
    if (guard()) return expect(available).toBe(false);
    expect(await core.getRequester(A.admin, B.requesterId)).toBeNull();

    const own = await core.getRequester(A.admin, A.requesterId);
    expect(JSON.stringify(own?.metadata)).toContain("a-Finance-Team");
    expect(JSON.stringify(own?.metadata)).not.toContain("b-Finance-Team");
  });

  it("does not carry either into an analytics export", async () => {
    if (guard()) return expect(available).toBe(false);
    const rows = await core.exportableSamples(A.admin);
    const json = JSON.stringify(rows);
    expect(json).not.toContain("b-payroll.xlsx");
    expect(json).not.toContain("b confidential body");
  });
});

describe("requesters, assets and staff", () => {
  it("does not return another tenant's requester", async () => {
    if (guard()) return expect(available).toBe(false);
    expect(await core.getRequester(A.admin, B.requesterId)).toBeNull();
  });

  it("does not return another tenant's devices", async () => {
    if (guard()) return expect(available).toBe(false);
    expect(await core.assetsForRequester(A.admin, B.requesterId)).toEqual([]);
    expect((await core.assetsForRequester(B.admin, B.requesterId)).length).toBe(1);
  });

  it("does not list another tenant's staff", async () => {
    if (guard()) return expect(available).toBe(false);
    const staff = await core.listStaff(A.admin);
    expect(staff.map((s) => s.id)).not.toContain(B.staffId);
  });

  it("does not return another tenant's tickets for a requester id", async () => {
    if (guard()) return expect(available).toBe(false);
    expect(await core.ticketsForRequester(A.admin, B.requesterId)).toEqual([]);
  });
});

describe("knowledge base", () => {
  it("does not list another tenant's documents", async () => {
    if (guard()) return expect(available).toBe(false);
    const docs = await listKbDocuments(A.admin);
    expect(docs.map((d) => d.id)).not.toContain(B.docId);
    expect(docs.map((d) => d.id)).toContain(A.docId);
  });

  it("counts only the caller's own chunks", async () => {
    if (guard()) return expect(available).toBe(false);
    // One runbook chunk per tenant. A query that lost its predicate would
    // report two here, which is the whole point of counting rather than
    // comparing lists.
    for (const ctx of [A.admin, B.admin]) {
      const stats = await kbStats(ctx);
      expect(stats).toEqual([
        { origin: "runbook", documents: 1, chunks: 1, superseded: 0 },
      ]);
    }
  });

  it("refuses the knowledge base to an account without kb:read", async () => {
    if (guard()) return expect(available).toBe(false);
    const noKb = humanContext({
      businessId: A.businessId,
      actorId: A.adminUserId,
      actorEmail: "nobody@example.test",
      role: "viewer",
      permissions: [],
    });
    await expect(listKbDocuments(noKb)).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("users and memberships", () => {
  it("does not list another tenant's members", async () => {
    if (guard()) return expect(available).toBe(false);
    const users = await core.listTenantUsers(A.admin);
    expect(users.map((u) => u.user_id)).not.toContain(B.adminUserId);
    expect(users.map((u) => u.user_id)).toContain(A.adminUserId);
  });

  it("does not resolve another tenant's user by id", async () => {
    if (guard()) return expect(available).toBe(false);
    expect(await core.getTenantUser(A.admin, B.adminUserId)).toBeNull();
  });

  it("refuses to change a role in another tenant", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      core.setRole(A.admin, B.adminUserId, "viewer"),
    ).rejects.toBeInstanceOf(NotFoundError);
    const stillAdmin = await core.getTenantUser(B.admin, B.adminUserId);
    expect(stillAdmin?.role).toBe("admin");
  });

  it("refuses to remove a member of another tenant", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      core.removeMember(A.admin, B.adminUserId),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await core.getTenantUser(B.admin, B.adminUserId)).not.toBeNull();
  });

  /**
   * Privilege escalation inside a tenant, not across one. An admin who could
   * mint a security_admin and sign in as them would make the split between
   * `config:update` and `security:update` decorative.
   */
  it("refuses to grant a role the granter does not hold", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      core.inviteUser(A.admin, {
        email: `escalate-${Date.now()}@example.test`,
        fullName: "Escalation",
        role: "security_admin",
      }),
    ).rejects.toBeInstanceOf(core.RoleGrantDenied);
  });

  /**
   * The same rule from the other direction. An admin cannot grant
   * security_admin, so an admin must not be able to take it away either —
   * neither directly, nor by "inviting" the member again with a lower role,
   * which used to overwrite the membership without any of setRole's checks.
   */
  it("refuses to demote or remove a member who outranks the actor", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      core.setRole(A.admin, A.securityUserId, "viewer"),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      core.removeMember(A.admin, A.securityUserId),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      core.inviteUser(A.admin, {
        email: A.securityEmail,
        fullName: "Security a",
        role: "viewer",
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const still = await core.getTenantUser(A.security, A.securityUserId);
    expect(still?.role).toBe("security_admin");
  });

  it("routes a re-invite through the role-change guards", async () => {
    if (guard()) return expect(available).toBe(false);
    // An admin re-inviting themselves as a viewer would have been a
    // self-demotion that skips "you cannot change your own role".
    const me = await core.getTenantUser(A.admin, A.adminUserId);
    await expect(
      core.inviteUser(A.admin, {
        email: me!.email,
        fullName: me!.full_name,
        role: "viewer",
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect((await core.getTenantUser(A.admin, A.adminUserId))?.role).toBe("admin");
  });
});

describe("approvals", () => {
  it("does not return another tenant's pending approvals", async () => {
    if (guard()) return expect(available).toBe(false);
    const pending = await core.pendingApprovals(A.admin);
    expect(pending.map((p) => p.id)).not.toContain(B.approvalId);
  });

  it("does not resolve another tenant's approval by id", async () => {
    if (guard()) return expect(available).toBe(false);
    expect(await core.getApproval(A.admin, B.approvalId)).toBeNull();
  });

  /**
   * The one that matters most on this table. An approval is what unlocks a
   * sensitive or destructive tool, so approving across tenants would be a way
   * to authorize an action in somebody else's company.
   */
  it("refuses to approve another tenant's action", async () => {
    if (guard()) return expect(available).toBe(false);
    const decided = await core.decideApproval(A.admin, B.approvalId, "approved");
    expect(decided).toBeNull();

    const stillPending = await core.getApproval(B.admin, B.approvalId);
    expect(stillPending?.status).toBe("pending");
  });

  it("requires action:approve even inside the right tenant", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      core.decideApproval(A.viewer, A.approvalId, "approved"),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("does not let the agent approve what the agent requested", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      core.decideApproval(A.agent, A.approvalId, "approved"),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("cannot file an approval against another tenant's ticket", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      core.requestApproval(A.admin, {
        ticket_id: B.ticketId,
        tool_name: "identity.reset_password",
        args: {},
        risk_tier: "sensitive",
        rationale: "cross tenant",
      }),
    ).rejects.toThrow();
  });
});

describe("settings and autonomy", () => {
  it("reads only its own settings", async () => {
    if (guard()) return expect(available).toBe(false);
    await core.updateSettings(A.admin, {
      ...(await core.getSettings(A.businessId)),
      signature: "— Tenant A",
    });
    expect((await core.readSettings(B.admin)).signature).not.toBe("— Tenant A");
  });

  /**
   * The roadmap's invariant, tested rather than asserted: no amount of tenant
   * administration widens autonomy, because that is a different permission.
   */
  it("refuses an autonomy change from an ordinary admin", async () => {
    if (guard()) return expect(available).toBe(false);
    const current = await core.getSettings(A.businessId);
    await expect(
      core.updateSettings(
        A.admin,
        {
          ...current,
          category_policies: {
            ...current.category_policies,
            network_connectivity: { autonomy: "act", confidence_threshold: 0.5 },
          },
        },
        { reason: "trying it on" },
      ),
    ).rejects.toBeInstanceOf(core.ConfigChangeDenied);

    const after = await core.getSettings(A.businessId);
    expect(after.category_policies.network_connectivity?.autonomy).not.toBe("act");
  });

  it("allows it for a security admin, and demands a reason", async () => {
    if (guard()) return expect(available).toBe(false);
    const current = await core.getSettings(A.businessId);
    const next = {
      ...current,
      category_policies: {
        ...current.category_policies,
        network_connectivity: { autonomy: "reply" as const, confidence_threshold: 0.82 },
      },
    };

    await expect(
      core.updateSettings(A.security, next, { acknowledgeWidening: true }),
    ).rejects.toThrow(/reason/i);

    // Lowering a threshold widens autonomy, so it also needs the explicit
    // acknowledgement. The gates compose: permission, then reason, then
    // confirmation.
    await expect(
      core.updateSettings(A.security, next, { reason: "Approved after evaluation" }),
    ).rejects.toBeInstanceOf(core.ConfirmationRequired);

    const result = await core.updateSettings(A.security, next, {
      reason: "Approved after evaluation",
      acknowledgeWidening: true,
    });
    expect(result.changes.some((c) => c.risk === "critical")).toBe(true);
    expect(result.version).toBeTruthy();
  });

  it("writes an auditable record of the threshold change", async () => {
    if (guard()) return expect(available).toBe(false);
    const history = await core.configHistory(A.admin, 50);
    // The settings key lives in `field` now: `resource_id` is which row, and
    // `field` is which part of it.
    const row = history.find((h) =>
      String(h.field).includes("network_connectivity.confidence_threshold"),
    );
    expect(row, "the threshold change should be in the audit log").toBeTruthy();
    expect(row!.action).toBe("config.autonomy_change");
    expect(row!.new_value).toBe(0.82);
    expect(row!.reason).toBe("Approved after evaluation");
    // The actor is a real user id, not a constant.
    expect(row!.actor_id).toBeTruthy();
    expect(row!.actor_role).toBe("security_admin");
  });

  it("refuses configuration changes from the agent itself", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      core.updateSettings(A.agent, await core.getSettings(A.businessId)),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("integration credentials", () => {
  it("does not list another tenant's credentials", async () => {
    if (guard()) return expect(available).toBe(false);
    const creds = await core.listCredentials(A.security);
    expect(creds.every((c) => c.label.startsWith("a "))).toBe(true);
    expect(creds.length).toBe(1);
  });

  it("does not return the secret in a listing", async () => {
    if (guard()) return expect(available).toBe(false);
    const creds = await core.listCredentials(A.security);
    expect(JSON.stringify(creds)).not.toContain("SUPER-SECRET-VALUE");
  });

  /**
   * Both tenants have a credential under the same provider name, which is the
   * realistic case — every customer configures "entra". A read has to resolve
   * within the caller's tenant, so the provider name alone can never reach
   * across.
   */
  it("resolves a shared provider name within the caller's own tenant", async () => {
    if (guard()) return expect(available).toBe(false);
    expect(await core.readCredential(A.security, "entra", "reading our own")).toBe(
      "a-SUPER-SECRET-VALUE",
    );
    expect(await core.readCredential(B.security, "entra", "reading our own")).toBe(
      "b-SUPER-SECRET-VALUE",
    );
  });

  it("reports a provider the tenant does not have as missing", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      core.readCredential(A.security, "okta", "provider we never configured"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("requires a reason, so a read cannot be untraceable", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(core.readCredential(A.security, "entra", "  ")).rejects.toThrow(
      /reason/i,
    );
  });

  /**
   * The acceptance criterion, stated literally: integration credentials cannot
   * be read by ordinary agents.
   */
  it("refuses an ordinary agent and an ordinary admin", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      core.readCredential(A.agent, "entra", "agent trying"),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      core.readCredential(A.admin, "entra", "admin trying"),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(core.listCredentials(A.viewer)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  /**
   * A delete names a provider, not a row id, so the only thing keeping it
   * inside the tenant is the predicate. A's security admin deleting "entra"
   * must remove A's and leave B's exactly as it was.
   */
  it("deletes only the caller's own row for a shared provider name", async () => {
    if (guard()) return expect(available).toBe(false);
    const bBefore = await core.listCredentials(B.security);
    expect(bBefore.length).toBe(1);

    await core.deleteCredential(A.security, "entra");

    expect(await core.listCredentials(A.security)).toEqual([]);
    expect(await core.listCredentials(B.security)).toEqual(bBefore);
    expect(await core.readCredential(B.security, "entra", "still ours")).toBe(
      "b-SUPER-SECRET-VALUE",
    );
  });

  it("audits every read of a secret", async () => {
    if (guard()) return expect(available).toBe(false);
    const rows = await core.listAudit(B.admin, { action: "credentials.read" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.reason).toBeTruthy();
    // And the audit row does not contain the thing it is protecting.
    expect(JSON.stringify(rows)).not.toContain("SUPER-SECRET-VALUE");
  });
});

describe("analytics", () => {
  it("counts only the caller's own tickets", async () => {
    if (guard()) return expect(available).toBe(false);
    const a = await core.headlineMetrics(A.admin, 365);
    const b = await core.headlineMetrics(B.admin, 365);
    expect(a.total).toBe(1);
    expect(b.total).toBe(1);
  });

  it("does not return another tenant's calibration samples", async () => {
    if (guard()) return expect(available).toBe(false);
    const rows = await core.reconciledSamples(A.admin);
    expect(rows.every((r) => r.business_id === A.businessId)).toBe(true);
    expect(rows.map((r) => r.ticket_id)).not.toContain(B.ticketId);
  });

  it("does not export another tenant's ticket bodies", async () => {
    if (guard()) return expect(available).toBe(false);
    const rows = await core.exportableSamples(A.admin);
    expect(JSON.stringify(rows)).not.toContain("b confidential body");
  });

  it("refuses analytics to an account without the permission", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(core.headlineMetrics(A.agent, 30)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

describe("the audit log", () => {
  it("shows only the caller's own tenant", async () => {
    if (guard()) return expect(available).toBe(false);
    const rows = await core.listAudit(A.admin, { limit: 500 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.business_id === A.businessId)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("b new");
  });

  it("cannot be filtered into another tenant", async () => {
    if (guard()) return expect(available).toBe(false);
    // `actorId` is a caller-supplied filter; it narrows, and cannot widen.
    const rows = await core.listAudit(A.admin, { actorId: B.adminUserId });
    expect(rows).toEqual([]);
  });

  it("is closed to accounts without audit:read", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(core.listAudit(A.agent)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(core.listAudit(A.viewer)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("records a real actor id rather than a constant", async () => {
    if (guard()) return expect(available).toBe(false);
    const rows = await core.listAudit(A.admin, { limit: 500 });
    for (const row of rows) {
      if (row.actor_type !== "human") continue;
      expect(row.actor_id).toBeTruthy();
      expect(row.actor_email).toBeTruthy();
      expect(row.actor_email).not.toBe("console");
    }
  });
});

describe("sessions", () => {
  it("will not switch a session into a tenant the user is not in", async () => {
    if (guard()) return expect(available).toBe(false);
    const session = await core.createSession({
      userId: A.adminUserId,
      businessId: A.businessId,
      ip: null,
      userAgent: null,
    });

    const ok = await core.switchTenant(session.sessionId, A.adminUserId, B.businessId);
    expect(ok).toBe(false);

    const resolved = await core.resolveSession(session.token);
    expect(resolved?.businessId).toBe(A.businessId);
  });

  it("resolves a revoked session to nothing", async () => {
    if (guard()) return expect(available).toBe(false);
    const session = await core.createSession({
      userId: A.adminUserId,
      businessId: A.businessId,
      ip: null,
      userAgent: null,
    });
    expect(await core.resolveSession(session.token)).not.toBeNull();

    await core.revokeSession(session.token);
    expect(await core.resolveSession(session.token)).toBeNull();
  });

  it("builds a context whose permissions come from the membership", async () => {
    if (guard()) return expect(available).toBe(false);
    const session = await core.createSession({
      userId: A.adminUserId,
      businessId: A.businessId,
      ip: null,
      userAgent: null,
    });
    const resolved = await core.resolveSession(session.token);
    const ctx = core.contextFromSession(resolved!);

    expect(ctx?.businessId).toBe(A.businessId);
    expect(ctx?.role).toBe("admin");
    expect(core.can(ctx!, "config:update")).toBe(true);
    expect(core.can(ctx!, "security:update")).toBe(false);
  });
});

describe("intake", () => {
  it("resolves a tenant from its token and not from the message", async () => {
    if (guard()) return expect(available).toBe(false);
    const token = await core.queryOne<{ intake_token: string }>(
      `select intake_token from businesses where id = $1`,
      [A.businessId],
    );
    const ctx = await core.contextForIntakeToken(token!.intake_token);
    expect(ctx?.businessId).toBe(A.businessId);
  });

  it("refuses an unknown token", async () => {
    if (guard()) return expect(available).toBe(false);
    expect(await core.contextForIntakeToken("not-a-real-token-at-all")).toBeNull();
    expect(await core.contextForIntakeToken("")).toBeNull();
    expect(await core.contextForIntakeToken(null)).toBeNull();
  });

  /**
   * One email copied to both tenants' support addresses carries one
   * Message-ID. Deduplication and threading were both unique on the id alone,
   * so the second tenant's intake threw — a 500, retried for ever — and
   * the answer differed depending on whether the other tenant had seen the id.
   */
  it("deduplicates a Message-ID per tenant, not across tenants", async () => {
    if (guard()) return expect(available).toBe(false);
    const messageId = `<shared-${crypto.randomUUID()}@example.test>`;
    const message = (subject: string) => ({
      source: "email" as const,
      source_message_id: messageId,
      requester_email: `cc-${Date.now()}@example.test`,
      requester_name: null,
      subject,
      body: "Copied to both help desks.",
      attachments: [],
      received_at: new Date(),
      meta: {},
    });

    const inA = await core.intakeMessage(systemContext(A.businessId), message("cc to both"));
    const inB = await core.intakeMessage(systemContext(B.businessId), message("cc to both"));
    expect(inA.created).toBe(true);
    expect(inB.created).toBe(true);
    expect(inB.ticket.id).not.toBe(inA.ticket.id);
    expect(inB.ticket.business_id).toBe(B.businessId);

    // And a retry is still a retry, inside each tenant.
    const again = await core.intakeMessage(systemContext(B.businessId), message("cc to both"));
    expect(again.created).toBe(false);
    expect(again.ticket.id).toBe(inB.ticket.id);

    // A reply that references only the shared id threads in each tenant onto
    // that tenant's own ticket.
    const reply = (businessId: string) =>
      core.intakeMessage(systemContext(businessId), {
        ...message("Re: cc to both"),
        source_message_id: `<reply-${crypto.randomUUID()}@example.test>`,
        meta: { in_reply_to: messageId },
      });
    const replyA = await reply(A.businessId);
    const replyB = await reply(B.businessId);
    expect(replyA.threaded && replyA.ticket.id).toBe(inA.ticket.id);
    expect(replyB.threaded && replyB.ticket.id).toBe(inB.ticket.id);
  });
});

/**
 * Outbound mail.
 *
 * The queue holds the text of every message this system has put in front of a
 * person, plus the addresses it has stopped writing to. Both are worth
 * attacking: reading another tenant's replies is a disclosure, and *writing* to
 * another tenant's queue is worse — a retry sends a real email, and a
 * suppression silently stops one.
 *
 * The bounce path gets its own test because it is the one place where an
 * identifier arrives from outside. A Message-ID has travelled through a
 * stranger's mail server by definition, so it cannot be a capability.
 */
describe("outbound mail", () => {
  async function queue(
    f: Fixture,
    label: string,
    over: Partial<Parameters<typeof core.queueOutbound>[1]> = {},
  ) {
    const { message } = await core.queueOutbound(f.admin, {
      ticket_id: f.ticketId,
      to_email: `recipient-${label}@example.test`,
      from_email: "support@example.test",
      subject: `${label} reply`,
      body: `${label} body text`,
      message_id: `msg-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      idempotency_key: `iso-${label}-${Date.now()}-${Math.random()}`,
      ...over,
    });
    return message;
  }

  it("does not show one tenant's messages to another", async () => {
    if (guard()) return expect(available).toBe(false);
    const message = await queue(A, "secret");

    expect(await core.getOutbound(B.admin, message.id)).toBeNull();
    expect(await core.outboundForTicket(B.admin, A.ticketId)).toEqual([]);
    expect(await core.outboundHistory(B.admin, message.id)).toEqual([]);

    const mine = await core.listOutbound(A.admin, { limit: 100 });
    expect(mine.map((m) => m.id)).toContain(message.id);
    const theirs = await core.listOutbound(B.admin, { limit: 100 });
    expect(theirs.map((m) => m.id)).not.toContain(message.id);
  });

  it("refuses to file a message against another tenant's ticket", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      core.queueOutbound(B.admin, {
        ticket_id: A.ticketId,
        to_email: "attacker@example.test",
        from_email: "support@example.test",
        subject: "please reset the CEO's password",
        body: "sent from the wrong tenant",
        message_id: `cross-${Date.now()}@example.test`,
        idempotency_key: `cross-${Date.now()}-${Math.random()}`,
      }),
    ).rejects.toThrow(/not in this tenant/);
  });

  it("will not retry or cancel another tenant's message", async () => {
    if (guard()) return expect(available).toBe(false);
    const message = await queue(A, "retry");
    await core.failOutbound(A.admin, message.id, {
      error: "550 mailbox unavailable",
      code: "550",
      provider: "smtp",
      permanent: true,
    });

    // Both return "nothing happened" rather than throwing: from B's side the
    // row does not exist, and saying so any more precisely would confirm it.
    expect(await core.retryOutbound(B.admin, message.id)).toBeNull();
    expect(await core.cancelOutbound(B.admin, message.id, "not yours")).toBe(false);

    const after = await core.getOutbound(A.admin, message.id);
    expect(after?.status).toBe("failed");
  });

  it("keeps the suppression list per tenant", async () => {
    if (guard()) return expect(available).toBe(false);
    const address = `gone-${Date.now()}@example.test`;
    await core.suppressAddress(A.admin, {
      email: address,
      reason: "hard_bounce",
      detail: "550 user unknown",
    });

    expect(await core.isSuppressed(A.admin, address)).toBe(true);
    // One company's departed employee is another company's good customer, and
    // a shared list would tell the second company about the first.
    expect(await core.isSuppressed(B.admin, address)).toBe(false);

    const queued = await queue(A, "suppressed", { to_email: address });
    expect(queued.status).toBe("suppressed");
  });

  it("does not let a Message-ID from outside resolve another tenant's message", async () => {
    if (guard()) return expect(available).toBe(false);
    const message = await queue(A, "bounce");
    await core.markSent(A.admin, message.id, {
      provider: "smtp",
      providerMessageId: `provider-${Date.now()}`,
      response: "250 ok",
    });

    expect(await core.findOutboundByMessageId(B.admin, message.message_id)).toBeNull();

    // A bounce delivered to B, quoting A's Message-ID. B may suppress its own
    // address if it likes; it may not touch A's message.
    const outcome = await core.applyBounce(B.admin, {
      kind: "hard",
      recipient: `victim-${Date.now()}@example.test`,
      status: "5.1.1",
      diagnostic: "550 user unknown",
      originalMessageId: message.message_id,
      action: "failed",
    });
    expect(outcome.applied).toBe("unmatched");
    expect(outcome.matched).toBeNull();

    const after = await core.getOutbound(A.admin, message.id);
    expect(after?.status).toBe("sent");
    expect(after?.bounce_kind).toBeNull();
  });

  it("treats the same key as the same message", async () => {
    if (guard()) return expect(available).toBe(false);
    const key = `dedupe-${Date.now()}-${Math.random()}`;
    const fields = {
      ticket_id: A.ticketId,
      to_email: "dedupe@example.test",
      from_email: "support@example.test",
      subject: "one reply",
      body: "the same words twice",
      idempotency_key: key,
    };
    const first = await core.queueOutbound(A.admin, {
      ...fields,
      message_id: `dedupe-a-${Date.now()}@example.test`,
    });
    const second = await core.queueOutbound(A.admin, {
      ...fields,
      message_id: `dedupe-b-${Date.now()}@example.test`,
    });

    expect(first.queued).toBe(true);
    expect(second.queued).toBe(false);
    expect(second.message.id).toBe(first.message.id);
  });

  it("claims a message exactly once, so two workers cannot both send it", async () => {
    if (guard()) return expect(available).toBe(false);
    const message = await queue(A, "claim");

    const [one, two] = await Promise.all([
      core.claimOutbound(message.id),
      core.claimOutbound(message.id),
    ]);
    // The claim is a single statement, so the race has one winner rather than
    // two readers who each saw `queued`.
    expect([one, two].filter(Boolean)).toHaveLength(1);
    expect((one ?? two)?.attempts).toBe(1);
  });

  it("records every transition, which is the notification audit trail", async () => {
    if (guard()) return expect(available).toBe(false);
    const message = await queue(A, "history");
    await core.recordOutboundEvent(A.admin, message.id, "attempt", { attempt: 1 });
    await core.deferOutbound(A.admin, message.id, {
      error: "421 try again",
      code: "421",
      delayMs: 60_000,
      provider: "smtp",
    });
    await core.markSent(A.admin, message.id, {
      provider: "smtp",
      providerMessageId: `p-${Date.now()}`,
      response: "250 ok",
    });

    const history = await core.outboundHistory(A.admin, message.id);
    expect(history.map((e) => e.kind)).toEqual(["queued", "attempt", "deferred", "sent"]);
  });

  it("delivers a queued message and threads the id it sent under", async () => {
    if (guard()) return expect(available).toBe(false);
    const message = await queue(A, "deliver");

    // Whatever this deployment is configured for; `spool` in development,
    // which renders the real message to a folder and reports success.
    const result = await core.deliverOutbound(message.id);
    expect(["sent", "cancelled"]).toContain(result.status);

    const after = await core.getOutbound(A.admin, message.id);
    if (result.status === "sent") {
      expect(after?.status).toBe("sent");
      expect(after?.sent_at).not.toBeNull();
      // A reply quoting this id has to land on the ticket it answers.
      const thread = await core.threadMessageIds(A.admin, A.ticketId);
      expect(thread).toContain(message.message_id);
    } else {
      // `OUTBOUND_EMAIL_PROVIDER=none`: recorded, parked, and honest about it.
      expect(after?.status).toBe("cancelled");
    }
  });
});
// ---------------------------------------------------------------------------

/**
 * API keys and the request log.
 *
 * The newest way into this deployment and therefore the newest way to get the
 * tenant wrong. Everything else in this file is attacked by a caller who
 * already holds a session; here the credential *is* the tenant, which moves the
 * boundary from "did the query remember its predicate" to "did the right
 * business come back at all".
 *
 * So the attacks are of two kinds. A console holding one tenant's session must
 * not see or revoke another tenant's keys — the ordinary shape. And a key must
 * resolve to exactly the business that issued it, with the read it performs
 * scoped by the context it produced rather than by anything in the request:
 * that is the property the whole REST API rests on, and there is no route
 * parameter anywhere in it that could override it.
 */
describe("api keys", () => {
  let keyA: { token: string; key: core.ApiKeySummary };
  let keyB: { token: string; key: core.ApiKeySummary };

  beforeAll(async () => {
    if (!available) return;
    keyA = await core.createApiKey(A.security, { name: "tenant A integration" });
    keyB = await core.createApiKey(B.security, { name: "tenant B integration" });
  });

  it("does not list another tenant's keys", async () => {
    if (guard()) return expect(available).toBe(false);
    const listed = await core.listApiKeys(A.security);
    expect(listed.map((k) => k.id)).toContain(keyA.key.id);
    expect(listed.map((k) => k.id)).not.toContain(keyB.key.id);
    expect(listed.every((k) => k.business_id === A.businessId)).toBe(true);
  });

  it("never returns a usable token in a listing", async () => {
    if (guard()) return expect(available).toBe(false);
    // The prefix is for telling two keys apart in a list. Anything longer would
    // make the list itself the credential store.
    const listed = await core.listApiKeys(A.security);
    const mine = listed.find((k) => k.id === keyA.key.id)!;
    expect(keyA.token.startsWith(mine.token_prefix)).toBe(true);
    expect(mine.token_prefix.length).toBeLessThan(keyA.token.length / 2);
    expect(JSON.stringify(listed)).not.toContain(keyA.token);
  });

  it("refuses the key list to an account without security:read", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(core.listApiKeys(A.viewer)).rejects.toThrow(AuthorizationError);
    await expect(core.listApiKeys(A.agent)).rejects.toThrow(AuthorizationError);
  });

  it("refuses to revoke another tenant's key", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      core.revokeApiKey(B.security, keyA.key.id, "not mine to revoke"),
    ).rejects.toThrow(NotFoundError);
    // Still working, which is what makes the refusal meaningful.
    expect(await core.contextForApiKey(keyA.token)).not.toBeNull();
  });

  it("resolves a token to the tenant that issued it and no further", async () => {
    if (guard()) return expect(available).toBe(false);
    const caller = (await core.contextForApiKey(keyA.token))!;
    expect(caller.ctx.businessId).toBe(A.businessId);

    // The read the API performs, through the context the credential produced.
    // There is no tenant argument to get wrong: B's ticket is simply not in the
    // result, and B's ticket id resolves to nothing.
    const listed = await core.listTickets(caller.ctx, { limit: 100 });
    expect(listed.map((t) => t.id)).toContain(A.ticketId);
    expect(listed.map((t) => t.id)).not.toContain(B.ticketId);
    expect(await core.getTicket(caller.ctx, B.ticketId)).toBeNull();
  });

  it("gives a key exactly its role's permissions and nothing extra", async () => {
    if (guard()) return expect(available).toBe(false);
    // A key is never a second authorization model. The default role is
    // `viewer`, so the key can read tickets and cannot open one — enforced by
    // the same table the console is checked against.
    const caller = (await core.contextForApiKey(keyA.token))!;
    expect(caller.ctx.role).toBe("viewer");
    expect(core.can(caller.ctx, "ticket:read")).toBe(true);
    expect(core.can(caller.ctx, "ticket:create")).toBe(false);
    expect(core.can(caller.ctx, "config:update")).toBe(false);
    expect(core.can(caller.ctx, "security:update")).toBe(false);
  });

  it("keeps the request log per tenant", async () => {
    if (guard()) return expect(available).toBe(false);
    await core.recordApiRequest({
      businessId: A.businessId,
      apiKeyId: keyA.key.id,
      method: "GET",
      path: "/api/v1/tickets?status=new",
      status: 200,
      latencyMs: 12,
      ip: "203.0.113.10",
    });

    const mine = await core.recentApiRequests(A.security);
    expect(mine.some((r) => r.path.includes("/api/v1/tickets"))).toBe(true);

    const theirs = await core.recentApiRequests(B.security);
    expect(theirs.some((r) => r.path.includes("/api/v1/tickets"))).toBe(false);
    await expect(core.recentApiRequests(A.viewer)).rejects.toThrow(AuthorizationError);
  });

  it("counts the rate limit against one key rather than the tenant", async () => {
    if (guard()) return expect(available).toBe(false);
    // Otherwise one busy integration would throttle every other one the tenant
    // runs, and the key that caused it would be unidentifiable.
    const callerA = (await core.contextForApiKey(keyA.token))!;
    const callerB = (await core.contextForApiKey(keyB.token))!;
    const before = await core.checkApiRateLimit(callerB, 1);

    await core.recordApiRequest({
      businessId: A.businessId,
      apiKeyId: keyA.key.id,
      method: "GET",
      path: "/api/v1/tickets",
      status: 200,
      latencyMs: 8,
      ip: null,
    });

    const after = await core.checkApiRateLimit(callerB, 1);
    expect(after.used).toBe(before.used);
    expect((await core.checkApiRateLimit(callerA, 1)).allowed).toBe(false);
  });
});
