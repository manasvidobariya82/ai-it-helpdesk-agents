import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as core from "../src/index.js";

/**
 * API keys and health, against a real Postgres.
 *
 * The three things here that cannot be checked without a database are the three
 * that matter: a key resolves to exactly one tenant, a revoked or expired key
 * resolves to nothing, and the health report's verdicts come from real queries
 * rather than from configuration.
 *
 * Skips itself when no database is reachable, like the other integration
 * suites: `npm run db:up && npm run db:migrate`.
 */

let available = true;
let A = { businessId: "", ticketId: "", token: "", keyId: "" };
let B = { businessId: "", ticketId: "", token: "" };
let adminA: core.TenantContext;
let adminB: core.TenantContext;

async function makeTenant(label: string) {
  const row = await core.queryOne<{ id: string }>(
    `insert into businesses (name, type, settings) values ($1,'it_services','{}'::jsonb)
     returning id`,
    [`platform-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`],
  );
  const businessId = row!.id;
  const userId = await core.createUserUnaudited({
    email: `sec-${label}-${Date.now()}@example.test`,
    fullName: `Security ${label}`,
    password: "correct horse battery staple",
  });
  await core.addMembershipUnaudited(userId, businessId, "security_admin");
  const ctx = core.humanContext({
    businessId,
    actorId: userId,
    actorEmail: `sec-${label}@example.test`,
    role: "security_admin",
  });

  const intake = await core.intakeMessage(core.systemContext(businessId), {
    source: "email",
    source_message_id: `platform-${crypto.randomUUID()}@example.test`,
    requester_email: `person-${label}-${Date.now()}@example.test`,
    requester_name: `Person ${label}`,
    subject: `${label} confidential subject`,
    body: `${label} confidential body`,
    attachments: [],
    received_at: new Date(),
    meta: {},
  });

  return { businessId, ctx, ticketId: intake.ticket.id };
}

beforeAll(async () => {
  try {
    await core.query("select 1");
  } catch {
    available = false;
    return;
  }

  const a = await makeTenant("a");
  const b = await makeTenant("b");
  adminA = a.ctx;
  adminB = b.ctx;

  const keyA = await core.createApiKey(a.ctx, { name: "tenant A monitoring" });
  const keyB = await core.createApiKey(b.ctx, { name: "tenant B monitoring" });

  A = {
    businessId: a.businessId,
    ticketId: a.ticketId,
    token: keyA.token,
    keyId: keyA.key.id,
  };
  B = { businessId: b.businessId, ticketId: b.ticketId, token: keyB.token };
}, 60_000);

afterAll(async () => {
  if (A.businessId) await core.purgeBusinessUnaudited(A.businessId);
  if (B.businessId) await core.purgeBusinessUnaudited(B.businessId);
  await core.closeQueues().catch(() => {});
  await core.closePool().catch(() => {});
});

function guard(): boolean {
  if (!available) {
    console.warn("[platform] no database reachable; skipping. npm run db:up && npm run db:migrate");
  }
  return !available;
}

// ---------------------------------------------------------------------------

