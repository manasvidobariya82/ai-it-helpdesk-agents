import { query, queryOne } from "../db.js";
import {
  can,
  NotFoundError,
  requirePermission,
  AuthorizationError,
  type TenantContext,
} from "../auth/context.js";
import { ROLE_PERMISSIONS, parseRole, type Role } from "../auth/permissions.js";
import { hashPassword } from "../auth/password.js";
import { audit } from "./audit.js";
import { isUuid } from "./tickets.js";

/**
 * User and membership administration, scoped to one tenant.
 *
 * The rule that shapes this file: a membership row is the only thing that
 * grants access to a business, so every function here scopes its writes by
 * `ctx.businessId` in SQL rather than checking it in TypeScript first. An admin
 * of tenant A who hand-crafts a request naming a user in tenant B updates zero
 * rows, because the `where` clause never matched — not because a guard clause
 * remembered to fire.
 */

export interface TenantUser {
  user_id: string;
  email: string;
  full_name: string;
  role: Role;
  active: boolean;
  is_super_admin: boolean;
  last_login_at: Date | null;
  created_at: Date;
}

/**
 * Everyone with a membership in the caller's tenant.
 *
 * Gated on `config:read` rather than a new permission: knowing who can act in
 * the tenant is configuration. An agent working tickets does not get the roster.
 */
export async function listTenantUsers(ctx: TenantContext): Promise<TenantUser[]> {
  requirePermission(ctx, "config:read");
  const rows = await query<Omit<TenantUser, "role"> & { role: string }>(
    `select u.id as user_id, u.email, u.full_name, m.role, u.active,
            u.is_super_admin, u.last_login_at, m.created_at
       from memberships m
       join users u on u.id = m.user_id
      where m.business_id = $1
      order by u.full_name`,
    [ctx.businessId],
  );
  return rows.flatMap((r) => {
    const role = parseRole(r.role);
    return role ? [{ ...r, role }] : [];
  });
}

/**
 * One member of the caller's tenant.
 *
 * Joined through `memberships` with the tenant in the predicate, so a user id
 * from another tenant is a 404 and not a leak of "that address exists".
 */
export async function getTenantUser(
  ctx: TenantContext,
  userId: string,
): Promise<TenantUser | null> {
  requirePermission(ctx, "config:read");
  if (!isUuid(userId)) return null;
  const row = await queryOne<Omit<TenantUser, "role"> & { role: string }>(
    `select u.id as user_id, u.email, u.full_name, m.role, u.active,
            u.is_super_admin, u.last_login_at, m.created_at
       from memberships m
       join users u on u.id = m.user_id
      where m.business_id = $1 and u.id = $2`,
    [ctx.businessId, userId],
  );
  if (!row) return null;
  const role = parseRole(row.role);
  return role ? { ...row, role } : null;
}

/**
 * Roles the caller is allowed to hand out.
 *
 * Nobody may grant a role carrying permissions they do not themselves hold.
 * Without this an `admin` could mint a `security_admin` and then sign in as
 * them, which makes the split between `config:update` and `security:update`
 * decorative.
 */
export function grantableRoles(ctx: TenantContext): Role[] {
  const all: Role[] = ["viewer", "agent", "manager", "admin", "security_admin", "super_admin"];
  if (!can(ctx, "config:update")) return [];
  // `super_admin` is platform administration and is never granted from a
  // tenant screen; it is a column on `users`, set out of band.
  return all.filter(
    (r) => r !== "super_admin" && roleWithinReach(ctx, r),
  );
}

/**
 * Read straight off the grant table, so there is no second copy of the policy
 * here to drift from `permissionsFor`.
 */
function roleWithinReach(ctx: TenantContext, role: Role): boolean {
  return ROLE_PERMISSIONS[role].every((p) => ctx.permissions.includes(p));
}

export class RoleGrantDenied extends Error {
  readonly status = 403;
  constructor(readonly role: Role) {
    super(
      `Granting ${role} requires holding every permission it carries. ` +
        "You cannot grant access you do not have.",
    );
    this.name = "RoleGrantDenied";
  }
}

/**
 * The other half of `roleWithinReach`: nobody changes or removes a member who
 * holds access the actor does not.
 *
 * The grant check alone looked only at the role being handed out, so an
 * `admin` could not mint a `security_admin` but could demote one to `viewer`,
 * or remove them — taking the security team out of the tenant with an
 * operation that is supposed to need their permissions to reverse.
 */
function assertMemberWithinReach(ctx: TenantContext, member: TenantUser): void {
  if (!roleWithinReach(ctx, member.role)) {
    throw new AuthorizationError(
      null,
      `You cannot change the access of a ${member.role}, because you could not grant that role either.`,
    );
  }
}

/**
 * Invite somebody into the caller's tenant, creating the user if new.
 *
 * The user row is global and the membership is per tenant, so inviting an
 * address that already belongs to another business adds a membership and does
 * not touch their existing one. Deliberately returns the same shape either way:
 * an inviter must not be able to probe which addresses are already registered.
 */
