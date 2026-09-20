"use server";

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  audit,
  auditAnonymous,
  contextFromSession,
  signIn,
  switchTenant,
} from "@hd/core";
import {
  clearSessionCookie,
  currentUserOnly,
  setSessionCookie,
} from "../../lib/auth";
import { safeNext } from "../../lib/safe-next";

/**
 * Sign-in, sign-out and tenant selection.
 *
 * Three things here are deliberate. Failures are indistinguishable from each
 * other, successes and failures are both audited, and the tenant is written to
 * the session row on the server rather than returned to the browser to send
 * back later.
 */

async function meta() {
  const h = await headers();
  return {
    requestId: h.get("x-request-id") ?? randomUUID(),
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null,
    userAgent: h.get("user-agent"),
  };
}

export async function signInAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNext(String(formData.get("next") ?? "/"));
  const m = await meta();

  const result = await signIn({
    email,
    password,
    ip: m.ip,
    userAgent: m.userAgent,
  });

  if (!result) {
    // A failed sign-in is worth more in the log than a successful one: it is
    // the only record that somebody tried. The address is recorded; the
    // password never is, not even its length.
    await auditAnonymous({
      action: "auth.sign_in_failed",
      actor_email: email || null,
      resource_type: "session",
      reason: "invalid credentials",
      request_id: m.requestId,
      ip: m.ip,
      user_agent: m.userAgent,
    });
    // Deliberately vague, and identical for an unknown address, a wrong
    // password and a deactivated account.
    redirect(`/login?error=1${next ? `&next=${encodeURIComponent(next)}` : ""}`);
  }

  await setSessionCookie(result.token, result.expiresAt);
  await auditAnonymous({
    action: "auth.sign_in",
    business_id: result.memberships[0]?.business_id ?? null,
    actor_id: result.user.id,
    actor_email: result.user.email,
    resource_type: "session",
    resource_id: result.sessionId,
    request_id: m.requestId,
    session_id: result.sessionId,
    ip: m.ip,
    user_agent: m.userAgent,
  });

  // A user with more than one tenant picks before they see any data, so no
  // page ever renders under a tenant nobody chose.
  redirect(result.memberships.length === 1 ? next : "/select-tenant");
}

export async function signOutAction(): Promise<void> {
  const session = await currentUserOnly();
  const m = await meta();
  if (session) {
    await auditAnonymous({
      action: "auth.sign_out",
      business_id: session.businessId,
      actor_id: session.user.id,
      actor_email: session.user.email,
      resource_type: "session",
      resource_id: session.sessionId,
      request_id: m.requestId,
      session_id: session.sessionId,
      ip: m.ip,
      user_agent: m.userAgent,
    });
  }
  await clearSessionCookie();
  redirect("/login");
}

/**
 * Point the session at a different tenant.
 *
 * The business id arrives from a form, which is exactly why `switchTenant`
 * re-checks membership on the server before writing it. A person who edits the
 * form value to a business they are not in gets sent back to the picker, and
 * the attempt is audited under the tenant they were already in.
 */
export async function selectTenantAction(formData: FormData): Promise<void> {
  const businessId = String(formData.get("business_id") ?? "");
  const session = await currentUserOnly();
  if (!session) redirect("/login");

  const m = await meta();
  const ok = await switchTenant(session.sessionId, session.user.id, businessId);
  if (!ok) {
    await auditAnonymous({
      action: "authz.denied",
      business_id: session.businessId,
      actor_id: session.user.id,
      actor_email: session.user.email,
      resource_type: "business",
      resource_id: businessId,
      reason: "not a member of the requested tenant",
      request_id: m.requestId,
      session_id: session.sessionId,
      ip: m.ip,
      user_agent: m.userAgent,
    });
    redirect("/select-tenant?error=1");
  }

  // Re-resolved rather than reusing the pre-switch session, so the audit row
  // names the tenant the actor ended up in and carries the role they hold
  // there.
  const after = await currentUserOnly();
  const ctx = after ? contextFromSession(after, m) : null;
  if (ctx) {
    await audit(ctx, {
      action: "auth.tenant_switch",
      resource_type: "business",
      resource_id: businessId,
      old_value: { business_id: session.businessId },
      new_value: { business_id: businessId },
    });
  }

  redirect("/");
}
