import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  AuthorizationError,
  can,
  contextFromSession,
  listBusinesses,
  resolveSession,
  revokeSession,
  type Business,
  type Membership,
  type Permission,
  type ResolvedSession,
  type TenantContext,
} from "@hd/core";

/**
 * The console's front door.
 *
 * Everything a console page or server action does starts here. There is one
 * rule and it is worth stating plainly: the tenant comes from the session row
 * in the database, never from the request. Before this, the selected business
 * lived in a `hd_business` cookie that the browser could set to any uuid, and
 * every page read it without asking whether the person was allowed to be
 * there. Switching tenants now goes through a membership check on the server
 * and rewrites the session row; there is no request shape that reaches another
 * tenant's data.
 */

export const SESSION_COOKIE = "hd_session";

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  // Secure in production only, so the console still works over http on a
  // developer's machine without anyone being tempted to turn it off in prod.
  secure: process.env.NODE_ENV === "production",
} as const;

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, { ...COOKIE_OPTIONS, expires: expiresAt });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(token);
  jar.delete(SESSION_COOKIE);
}

/** Request metadata, so an audit row can say where a change came from. */
async function requestMeta(): Promise<{
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}> {
  const h = await headers();
  return {
    // Next does not expose a per-request id, so one is minted here. It ties the
    // several audit rows a single form submission writes back together.
    requestId: h.get("x-request-id") ?? randomUUID(),
    ip:
      h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      h.get("x-real-ip") ??
      null,
    userAgent: h.get("user-agent"),
  };
}

export interface ConsoleSession {
  ctx: TenantContext;
  session: ResolvedSession;
  memberships: Membership[];
}

/**
 * The signed-in actor, or null.
 *
 * Returns null for "not signed in" and for "signed in but no tenant selected"
 * alike; the caller decides whether that means the login page or the tenant
 * picker.
 */
export async function currentSession(): Promise<ConsoleSession | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await resolveSession(token);
  if (!session) return null;

  const ctx = contextFromSession(session, await requestMeta());
  if (!ctx) return null;

  return { ctx, session, memberships: session.memberships };
}

/** Signed in, but possibly without a tenant chosen yet. */
export async function currentUserOnly(): Promise<ResolvedSession | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return resolveSession(token);
}

/**
 * The guard every console page and server action calls first.
 *
 * Redirects rather than throwing, because an unauthenticated person should see
 * a login form and not a stack trace. `next` carries them back to the page
 * they asked for once they are in.
 */
export async function requireConsole(next?: string): Promise<ConsoleSession> {
  const signedIn = await currentSession();
  if (signedIn) return signedIn;

  const user = await currentUserOnly();
  if (user) redirect("/select-tenant");
  redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
}

/**
 * The same guard, plus a permission.
 *
 * A missing permission is a 403 page, not a redirect: the person is who they
 * say they are and the answer is still no, and bouncing them to a login form
 * they are already past is the most confusing possible response.
 */
export async function requireConsolePermission(
  permission: Permission,
  next?: string,
): Promise<ConsoleSession> {
  const s = await requireConsole(next);
  if (!can(s.ctx, permission)) {
    throw new AuthorizationError(permission, `You do not have ${permission}`);
  }
  return s;
}

export interface ConsoleTenant {
  ctx: TenantContext;
  business: Business;
  memberships: Membership[];
  user: ResolvedSession["user"];
}

/**
 * The tenant the signed-in user is operating in, with the businesses they may
 * switch to.
 *
 * `listBusinesses()` is deliberately not used to build the switcher: a super
 * admin sees everything, and everybody else sees only what they are a member
 * of. Showing a name in a dropdown is already a small disclosure.
 */
export async function switchableBusinesses(
  s: ConsoleSession,
): Promise<{ id: string; name: string }[]> {
  if (s.session.user.is_super_admin) {
    return (await listBusinesses()).map((b) => ({ id: b.id, name: b.name }));
  }
  return s.memberships.map((m) => ({ id: m.business_id, name: m.business_name }));
}

/** Convenience for JSX: `{show(s.ctx, "config:update") && <button/>}`. */
export function show(ctx: TenantContext, permission: Permission): boolean {
  return can(ctx, permission);
}