export async function inviteUser(
  ctx: TenantContext,
  input: { email: string; fullName: string; role: Role; password?: string | null },
): Promise<TenantUser> {
  requirePermission(ctx, "config:update");
  if (!roleWithinReach(ctx, input.role)) throw new RoleGrantDenied(input.role);

  const email = input.email.trim().toLowerCase();
  const passwordHash = input.password ? await hashPassword(input.password) : null;

  const user = await queryOne<{ id: string }>(
    `insert into users (email, full_name, password_hash)
     values ($1, $2, $3)
     on conflict (email) do update set full_name = coalesce(users.full_name, excluded.full_name)
     returning id`,
    [email, input.fullName.trim(), passwordHash],
  );

  // Already a member here: that is a role change, and it goes through
  // `setRole` with all of its guards. The insert below used to overwrite the
  // role on conflict, which made "invite" a way round every one of them — an
  // admin could re-invite a security_admin as a viewer, or themselves as one
  // and leave the tenant with no administrator.
  const existing = await getTenantUser(ctx, user!.id);
  if (existing) {
    if (existing.role !== input.role) await setRole(ctx, user!.id, input.role);
    return (await getTenantUser(ctx, user!.id)) ?? existing;
  }

  await query(
    `insert into memberships (user_id, business_id, role)
     values ($1, $2, $3)
     on conflict (user_id, business_id) do nothing`,
    [user!.id, ctx.businessId, input.role],
  );

  await audit(ctx, {
    action: "user.invite",
    resource_type: "user",
    resource_id: user!.id,
    new_value: { email, role: input.role },
  });

  const created = await getTenantUser(ctx, user!.id);
  if (!created) throw new NotFoundError("user");
  return created;
}

/**
 * Change somebody's role inside the caller's tenant.
 *
 * Two guards beyond the permission. The new role must be within the caller's
 * own reach, and the update is scoped by `business_id`, so this cannot reach a
 * membership in another tenant even with a valid user id from one.
 */
export async function setRole(
  ctx: TenantContext,
  userId: string,
  role: Role,
): Promise<void> {
  requirePermission(ctx, "config:update");
  if (!roleWithinReach(ctx, role)) throw new RoleGrantDenied(role);

  const before = await getTenantUser(ctx, userId);
  if (!before) throw new NotFoundError("user");
  assertMemberWithinReach(ctx, before);

  // Nobody edits their own role. Upward it is self-escalation; downward it is
  // how a tenant loses its last administrator by accident. Someone else with
  // the permission does it, and the audit row names two different people.
  if (userId === ctx.actorId) {
    throw new AuthorizationError(null, "You cannot change your own role");
  }
  if (before.role !== role && (await wouldRemoveLastAdmin(ctx, userId, role))) {
    throw new AuthorizationError(
      null,
      "This tenant would be left with no administrator",
    );
  }

  await query(
    `update memberships set role = $3 where user_id = $1 and business_id = $2`,
    [userId, ctx.businessId, role],
  );

  await audit(ctx, {
    action: "user.role_change",
    resource_type: "user",
    resource_id: userId,
    old_value: { role: before.role },
    new_value: { role },
  });
}

async function wouldRemoveLastAdmin(
  ctx: TenantContext,
  userId: string,
  nextRole: Role,
): Promise<boolean> {
  if (nextRole === "admin" || nextRole === "security_admin") return false;
  const row = await queryOne<{ n: number }>(
    `select count(*)::int as n
       from memberships
      where business_id = $1 and role in ('admin','security_admin') and user_id <> $2`,
    [ctx.businessId, userId],
  );
  return Number(row?.n ?? 0) === 0;
}

/**
 * Remove somebody's access to the caller's tenant.
 *
 * Deletes the membership rather than the user: they may work in another
 * business, and an audit row naming a deleted user is a row nobody can read.
 * Sessions pointing at this tenant are revoked in the same breath, because
 * access that survives until the cookie expires is not revoked.
 */
export async function removeMember(ctx: TenantContext, userId: string): Promise<void> {
  requirePermission(ctx, "config:update");
  const before = await getTenantUser(ctx, userId);
  if (!before) throw new NotFoundError("user");
  assertMemberWithinReach(ctx, before);
  if (userId === ctx.actorId) {
    throw new AuthorizationError(null, "You cannot remove your own access");
  }
  if (await wouldRemoveLastAdmin(ctx, userId, "viewer")) {
    throw new AuthorizationError(null, "This tenant would be left with no administrator");
  }

  await query(`delete from memberships where user_id = $1 and business_id = $2`, [
    userId,
    ctx.businessId,
  ]);
  await query(
    `update sessions set revoked_at = now()
      where user_id = $1 and business_id = $2 and revoked_at is null`,
    [userId, ctx.businessId],
  );

  await audit(ctx, {
    action: "user.deactivate",
    resource_type: "user",
    resource_id: userId,
    old_value: { role: before.role },
    new_value: { removed: true },
  });
}

/**
 * Create the first user of a deployment, from the seed or the CLI.
 *
 * Takes no context and writes no audit row, so it is named to be obvious in a
 * diff and must never be reachable from a request path.
 */
export async function createUserUnaudited(input: {
  email: string;
  fullName: string;
  password: string;
  isSuperAdmin?: boolean;
}): Promise<string> {
  const hash = await hashPassword(input.password);
  const row = await queryOne<{ id: string }>(
    `insert into users (email, full_name, password_hash, is_super_admin)
     values ($1,$2,$3,$4)
     on conflict (email) do update
       set full_name = excluded.full_name,
           password_hash = excluded.password_hash,
           is_super_admin = users.is_super_admin or excluded.is_super_admin
     returning id`,
    [input.email.trim().toLowerCase(), input.fullName, hash, input.isSuperAdmin ?? false],
  );
  return row!.id;
}

/** Same escape hatch for memberships. Seed and CLI only. */
export async function addMembershipUnaudited(
  userId: string,
  businessId: string,
  role: Role,
): Promise<void> {
  await query(
    `insert into memberships (user_id, business_id, role)
     values ($1,$2,$3)
     on conflict (user_id, business_id) do update set role = excluded.role`,
    [userId, businessId, role],
  );
}
