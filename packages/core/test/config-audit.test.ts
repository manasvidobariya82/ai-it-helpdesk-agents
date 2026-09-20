import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as core from "../src/index.js";

/**
 * The configuration audit log, against a real database.
 *
 * Three of the properties here cannot be tested any other way. Immutability is
 * enforced by database triggers, so a mock would happily let a test rewrite
 * history and report success. Version numbering is allocated under a row lock,
 * so concurrency is only meaningful against a real connection pool. And the
 * "which configuration decided this ticket" question is a join.
 *
 * Skips itself when no database is reachable; CI sets `REQUIRE_DB=1`, which
 * turns that skip into a failure.
 *
 *   npm run db:up && npm run db:migrate
 */

const REQUIRE_DB = process.env.REQUIRE_DB === "1";
let available = true;

const { humanContext, agentContext, systemContext, AuthorizationError } = core;

interface Tenant {
  businessId: string;
  /** Holds security:update, so may change autonomy. */
  security: core.TenantContext;
  /** A second one, for dual control. */
  security2: core.TenantContext;
  /** config:update but not security:update. */
  admin: core.TenantContext;
  securityUserId: string;
  security2UserId: string;
  adminUserId: string;
}

let A: Tenant;
let B: Tenant;

async function makeTenant(label: string): Promise<Tenant> {
  const stamp = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const biz = await core.queryOne<{ id: string }>(
    `insert into businesses (name, type, settings) values ($1,'it_services','{}'::jsonb)
     returning id`,
    [`config-${stamp}`],
  );
  const businessId = biz!.id;

  // Migration 0008 seeds a v1 for tenants that exist when it runs; a tenant
  // created afterwards needs one, exactly as the seed script does.
  await core.query(
    `insert into config_versions (business_id, version, settings, status, source, reason)
     values ($1, 1, (select settings from businesses where id = $1), 'current', 'seed',
             'Initial version')`,
    [businessId],
  );

  const mk = async (role: core.Role, who: string) => {
    const id = await core.createUserUnaudited({
      email: `${who}-${stamp}@example.test`,
      fullName: `${who} ${label}`,
      password: "correct horse battery staple",
    });
    await core.addMembershipUnaudited(id, businessId, role);
    return {
      id,
      ctx: humanContext({
        businessId,
        actorId: id,
        actorEmail: `${who}-${stamp}@example.test`,
        role,
      }),
    };
  };

  const sec = await mk("security_admin", "sec");
  const sec2 = await mk("security_admin", "sec2");
  const admin = await mk("admin", "admin");

  return {
    businessId,
    security: sec.ctx,
    security2: sec2.ctx,
    admin: admin.ctx,
    securityUserId: sec.id,
    security2UserId: sec2.id,
    adminUserId: admin.id,
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
  A = await makeTenant("a");
  B = await makeTenant("b");
}, 120_000);

afterAll(async () => {
  if (available) {
    for (const t of [A, B]) {
      if (!t) continue;
      await core.purgeBusinessUnaudited(t.businessId);
      await core.query(`delete from users where id = any($1::uuid[])`, [
        [t.securityUserId, t.security2UserId, t.adminUserId],
      ]);
    }
  }
  await core.closePool().catch(() => {});
});

const guard = () => !available;

/** Change one category's threshold, the canonical governance example. */
async function setThreshold(
  ctx: core.TenantContext,
  businessId: string,
  value: number,
  reason: string,
) {
  const current = await core.getSettings(businessId);
  return core.updateSettings(
    ctx,
    core.BusinessSettings.parse({
      ...current,
      category_policies: {
        ...current.category_policies,
        network_connectivity: { autonomy: "reply", confidence_threshold: value },
      },
    }),
    { reason, acknowledgeWidening: true },
  );
}

// ---------------------------------------------------------------------------

