import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env.js";

/**
 * Links that stand in for a login.
 *
 * Two of them, both capability URLs: a requester's view of their own tickets,
 * and an unsubscribe link. Neither can be a session, because both go to people
 * who cannot sign in — a requester locked out of their account, or a member of
 * staff reading mail on a phone who wants the assignment notices to stop. And
 * neither may be guessable, because possession of the URL is the whole of the
 * authorization.
 *
 * They live in core rather than in the web app because the worker mints them
 * too: a notification with no link in it is a notification that asks somebody
 * to go and find the ticket themselves.
 *
 * `PORTAL_SECRET` signs both, with the purpose written into the signed string.
 * Domain separation is the point: without it, a token issued for one purpose is
 * a token for the other, and the unsubscribe link in an email would be a
 * password-equivalent for that person's ticket history.
 */

/** Truncated to 27 base64url characters — 162 bits, plenty, and short enough to paste. */
const MAC_LENGTH = 27;

function sign(purpose: string, payload: string): string {
  return createHmac("sha256", env.PORTAL_SECRET)
    .update(`${purpose}:${payload}`)
    .digest("base64url")
    .slice(0, MAC_LENGTH);
}

function macMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The requester portal link.
 *
 * Unguessable, scoped to one person, and revocable in bulk by rotating
 * `PORTAL_SECRET`. Treat it like a password reset link, not like a login.
 */
export function portalToken(requesterId: string): string {
  return `${requesterId}.${sign("portal", requesterId)}`;
}

export function verifyPortalToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const requesterId = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  return macMatches(provided, sign("portal", requesterId)) ? requesterId : null;
}

export interface UnsubscribeClaim {
  businessId: string;
  email: string;
  /** The notification kind, or `all`. */
  kind: string;
}

/**
 * The unsubscribe link carried by every notification.
 *
 * The tenant is inside the signed payload rather than in the request, which is
 * the same rule intake and the bounce webhook follow: a recipient must not be
 * able to opt somebody out of a tenant they were never written to, by editing a
 * URL. It also means the route that handles the click needs no session — which
 * is the point, since the person clicking it usually does not have one.
 *
 * The address is base64url so that a `+` tag or a unicode local part survives
 * being in a path segment.
 */
export function unsubscribeToken(claim: UnsubscribeClaim): string {
  const payload = [
    Buffer.from(claim.email.trim().toLowerCase(), "utf8").toString("base64url"),
    claim.kind,
    claim.businessId,
  ].join(".");
  return `${payload}.${sign("unsubscribe", payload)}`;
}

export function verifyUnsubscribeToken(token: string): UnsubscribeClaim | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [encoded, kind, businessId, provided] = parts as [string, string, string, string];

  const payload = `${encoded}.${kind}.${businessId}`;
  if (!macMatches(provided, sign("unsubscribe", payload))) return null;

  const email = Buffer.from(encoded, "base64url").toString("utf8");
  if (!email.includes("@")) return null;
  return { businessId, email, kind };
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

function base(): string {
  return env.APP_BASE_URL.replace(/\/+$/, "");
}

/** Where a member of staff reads the ticket. Requires a console session. */
export function ticketUrl(ticketId: string): string {
  return `${base()}/tickets/${ticketId}`;
}

/** Where the requester reads their own tickets. Requires only the link. */
export function portalUrl(requesterId: string): string {
  return `${base()}/portal/${portalToken(requesterId)}`;
}

export function unsubscribeUrl(claim: UnsubscribeClaim): string {
  return `${base()}/unsubscribe/${unsubscribeToken(claim)}`;
}

export function approvalsUrl(): string {
  return `${base()}/approvals`;
}
