/**
 * Requester portal links.
 *
 * The signing moved into `@hd/core` when notifications arrived: the worker
 * mints portal links too, and a requester's "your ticket was resolved" email
 * has to be able to point at their own status page. This file stays as the
 * import path the portal pages already use.
 *
 * The console is staff-only; the portal is the requester's own view of their
 * own tickets. There is no login, because asking someone locked out of their
 * account to log in to find out why is the oldest joke in IT support. The link
 * carries an HMAC of the requester id: unguessable, scoped to one person, and
 * revocable in bulk by rotating PORTAL_SECRET. It is a capability URL — treat
 * it like a password reset link, not like authentication.
 */
export { portalToken, verifyPortalToken } from "@hd/core";