describe("every change produces a version", () => {
  it("numbers versions monotonically per tenant", async () => {
    if (guard()) return expect(available).toBe(false);

    const first = await setThreshold(A.security, A.businessId, 0.9, "Initial calibration");
    const second = await setThreshold(
      A.security,
      A.businessId,
      0.85,
      "Second pass after evaluation run #183",
    );
    const third = await setThreshold(
      A.security,
      A.businessId,
      0.82,
      "Updated after evaluation run #184",
    );

    expect(second.version).toBe(first.version! + 1);
    expect(third.version).toBe(second.version! + 1);

    const current = await core.currentConfigVersion(A.security);
    expect(current?.version).toBe(third.version);
    expect(
      current?.settings.category_policies.network_connectivity?.confidence_threshold,
    ).toBe(0.82);
  });

  it("keeps exactly one current version", async () => {
    if (guard()) return expect(available).toBe(false);
    const row = await core.queryOne<{ n: number }>(
      `select count(*)::int as n from config_versions
        where business_id = $1 and status = 'current'`,
      [A.businessId],
    );
    expect(row?.n).toBe(1);
  });

  it("stores a full snapshot, not a diff", async () => {
    if (guard()) return expect(available).toBe(false);
    const versions = await core.listConfigVersions(A.security);
    for (const v of versions) {
      // Every version must stand alone: reconstructing v12 by replaying eleven
      // diffs means a bug in any one of them silently rewrites history.
      expect(v.settings.default_policy).toBeTruthy();
      expect(typeof v.settings.kb_support_floor).toBe("number");
    }
  });

  it("records who, why, and both values", async () => {
    if (guard()) return expect(available).toBe(false);
    const rows = await core.listAudit(A.security, {
      field: "category_policies.network_connectivity.confidence_threshold",
    });

    const latest = rows[0]!;
    expect(latest.action).toBe("config.autonomy_change");
    expect(latest.old_value).toBe(0.85);
    expect(latest.new_value).toBe(0.82);
    expect(latest.reason).toBe("Updated after evaluation run #184");
    expect(latest.actor_id).toBe(A.securityUserId);
    expect(latest.actor_role).toBe("security_admin");
    expect(latest.business_id).toBe(A.businessId);
    expect(latest.created_at).toBeTruthy();
    expect(latest.config_version).toBeTruthy();

    const meta = latest.metadata as { risk?: string; direction?: string };
    expect(meta.risk).toBe("critical");
    expect(meta.direction).toBe("widening");
  });

  it("writes the audit rows in the same transaction as the version", async () => {
    if (guard()) return expect(available).toBe(false);
    const versions = await core.listConfigVersions(A.security);
    for (const v of versions) {
      if (v.source === "seed" || v.summary.length === 0) continue;
      const rows = await core.listAudit(A.security, { configVersion: v.version });
      // A settings write that committed while its audit rows rolled back is
      // exactly the state this feature exists to make impossible.
      expect(rows.length, `v${v.version} has no audit rows`).toBe(v.summary.length);
    }
  });
});

// ---------------------------------------------------------------------------

describe("history cannot be edited", () => {
  it("refuses an update to an audit row", async () => {
    if (guard()) return expect(available).toBe(false);
    const row = await core.queryOne<{ id: number }>(
      `select id from audit_events where business_id = $1 limit 1`,
      [A.businessId],
    );
    await expect(
      core.query(`update audit_events set reason = 'tidied up' where id = $1`, [row!.id]),
    ).rejects.toThrow(/append-only/i);
  });

  it("refuses a delete from the audit log", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      core.query(`delete from audit_events where business_id = $1`, [A.businessId]),
    ).rejects.toThrow(/append-only/i);
  });

  it("refuses to rewrite a configuration version", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      core.query(
        `update config_versions set reason = 'something else' where business_id = $1`,
        [A.businessId],
      ),
    ).rejects.toThrow(/append-only/i);
  });

  it("refuses to delete a configuration version", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      core.query(`delete from config_versions where business_id = $1 and version = 1`, [
        A.businessId,
      ]),
    ).rejects.toThrow(/append-only/i);
  });

  it("still allows a version to be superseded", async () => {
    if (guard()) return expect(available).toBe(false);
    // Retiring a version is a status change and therefore an update; the guard
    // has to let that one through or no new version could ever be written.
    const before = await core.currentConfigVersion(A.security);
    await setThreshold(A.security, A.businessId, 0.83, "Still tuning");
    const after = await core.currentConfigVersion(A.security);

    expect(after!.version).toBe(before!.version + 1);
    const old = await core.getConfigVersion(A.security, before!.version);
    expect(old?.status).toBe("superseded");
    expect(old?.reason).toBe(before!.reason);
  });
});

// ---------------------------------------------------------------------------

