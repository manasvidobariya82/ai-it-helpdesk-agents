import { describe, expect, it } from "vitest";
import {
  AuthorizationError,
  NotFoundError,
  actorString,
  agentContext,
  assertSameTenant,
  can,
  canAll,
  humanContext,
  portalContext,
  requirePermission,
  systemContext,
} from "../src/auth/context.js";

const BUSINESS_A = "00000000-0000-0000-0000-0000000000aa";
const BUSINESS_B = "00000000-0000-0000-0000-0000000000bb";

/**
 * The context is the unit of authorization: it says who is acting, in which
 * tenant, with which permissions. Everything below the HTTP layer takes one,
 * and these tests pin the properties the rest of the system assumes.
 */

describe("context construction", () => {
  it("refuses to exist without a tenant", () => {
    expect(() =>
      humanContext({ businessId: "", actorId: "u1", role: "admin" }),
    ).toThrow(AuthorizationError);
  });

  it("derives permissions from the role", () => {
    const ctx = humanContext({
      businessId: BUSINESS_A,
      actorId: "u1",
      actorEmail: "manager@example.com",
      role: "manager",
    });
    expect(can(ctx, "action:approve")).toBe(true);
    expect(can(ctx, "config:update")).toBe(false);
  });

  it("is frozen, so nothing can grant itself a permission mid-request", () => {
    const ctx = humanContext({ businessId: BUSINESS_A, actorId: "u1", role: "viewer" });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.permissions)).toBe(true);

    // Silent in sloppy mode, throws under the module's strictness; either way
    // the permission must not appear.
    try {
      (ctx.permissions as string[]).push("config:update");
    } catch {
      /* frozen array, as intended */
    }
    expect(can(ctx, "config:update")).toBe(false);
  });
});

describe("the agent's own context", () => {
  const agent = agentContext(BUSINESS_A);

  /**
   * The invariant the whole roadmap rests on: the agent cannot make itself
   * more autonomous. It is enforced here, in the permission set the pipeline
   * runs under, rather than by every call site remembering to check.
   */
  it("cannot change configuration or widen its own autonomy", () => {
    expect(can(agent, "config:update")).toBe(false);
    expect(can(agent, "security:update")).toBe(false);
    expect(can(agent, "agent:configure")).toBe(false);
  });

  it("cannot approve the actions it requests", () => {
    expect(can(agent, "action:execute")).toBe(true);
    expect(can(agent, "action:approve")).toBe(false);
  });

  it("cannot read integration secrets or the audit log", () => {
    expect(can(agent, "credentials:read")).toBe(false);
    expect(can(agent, "audit:read")).toBe(false);
  });

  it("can do the work it exists for", () => {
    expect(canAll(agent, ["ticket:read", "ticket:update", "ticket:close", "kb:read"])).toBe(
      true,
    );
  });
});

describe("the portal's context", () => {
  const portal = portalContext(BUSINESS_A);

  /**
   * A portal link is a capability, not a login. It is handed to somebody who is
   * often locked out of their account, so the context it produces has to be the
   * smallest thing that still renders their own tickets.
   */
  it("holds two permissions and nothing else", () => {
    expect([...portal.permissions].sort()).toEqual(["ticket:create", "ticket:read"]);
  });

  it("cannot reach analytics, configuration or other people's work", () => {
    expect(can(portal, "analytics:read")).toBe(false);
    expect(can(portal, "config:read")).toBe(false);
    expect(can(portal, "ticket:assign")).toBe(false);
  });

  it("C5 cannot read the desk's internal notes and drafts", () => {
    // The only thing between a requester and the notes about them.
    expect(can(portal, "ticket_internal:read")).toBe(false);
  });
});

describe("requirePermission", () => {
  const viewer = humanContext({
    businessId: BUSINESS_A,
    actorId: "u1",
    actorEmail: "viewer@example.com",
    role: "viewer",
  });

  it("throws rather than returning false, so a forgotten check is not a pass", () => {
    expect(() => requirePermission(viewer, "ticket:read")).not.toThrow();
    expect(() => requirePermission(viewer, "ticket:update")).toThrow(AuthorizationError);
  });

  it("names the actor and the missing permission", () => {
    try {
      requirePermission(viewer, "config:update");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationError);
      expect((err as AuthorizationError).permission).toBe("config:update");
      expect((err as Error).message).toContain("viewer@example.com");
      expect((err as AuthorizationError).status).toBe(403);
    }
  });
});

describe("assertSameTenant", () => {
  const ctx = humanContext({ businessId: BUSINESS_A, actorId: "u1", role: "admin" });

  it("passes a row from the caller's own tenant", () => {
    expect(() => assertSameTenant(ctx, { business_id: BUSINESS_A }, "ticket")).not.toThrow();
  });

  /**
   * A 404 and not a 403. The difference is the whole point: a 403 on a foreign
   * id confirms the id exists, which turns any detail page into an enumeration
   * oracle. "Not yours" and "not there" must be indistinguishable.
   */
  it("reports a foreign row as missing, not as forbidden", () => {
    for (const row of [{ business_id: BUSINESS_B }, null, undefined]) {
      let thrown: unknown;
      try {
        assertSameTenant(ctx, row, "ticket");
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(NotFoundError);
      expect((thrown as NotFoundError).status).toBe(404);
    }
  });
});

describe("actorString", () => {
  /**
   * The console used to write the constant `human:console` here. Nothing about
   * that string can be revoked, scoped or asked about afterwards, which is what
   * this whole phase replaced.
   */
  it("carries a real user id for a person", () => {
    const ctx = humanContext({
      businessId: BUSINESS_A,
      actorId: "usr_123",
      actorEmail: "a@example.com",
      role: "admin",
    });
    expect(actorString(ctx)).toBe("human:usr_123");
    expect(actorString(ctx)).not.toBe("human:console");
  });

  it("distinguishes the agent and the system from a person", () => {
    expect(actorString(agentContext(BUSINESS_A))).toBe("agent");
    expect(actorString(systemContext(BUSINESS_A))).toBe("system");
  });
});

describe("viaSuperAdmin", () => {
  /**
   * Platform administration reaching into a tenant is legitimate and worth
   * flagging. The console renders a banner off this, and every audit row it
   * writes still names the individual rather than "support".
   */
  it("is off by default and set explicitly", () => {
    const member = humanContext({ businessId: BUSINESS_A, actorId: "u1", role: "admin" });
    expect(member.viaSuperAdmin).toBe(false);

    const platform = humanContext({
      businessId: BUSINESS_A,
      actorId: "u2",
      role: "super_admin",
      viaSuperAdmin: true,
    });
    expect(platform.viaSuperAdmin).toBe(true);
  });
});
