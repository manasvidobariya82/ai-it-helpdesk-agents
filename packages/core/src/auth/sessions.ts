import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { query, queryOne } from "../db.js";
import { humanContext, type TenantContext } from "./context.js";
import { parseRole, permissionsFor, type Role } from "./permissions.js";
import { verifyPassword } from "./password.js";

/**
 * Users, memberships and server-side sessions.
 *
 * Sessions are stored so they can be revoked — a signed cookie cannot be
 * un-signed — and only the hash of the token is kept, so a database dump is
 * not a set of working logins.
 */

export interface User {
  id: string;
  email: string;
  full_name: string;
  is_super_admin: boolean;
  active: boolean;
}

export interface Membership {
  business_id: string;
  business_name: string;
  role: Role;
}

const SESSION_TTL_HOURS = 12;

export async function getUserByEmail(email: string): Promise<
  (User & { password_hash: string | null }) | null
> {
  return queryOne<User & { password_hash: string | null }>(
    `select id, email, full_name, password_hash, is_super_admin, active
       from users where lower(email) = lower($1)`,
    [email.trim()],
  );
}

export async function membershipsFor(userId: string): Promise<Membership[]> {
  const rows = await query<{ business_id: string; business_name: string; role: string }>(
    `select m.business_id, b.name as business_name, m.role
       from memberships m
       join businesses b on b.id = m.business_id
      where m.user_id = $1
      order by b.name`,
    [userId],
  );
  // A row whose role is not in the enum is a row nobody can reason about, so
  // it grants nothing rather than defaulting to something convenient.
  return rows.flatMap((r) => {
    const role = parseRole(r.role);
    return role
      ? [{ business_id: r.business_id, business_name: r.business_name, role }]
      : [];
  });
}

export interface SignInResult {
  user: User;
  memberships: Membership[];
  token: string;
  sessionId: string;
  expiresAt: Date;
}

/**
 * Verify a password and open a session.
 *
 * Returns null for every failure — unknown email, wrong password, deactivated
 * account — because telling the caller which one it was is telling them
 * whether the address is registered.
 */
export async function signIn(input: {
  email: string;
  password: string;
  businessId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<SignInResult | null> {
  const user = await getUserByEmail(input.email);
  const ok = await verifyPassword(input.password, user?.password_hash ?? null);
  if (!user || !ok || !user.active) return null;

  const memberships = await membershipsFor(user.id);
  // A super admin with no membership can still sign in; they pick a tenant
  // afterwards and every such selection is audited.
  if (memberships.length === 0 && !user.is_super_admin) return null;

  const businessId =
    input.businessId && (await canAccessBusiness(user, input.businessId, memberships))
      ? input.businessId
      : (memberships[0]?.business_id ?? null);

  const session = await createSession({
    userId: user.id,
    businessId,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  await query(`update users set last_login_at = now() where id = $1`, [user.id]);

  return {
    user: {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      is_super_admin: user.is_super_admin,
      active: user.active,
    },
    memberships,
    ...session,
  };
}

export async function canAccessBusiness(
  user: Pick<User, "id" | "is_super_admin">,
  businessId: string,
  memberships?: readonly Membership[],
): Promise<boolean> {
  if (user.is_super_admin) return true;
  const list = memberships ?? (await membershipsFor(user.id));
  return list.some((m) => m.business_id === businessId);
}

export async function createSession(input: {
  userId: string;
  businessId: string | null;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);

  const row = await queryOne<{ id: string }>(
    `insert into sessions (token_hash, user_id, business_id, ip, user_agent, expires_at)
     values ($1,$2,$3,$4,$5,$6)
     returning id`,
    [
      hashToken(token),
      input.userId,
      input.businessId,
      input.ip,
      input.userAgent,
      expiresAt,
    ],
  );

  return { token, sessionId: row!.id, expiresAt };
}

export async function revokeSession(token: string): Promise<void> {
  await query(
    `update sessions set revoked_at = now()
      where token_hash = $1 and revoked_at is null`,
    [hashToken(token)],
  );
}

export async function revokeAllSessionsFor(userId: string): Promise<void> {
  await query(
    `update sessions set revoked_at = now() where user_id = $1 and revoked_at is null`,
    [userId],
  );
}

export interface ResolvedSession {
  sessionId: string;
  user: User;
  businessId: string | null;
  memberships: Membership[];
  role: Role | null;
  expiresAt: Date;
}

/**
 * Resolve a cookie token to a live session.
 *
 * Returns null for expired, revoked, deactivated or unknown. The role is read
 * from `memberships` on every request rather than copied into the session, so
 * revoking access takes effect on the next click and not in twelve hours.
 */
export async function resolveSession(
  token: string | null | undefined,
): Promise<ResolvedSession | null> {
  if (!token) return null;

  const row = await queryOne<{
    session_id: string;
    business_id: string | null;
    expires_at: Date;
    user_id: string;
    email: string;
    full_name: string;
    is_super_admin: boolean;
    active: boolean;
  }>(
    `select s.id as session_id, s.business_id, s.expires_at,
            u.id as user_id, u.email, u.full_name, u.is_super_admin, u.active
       from sessions s
       join users u on u.id = s.user_id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()`,
    [hashToken(token)],
  );
  if (!row || !row.active) return null;

  const user: User = {
    id: row.user_id,
    email: row.email,
    full_name: row.full_name,
    is_super_admin: row.is_super_admin,
    active: row.active,
  };
  const memberships = await membershipsFor(user.id);
  const role =
    memberships.find((m) => m.business_id === row.business_id)?.role ??
    (user.is_super_admin && row.business_id ? "super_admin" : null);

  return {
    sessionId: row.session_id,
    user,
    businessId: row.business_id,
    memberships,
    role,
    expiresAt: row.expires_at,
  };
}

/**
 * Point an existing session at a different tenant.
 *
 * Refuses a business the user is not a member of, which is the server-side half
 * of "the frontend cannot override tenant identity": the tenant lives in the
 * session row, and the only way to change it goes through this membership
 * check.
 */
export async function switchTenant(
  sessionId: string,
  userId: string,
  businessId: string,
): Promise<boolean> {
  const user = await queryOne<Pick<User, "id" | "is_super_admin">>(
    `select id, is_super_admin from users where id = $1 and active`,
    [userId],
  );
  if (!user) return false;
  if (!(await canAccessBusiness(user, businessId))) return false;

  await query(
    `update sessions set business_id = $2
      where id = $1 and revoked_at is null and expires_at > now()`,
    [sessionId, businessId],
  );
  return true;
}

/**
 * The bridge from a resolved session to a tenant context.
 *
 * Returns null rather than throwing when the session has no tenant selected,
 * so the caller can render a tenant picker instead of a stack trace.
 */
export function contextFromSession(
  session: ResolvedSession,
  meta: {
    requestId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  } = {},
): TenantContext | null {
  if (!session.businessId || !session.role) return null;

  const isMember = session.memberships.some(
    (m) => m.business_id === session.businessId,
  );

  return humanContext({
    businessId: session.businessId,
    actorId: session.user.id,
    actorEmail: session.user.email,
    role: session.role,
    permissions: permissionsFor(session.role),
    sessionId: session.sessionId,
    requestId: meta.requestId ?? null,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
    viaSuperAdmin: !isMember && session.user.is_super_admin,
  });
}

/** Sessions are looked up by hash, so the raw token is never stored. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time compare, for the places a token is checked outside the database. */
export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