describe("rollback", () => {
  it("restores the values and creates a new version rather than removing one", async () => {
    if (guard()) return expect(available).toBe(false);

    const versions = await core.listConfigVersions(A.security);
    const target = versions.find(
      (v) =>
        v.settings.category_policies.network_connectivity?.confidence_threshold === 0.9,
    );
    expect(target, "expected an earlier version holding 0.9").toBeTruthy();

    const countBefore = versions.length;
    const result = await core.rollbackConfig(A.security, target!.version, {
      reason: "The 0.82 threshold produced too many wrong answers",
      acknowledgeWidening: true,
    });

    const settings = await core.getSettings(A.businessId);
    expect(
      settings.category_policies.network_connectivity?.confidence_threshold,
    ).toBe(0.9);

    const after = await core.listConfigVersions(A.security);
    expect(after.length).toBe(countBefore + 1);
    expect(after[0]!.version).toBe(result.version);
    expect(after[0]!.source).toBe("rollback");
    expect(after[0]!.restored_from).toBe(target!.version);

    // The version it rolled back *from* is still there saying what it said.
    const superseded = await core.getConfigVersion(A.security, countBefore);
    expect(superseded).toBeTruthy();
  });

  it("audits the rollback like any other change", async () => {
    if (guard()) return expect(available).toBe(false);
    const current = await core.currentConfigVersion(A.security);
    const rows = await core.listAudit(A.security, { configVersion: current!.version });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.reason).toMatch(/Rollback to v/);
    expect(rows[0]!.actor_id).toBe(A.securityUserId);
  });

  it("refuses a rollback with no reason", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      core.rollbackConfig(A.security, 1, { reason: "  " }),
    ).rejects.toThrow(/reason/i);
  });

  it("refuses a rollback to a version in another tenant", async () => {
    if (guard()) return expect(available).toBe(false);
    // B has far fewer versions; asking A to roll back to a number it does not
    // have must be a 404 rather than reaching across.
    await expect(
      core.rollbackConfig(B.security, 999, { reason: "cross tenant" }),
    ).rejects.toBeInstanceOf(core.NotFoundError);
  });
});

// ---------------------------------------------------------------------------

