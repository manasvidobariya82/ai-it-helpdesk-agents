import { describe, expect, it } from "vitest";
import {
  Permission,
  ROLE_PERMISSIONS,
  Role,
  parseRole,
  permissionsFor,
  roleHas,
} from "../src/auth/permissions.js";

/**
 * The grant table.
 *
 * These tests exist because the alternative to a table is `if (user.role ===
 * "admin")` scattered through the codebase, and the first thing that goes wrong
 * with that is nobody can answer "what can a manager actually do" without
 * grepping. Here the answer is one object, and these assert the properties that
 * have to hold of it whatever is added later.
 */

describe("role grants", () => {
  it("covers every role in the enum", () => {
    for (const role of Role.options) {
      expect(ROLE_PERMISSIONS[role], `no grants for ${role}`).toBeDefined();
    }
  });

  it("grants only permissions that exist", () => {
    const known = new Set<string>(Permission.options);
    for (const role of Role.options) {
      for (const p of permissionsFor(role)) {
        expect(known.has(p), `${role} grants unknown permission ${p}`).toBe(true);
      }
    }
  });

  /**
   * The roles are a ladder, and a ladder with a missing rung is how somebody
   * gets promoted and loses an ability. Each role must hold everything the one
   * below it does.
   */
  it("is monotonic from viewer up to security_admin", () => {
    const ladder: Role[] = ["viewer", "agent", "manager", "admin", "security_admin"];
    for (let i = 1; i < ladder.length; i++) {
      const lower = permissionsFor(ladder[i - 1]!);
      const higher = new Set(permissionsFor(ladder[i]!));
      for (const p of lower) {
        expect(higher.has(p), `${ladder[i]} is missing ${p} that ${ladder[i - 1]} has`).toBe(
          true,
        );
      }
    }
  });

  it("keeps a viewer read-only", () => {
    const viewer = permissionsFor("viewer");
    for (const p of viewer) {
      expect(p.endsWith(":read"), `viewer holds non-read permission ${p}`).toBe(true);
    }
  });

  /**
   * The separation the roadmap's invariant rests on. An ordinary admin runs the
   * tenant; widening autonomy, rotating integration secrets and reading them
   * back are a different blast radius and a different role.
   */
  it("withholds security and credential permissions from admin", () => {
    expect(roleHas("admin", "config:update")).toBe(true);
    expect(roleHas("admin", "security:read")).toBe(true);

    expect(roleHas("admin", "security:update")).toBe(false);
    expect(roleHas("admin", "credentials:read")).toBe(false);
    expect(roleHas("admin", "credentials:update")).toBe(false);

    expect(roleHas("security_admin", "security:update")).toBe(true);
    expect(roleHas("security_admin", "credentials:read")).toBe(true);
  });

  it("separates asking for an action from approving one", () => {
    // A manager signs actions off; an admin is the one who may run them
    // directly. Holding both is possible, but they are distinct grants so a
    // deployment can keep them apart.
    expect(roleHas("manager", "action:approve")).toBe(true);
    expect(roleHas("manager", "action:execute")).toBe(false);
    expect(roleHas("admin", "action:execute")).toBe(true);
  });

  it("keeps an agent account out of the audit log and configuration", () => {
    expect(roleHas("agent", "audit:read")).toBe(false);
    expect(roleHas("agent", "config:read")).toBe(false);
    expect(roleHas("agent", "config:update")).toBe(false);
    expect(roleHas("agent", "ticket:assign")).toBe(false);
  });

  it("C5 lets every staff role read the desk's side of a conversation", () => {
    // Internal notes are how people at the desk talk to each other, so a
    // viewer who could read the ticket but not its notes would read half of
    // it. The portal is the one context without this (authorization.test).
    for (const role of Role.options) {
      expect(roleHas(role, "ticket_internal:read"), `${role} cannot read notes`).toBe(true);
    }
  });

  it("never grants credentials:read below security_admin", () => {
    for (const role of ["viewer", "agent", "manager", "admin"] as Role[]) {
      expect(roleHas(role, "credentials:read"), `${role} can read secrets`).toBe(false);
    }
  });

  it("returns frozen, deduplicated lists", () => {
    for (const role of Role.options) {
      const list = permissionsFor(role);
      expect(Object.isFrozen(list)).toBe(true);
      expect(new Set(list).size).toBe(list.length);
    }
  });
});

describe("parseRole", () => {
  it("accepts known roles", () => {
    expect(parseRole("manager")).toBe("manager");
  });

  /**
   * A role string the enum does not know about grants nothing. The tempting
   * alternative — defaulting to `viewer` — is wrong in a subtler way than it
   * looks: it turns a typo in a migration into a silently working account, and
   * the row stops being visible as broken.
   */
  it("refuses anything else rather than defaulting", () => {
    expect(parseRole("administrator")).toBeNull();
    expect(parseRole("ADMIN")).toBeNull();
    expect(parseRole("")).toBeNull();
    expect(parseRole(null)).toBeNull();
    expect(parseRole(undefined)).toBeNull();
    expect(parseRole(42)).toBeNull();
    expect(parseRole({ role: "admin" })).toBeNull();
  });
});
