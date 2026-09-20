import { z } from "zod";

/**
 * Roles and permissions.
 *
 * The rule this file exists to enforce: feature code asks `can(ctx,
 * "config:update")`, never `if (user.role === "admin")`. A role check scattered
 * through call sites is a policy you cannot read in one place, and the first
 * time you add a role you find the six sites that forgot about it.
 *
 * Six roles is deliberately few. Finer permissions are cheap to add later —
 * the grant table below is the only thing that changes — and a taxonomy of
 * twenty roles invented before anybody has used six is a taxonomy nobody can
 * assign correctly.
 */

export const Permission = z.enum([
  "ticket:read",
  "ticket:create",
  "ticket:update",
  "ticket:assign",
  "ticket:close",
  "ticket:reopen",
  // The desk's side of a conversation: internal notes, drafts, internal
  // activity. Every staff role holds it and the portal does not, which is the
  // whole of the difference between what the desk sees and what the requester
  // sees (C5 in docs/conversation.md).
  "ticket_internal:read",

  "kb:read",
  "kb:create",
  "kb:update",
  "kb:publish",

  "agent:read",
  "agent:configure",
  "agent:override",

  "analytics:read",

  "config:read",
  "config:update",

  "action:approve",
  "action:execute",

  "audit:read",

  // Split out from config:update. Integration secrets, autonomy widening and
  // the kill switch are the changes whose blast radius is not the tenant's own
  // tickets, and an ordinary admin should not hold them by default.
  "security:read",
  "security:update",
  "credentials:read",
  "credentials:update",
]);
export type Permission = z.infer<typeof Permission>;

export const Role = z.enum([
  "viewer",
  "agent",
  "manager",
  "admin",
  "security_admin",
  "super_admin",
]);
export type Role = z.infer<typeof Role>;

const VIEWER: Permission[] = [
  "ticket:read",
  "ticket_internal:read",
  "kb:read",
  "agent:read",
  "analytics:read",
];

const AGENT: Permission[] = [
  ...VIEWER,
  "ticket:create",
  "ticket:update",
  "ticket:close",
  "kb:create",
];

const MANAGER: Permission[] = [
  ...AGENT,
  "ticket:assign",
  "ticket:reopen",
  "kb:update",
  "kb:publish",
  "agent:override",
  "action:approve",
  "config:read",
  "audit:read",
];

const ADMIN: Permission[] = [
  ...MANAGER,
  "agent:configure",
  "config:update",
  "action:execute",
  "security:read",
];

// Everything an admin has, plus the settings whose blast radius is not this
// tenant's own tickets: autonomy, the kill switch, integration secrets.
const SECURITY_ADMIN: Permission[] = [
  ...ADMIN,
  "security:update",
  "credentials:read",
  "credentials:update",
];

/**
 * Platform administration. Note that `super_admin` is a *role within a tenant*
 * here; the ability to reach a tenant you are not a member of is
 * `users.is_super_admin`, checked separately when the context is built. Two
 * different questions, kept apart on purpose.
 */
const SUPER_ADMIN: Permission[] = [...SECURITY_ADMIN];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  viewer: dedupe(VIEWER),
  agent: dedupe(AGENT),
  manager: dedupe(MANAGER),
  admin: dedupe(ADMIN),
  security_admin: dedupe(SECURITY_ADMIN),
  super_admin: dedupe(SUPER_ADMIN),
};

function dedupe(list: readonly Permission[]): readonly Permission[] {
  return Object.freeze([...new Set(list)].sort());
}

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function roleHas(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Parses a role from the database, refusing anything unrecognised. */
export function parseRole(raw: unknown): Role | null {
  const parsed = Role.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