describe("high-risk change protection", () => {
  it("refuses a critical change from an admin without security:update", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(
      setThreshold(A.admin, A.businessId, 0.5, "trying it on"),
    ).rejects.toBeInstanceOf(core.ConfigChangeDenied);
  });

  it("audits the refusal", async () => {
    if (guard()) return expect(available).toBe(false);
    const rows = await core.listAudit(A.security, { action: "authz.denied" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.actor_id).toBe(A.adminUserId);
  });

  it("requires a written reason for a critical change", async () => {
    if (guard()) return expect(available).toBe(false);
    const current = await core.getSettings(A.businessId);
    await expect(
      core.updateSettings(
        A.security,
        core.BusinessSettings.parse({ ...current, kb_support_floor: 0.2 }),
        { acknowledgeWidening: true },
      ),
    ).rejects.toThrow(/reason is required/i);
  });

  /**
   * The server-side half of "require confirmation". Without it the impact
   * dialog would be decoration that a direct POST walks straight past.
   */
  it("refuses a widening change that was not acknowledged", async () => {
    if (guard()) return expect(available).toBe(false);
    const current = await core.getSettings(A.businessId);
    await expect(
      core.updateSettings(
        A.security,
        core.BusinessSettings.parse({ ...current, kb_support_floor: 0.2 }),
        { reason: "lowering the evidence floor" },
      ),
    ).rejects.toBeInstanceOf(core.ConfirmationRequired);
  });

  it("lets a narrowing change through without one", async () => {
    if (guard()) return expect(available).toBe(false);
    const current = await core.getSettings(A.businessId);
    const result = await core.updateSettings(
      A.security,
      core.BusinessSettings.parse({ ...current, kb_support_floor: 0.8 }),
      { reason: "raising the evidence floor" },
    );
    // Applying the brake never waits for a dialog.
    expect(result.version).toBeTruthy();
  });

  it("previews the impact without changing anything", async () => {
    if (guard()) return expect(available).toBe(false);
    const before = await core.currentConfigVersion(A.security);
    const current = await core.getSettings(A.businessId);

    const preview = await core.previewSettingsChange(
      A.security,
      core.BusinessSettings.parse({ ...current, kb_support_floor: 0.2 }),
    );

    expect(preview.needsAcknowledgement).toBe(true);
    expect(preview.impact[0]!.text.length).toBeGreaterThan(0);
    expect(preview.changes[0]!.direction).toBe("widening");

    const after = await core.currentConfigVersion(A.security);
    expect(after!.version).toBe(before!.version);
  });

  it("refuses a configuration change from the agent itself", async () => {
    if (guard()) return expect(available).toBe(false);
    const current = await core.getSettings(A.businessId);
    await expect(
      core.updateSettings(agentContext(A.businessId), current),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

// ---------------------------------------------------------------------------

describe("dual control", () => {
  it("parks a widening change when the tenant asks for a second approver", async () => {
    if (guard()) return expect(available).toBe(false);

    // Turning the requirement on is itself a narrowing change, so it applies
    // immediately and needs nobody.
    const current = await core.getSettings(B.businessId);
    await core.updateSettings(
      B.security,
      core.BusinessSettings.parse({
        ...current,
        require_dual_control_for_widening: true,
      }),
      { reason: "Change control on" },
    );

    const before = await core.getSettings(B.businessId);
    await expect(
      setThreshold(B.security, B.businessId, 0.5, "wants a second pair of eyes"),
    ).rejects.toBeInstanceOf(core.SecondApproverRequired);

    // Nothing applied yet.
    const after = await core.getSettings(B.businessId);
    expect(after.category_policies.network_connectivity).toEqual(
      before.category_policies.network_connectivity,
    );

    const pending = await core.pendingConfigRequests(B.security);
    expect(pending.length).toBe(1);
    expect(pending[0]!.requested_by).toBe(B.securityUserId);
  });

  it("refuses to let the proposer approve their own change", async () => {
    if (guard()) return expect(available).toBe(false);
    const pending = await core.pendingConfigRequests(B.security);
    await expect(
      core.decideConfigRequest(B.security, pending[0]!.id, "approved"),
    ).rejects.toBeInstanceOf(AuthorizationError);

    // Still pending, and the refusal is in the log.
    expect((await core.pendingConfigRequests(B.security)).length).toBe(1);
    const denied = await core.listAudit(B.security, { action: "authz.denied" });
    expect(denied[0]!.resource_type).toBe("config_change_request");
  });

  it("applies it when a different administrator approves", async () => {
    if (guard()) return expect(available).toBe(false);
    const pending = await core.pendingConfigRequests(B.security);
    const result = await core.decideConfigRequest(
      B.security2,
      pending[0]!.id,
      "approved",
      { reason: "Reviewed the evaluation run" },
    );

    expect(result?.version).toBeTruthy();
    const settings = await core.getSettings(B.businessId);
    expect(
      settings.category_policies.network_connectivity?.confidence_threshold,
    ).toBe(0.5);

    expect((await core.pendingConfigRequests(B.security)).length).toBe(0);

    // Both names are on the record.
    const version = await core.currentConfigVersion(B.security);
    expect(version!.reason).toContain("proposed by");
    expect(version!.reason).toContain("approved by");
  });

  it("refuses a proposal whose base version has moved", async () => {
    if (guard()) return expect(available).toBe(false);

    await expect(
      setThreshold(B.security, B.businessId, 0.4, "another widening"),
    ).rejects.toBeInstanceOf(core.SecondApproverRequired);
    const pending = await core.pendingConfigRequests(B.security);

    // Somebody else changes something in between. The approver agreed to a
    // specific diff; applying it now would silently revert that change.
    const current = await core.getSettings(B.businessId);
    await core.updateSettings(
      B.security,
      core.BusinessSettings.parse({ ...current, signature: "— Moved On" }),
      { reason: "unrelated edit" },
    );

    await expect(
      core.decideConfigRequest(B.security2, pending[0]!.id, "approved"),
    ).rejects.toThrow(/configuration has changed/i);
  });
});

// ---------------------------------------------------------------------------

describe("cross-tenant access", () => {
  it("does not list another tenant's versions", async () => {
    if (guard()) return expect(available).toBe(false);
    const versions = await core.listConfigVersions(B.security);
    expect(versions.every((v) => v.business_id === B.businessId)).toBe(true);
  });

  it("does not resolve another tenant's version by number", async () => {
    if (guard()) return expect(available).toBe(false);
    const aVersions = await core.listConfigVersions(A.security);
    const highest = aVersions[0]!.version;
    // B has fewer versions, so this number exists in A and not in B.
    const bView = await core.getConfigVersion(B.security, highest);
    if (bView) expect(bView.business_id).toBe(B.businessId);
    else expect(bView).toBeNull();
  });

  it("does not leak another tenant's configuration audit rows", async () => {
    if (guard()) return expect(available).toBe(false);
    const rows = await core.listAudit(B.security, { limit: 500 });
    expect(rows.every((r) => r.business_id === B.businessId)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("evaluation run #184");
  });

  it("does not let a proposal be approved from another tenant", async () => {
    if (guard()) return expect(available).toBe(false);
    const pending = await core.pendingConfigRequests(B.security);
    if (pending.length === 0) return expect(pending.length).toBe(0);
    // A's security admin, B's request id.
    const out = await core.decideConfigRequest(A.security, pending[0]!.id, "approved");
    expect(out).toBeNull();
  });

  it("keeps the audit log closed to accounts without audit:read", async () => {
    if (guard()) return expect(available).toBe(false);
    await expect(core.listAudit(agentContext(A.businessId))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

// ---------------------------------------------------------------------------

describe("search and filter", () => {
  it("filters to one field", async () => {
    if (guard()) return expect(available).toBe(false);
    const field = "category_policies.network_connectivity.confidence_threshold";
    const rows = await core.listAudit(A.security, { field });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.field === field)).toBe(true);
  });

  it("filters by field prefix, across every category", async () => {
    if (guard()) return expect(available).toBe(false);
    const rows = await core.listAudit(A.security, {
      fieldPrefix: "category_policies",
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.field?.startsWith("category_policies"))).toBe(true);
  });

  it("searches free text across reason and field", async () => {
    if (guard()) return expect(available).toBe(false);
    const rows = await core.listAudit(A.security, { search: "evaluation run #184" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.new_value).toBe(0.82);
  });

  it("filters by actor", async () => {
    if (guard()) return expect(available).toBe(false);
    const rows = await core.listAudit(A.security, { actorId: A.adminUserId });
    expect(rows.every((r) => r.actor_id === A.adminUserId)).toBe(true);
  });

  it("counts with the same predicate it lists with", async () => {
    if (guard()) return expect(available).toBe(false);
    const filters = { fieldPrefix: "category_policies" };
    const rows = await core.listAudit(A.security, { ...filters, limit: 1000 });
    const total = await core.countAudit(A.security, filters);
    // A paginator whose count comes from a different predicate than its rows
    // is a paginator that lies at the last page.
    expect(total).toBe(rows.length);
  });

  it("returns one field's history in order", async () => {
    if (guard()) return expect(available).toBe(false);
    const history = await core.fieldHistory(
      A.security,
      "category_policies.network_connectivity.confidence_threshold",
    );
    expect(history.length).toBeGreaterThanOrEqual(3);
    for (const row of history) {
      expect(row.actor_email).toBeTruthy();
      expect(row.config_version).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------

describe("replay", () => {
  it("answers which configuration was active at a moment", async () => {
    if (guard()) return expect(available).toBe(false);
    const versions = await core.listConfigVersions(A.security);
    const middle = versions[Math.floor(versions.length / 2)]!;

    const at = await core.configVersionAt(
      A.security,
      new Date(new Date(middle.created_at).getTime() + 1),
    );
    expect(at!.version).toBe(middle.version);
  });

  it("stamps the version that decided a ticket", async () => {
    if (guard()) return expect(available).toBe(false);

    const sys = systemContext(A.businessId);
    const requester = await core.upsertRequester({
      business_id: A.businessId,
      email: `replay-${Date.now()}@example.test`,
      full_name: "Replay Tester",
    });
    const { ticket } = await core.createTicketFromMessage(
      sys,
      {
        source: "email",
        source_message_id: `replay-${Date.now()}-${Math.random()}`,
        requester_email: requester.email,
        requester_name: requester.full_name,
        subject: "Replay",
        body: "Replay",
        attachments: [],
        received_at: new Date(),
        meta: {},
      },
      requester.id,
      null,
    );

    const version = await core.currentConfigVersionNumber(A.businessId);
    await core.applyTriage(
      sys,
      ticket.id,
      {
        category: "network_connectivity",
        subcategory: "vpn",
        priority: "P3",
        confidence: 0.88,
        resolution_path: "auto_reply",
        status: "resolved",
        config_version: version,
      },
      await core.getSettings(A.businessId),
    );

    const stamped = await core.getTicket(A.security, ticket.id);
    expect(stamped?.config_version).toBe(version);

    // And the threshold that judged it is recoverable even after it moves.
    const decidedUnder = await core.getConfigVersion(
      A.security,
      stamped!.config_version!,
    );
    expect(decidedUnder).toBeTruthy();
    expect(
      typeof decidedUnder!.settings.category_policies.network_connectivity
        ?.confidence_threshold,
    ).toBe("number");

    await setThreshold(A.security, A.businessId, 0.99, "Moved after the fact");
    const stillTheSame = await core.getConfigVersion(
      A.security,
      stamped!.config_version!,
    );
    expect(
      stillTheSame!.settings.category_policies.network_connectivity
        ?.confidence_threshold,
    ).toBe(
      decidedUnder!.settings.category_policies.network_connectivity
        ?.confidence_threshold,
    );
  });
});