describe("api keys", () => {
  it("stores a hash, never the token", async () => {
    if (guard()) return expect(available).toBe(false);

    // The property that makes a database dump useless as a set of credentials.
    const plaintext = await core.query(
      `select id from api_keys where token_hash = $1`,
      [A.token],
    );
    expect(plaintext).toEqual([]);

    const stored = await core.queryOne<{ token_prefix: string }>(
      `select token_prefix from api_keys where id = $1`,
      [A.keyId],
    );
    // Enough to tell two keys apart in a list, not enough to use.
    expect(A.token.startsWith(stored!.token_prefix)).toBe(true);
    expect(stored!.token_prefix.length).toBeLessThan(A.token.length / 2);
  }, 60_000);

  it("resolves to one tenant, with that role's permissions", async () => {
    if (guard()) return expect(available).toBe(false);

    const caller = await core.contextForApiKey(A.token);
    expect(caller?.ctx.businessId).toBe(A.businessId);
    expect(caller?.key.role).toBe("viewer");
    // A key is never more capable than a person with that role: the same
    // permission table, not a second scope system beside it.
    expect(core.can(caller!.ctx, "ticket:read")).toBe(true);
    expect(core.can(caller!.ctx, "ticket:create")).toBe(false);
    expect(core.can(caller!.ctx, "config:update")).toBe(false);
  }, 60_000);

  it("reads only its own tenant's tickets", async () => {
    if (guard()) return expect(available).toBe(false);

    const caller = await core.contextForApiKey(A.token);
    const rows = await core.listTickets(caller!.ctx, { limit: 100 });
    const ids = rows.map((t) => t.id);
    expect(ids).toContain(A.ticketId);
    // The whole point of the table: there is no parameter a caller could send
    // to reach this, and the id of B's ticket matches no row.
    expect(ids).not.toContain(B.ticketId);
    expect(await core.getTicket(caller!.ctx, B.ticketId)).toBeNull();
  }, 60_000);

  it("refuses an unknown, revoked or expired key", async () => {
    if (guard()) return expect(available).toBe(false);

    expect(await core.contextForApiKey("hd_not-a-real-key-at-all-padding")).toBeNull();
    expect(await core.contextForApiKey("")).toBeNull();
    expect(await core.contextForApiKey(null)).toBeNull();
    // Missing the prefix: refused before the hash is even computed.
    expect(await core.contextForApiKey("Bearer something")).toBeNull();

    const expiring = await core.createApiKey(adminA, {
      name: "expires immediately",
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await core.contextForApiKey(expiring.token)).toBeNull();

    const revocable = await core.createApiKey(adminA, { name: "to be revoked" });
    expect(await core.contextForApiKey(revocable.token)).not.toBeNull();
    await core.revokeApiKey(adminA, revocable.key.id, "rotating the integration");
    expect(await core.contextForApiKey(revocable.token)).toBeNull();
  }, 60_000);

  it("will not mint a key more powerful than its creator", async () => {
    if (guard()) return expect(available).toBe(false);

    // `grantableRoles` is what decides, so key creation cannot be the back door
    // into a role its creator could not assign to a person. A security admin
    // holds `security:update` and still cannot reach `super_admin`, which is
    // platform administration and is never granted from a tenant screen.
    await expect(
      core.createApiKey(adminA, { name: "escalation attempt", role: "super_admin" }),
    ).rejects.toThrow(/could not grant that role/);

    // And the ceiling is the creator's own permission set rather than their
    // role name: a context holding `security:update` but not everything an
    // admin carries cannot mint an admin key.
    const narrow = core.humanContext({
      businessId: A.businessId,
      actorId: null,
      actorEmail: "narrow@example.test",
      role: "security_admin",
      permissions: ["security:read", "security:update", "config:update"],
    });
    await expect(
      core.createApiKey(narrow, { name: "borrowed authority", role: "admin" }),
    ).rejects.toThrow(/could not grant that role/);
  }, 60_000);

  it("needs security:update to issue or revoke", async () => {
    if (guard()) return expect(available).toBe(false);

    const viewer = core.humanContext({
      businessId: A.businessId,
      actorId: null,
      actorEmail: "viewer@example.test",
      role: "viewer",
    });
    await expect(
      core.createApiKey(viewer, { name: "from a viewer" }),
    ).rejects.toThrow(core.AuthorizationError);
    await expect(core.listApiKeys(viewer)).rejects.toThrow(core.AuthorizationError);

    // The line worth stating out loud: an ordinary admin may invite people,
    // change configuration and execute actions, and still cannot mint a key.
    // A credential that survives the person who made it, carries a role, and
    // travels outside the console belongs with the integration secrets rather
    // than with the settings.
    const admin = core.humanContext({
      businessId: A.businessId,
      actorId: null,
      actorEmail: "admin@example.test",
      role: "admin",
    });
    await expect(
      core.createApiKey(admin, { name: "from an admin" }),
    ).rejects.toThrow(core.AuthorizationError);
  }, 60_000);

  it("cannot revoke another tenant's key", async () => {
    if (guard()) return expect(available).toBe(false);
    // A foreign id is a 404, not a 403: within a tenant the row's existence is
    // not the secret, and across tenants it is.
    await expect(core.revokeApiKey(adminB, A.keyId, "not mine")).rejects.toThrow(
      core.NotFoundError,
    );
    expect(await core.contextForApiKey(A.token)).not.toBeNull();
  }, 60_000);

  it("audits issuing and revoking", async () => {
    if (guard()) return expect(available).toBe(false);
    const rows = await core.query<{ action: string }>(
      `select action from audit_events
        where business_id = $1 and action like 'api_key.%'`,
      [A.businessId],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("api_key.create");
    expect(actions).toContain("api_key.revoke");
  }, 60_000);

  it("counts requests per key and stops at the limit", async () => {
    if (guard()) return expect(available).toBe(false);

    const caller = (await core.contextForApiKey(A.token))!;
    const before = await core.checkApiRateLimit(caller, 3);
    expect(before.allowed).toBe(true);

    for (let i = 0; i < 3; i++) {
      await core.recordApiRequest({
        businessId: A.businessId,
        apiKeyId: caller.key.id,
        method: "GET",
        path: "/api/v1/tickets",
        status: 200,
        latencyMs: 12,
        ip: "127.0.0.1",
      });
    }

    const after = await core.checkApiRateLimit(caller, 3);
    expect(after.allowed).toBe(false);
    expect(after.used).toBeGreaterThanOrEqual(3);
    expect(after.retryAfter).toBe(60);

    // The same rows are the usage trail, which is the reason this is a table
    // rather than a counter.
    const log = await core.recentApiRequests(adminA, 10);
    expect(log.length).toBeGreaterThanOrEqual(3);
    expect(log[0]!.key_name).toBe("tenant A monitoring");

    const key = (await core.listApiKeys(adminA)).find((k) => k.id === A.keyId);
    expect(Number(key?.request_count)).toBeGreaterThanOrEqual(3);
    expect(key?.last_used_at).not.toBeNull();
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("health", () => {
  it("reports the database and the schema from real queries", async () => {
    if (guard()) return expect(available).toBe(false);

    const report = await core.checkHealth();
    const byName = new Map(report.checks.map((c) => [c.name, c]));

    expect(byName.get("database")?.status).toBe("ok");
    expect(byName.get("database")?.latencyMs).toBeGreaterThanOrEqual(0);
    // The check that catches a deploy running ahead of its migration. The test
    // database is migrated, so this is the passing case.
    expect(byName.get("migrations")?.status).toBe("ok");
    expect(byName.get("migrations")?.data).toMatchObject({
      expected: core.EXPECTED_MIGRATION,
      latest: core.EXPECTED_MIGRATION,
    });
    expect(core.isReady(report)).toBe(true);
  }, 60_000);

  it("reads worker liveness from the age of a heartbeat", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = `test-worker-${Date.now()}`;
    try {
      await livenessFromHeartbeat(id);
    } finally {
      // The row is deployment-wide, and a failed assertion must not leave a
      // dead worker on the System page.
      await core.clearHeartbeat(id).catch(() => {});
    }
  }, 60_000);

  async function livenessFromHeartbeat(id: string): Promise<void> {
    const firstBoot = new Date(Date.now() - 3_600_000);
    await core.recordHeartbeat({
      id,
      kind: "worker",
      hostname: "test-host",
      pid: 4242,
      started_at: firstBoot,
      detail: { mode: "shadow", sweeps: ["expiry"] },
    });

    const fresh = await core.latestHeartbeat("worker");
    expect(fresh?.seconds_ago).toBeLessThan(5);
    expect(fresh?.detail).toMatchObject({ mode: "shadow" });

    const beats = await core.listHeartbeats();
    expect(beats.map((b) => b.id)).toContain(id);

    // What only a database can prove: the age is measured by the database
    // clock against the row, not by the process asking. Nothing ever writes
    // "stopped" — the row stops moving, and ten minutes is past the point
    // where the queues certainly have nobody consuming them.
    await core.query(
      `update worker_heartbeats set last_seen_at = now() - interval '10 minutes' where id = $1`,
      [id],
    );
    const aged = await core.queryOne<{ seconds_ago: number }>(
      `select extract(epoch from (now() - last_seen_at))::int as seconds_ago
         from worker_heartbeats where id = $1`,
      [id],
    );
    expect(aged!.seconds_ago).toBeGreaterThan(300);
    // The verdict itself is arithmetic and is tested in health.test.ts. It is
    // read here rather than through `checkHealth`, because that reads the
    // *freshest* worker row — so a real worker running alongside this suite
    // would otherwise decide the assertion.
    expect(core.workerStatus(aged!.seconds_ago)).toBe("down");

    // A restart updates the row rather than accumulating one per boot, and
    // the row says when the process now writing it started, not the first one.
    const secondBoot = new Date();
    await core.recordHeartbeat({ id, kind: "worker", pid: 4243, started_at: secondBoot });
    const restarted = await core.listHeartbeats();
    expect(restarted.filter((b) => b.id === id)).toHaveLength(1);
    const row = restarted.find((b) => b.id === id);
    expect(row?.pid).toBe(4243);
    expect(row?.started_at.getTime()).toBe(secondBoot.getTime());

    // A beat that does not say when it started leaves the start time alone.
    await core.recordHeartbeat({ id, kind: "worker", pid: 4243 });
    const beat = (await core.listHeartbeats()).find((b) => b.id === id);
    expect(beat?.started_at.getTime()).toBe(secondBoot.getTime());

    // A deliberate shutdown removes its row. A crash leaves one, which is the
    // whole point.
    await core.clearHeartbeat(id);
    expect((await core.listHeartbeats()).map((b) => b.id)).not.toContain(id);
  }
});
