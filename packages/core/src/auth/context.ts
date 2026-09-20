import { permissionsFor, type Permission, type Role } from "./permissions.js";

/**
 * The tenant context.
 *
 * This is the only legitimate source of a `business_id` below the HTTP layer.
 * Repositories take one and read the tenant from it; nothing takes a
 * `business_id` from a caller who could have taken it from a query string.
 *
 * It is a branded type so that "I have a business id" and "I am authorised to
 * act in this business" cannot be the same thing by accident. The brand is not
 * security on its own — it is a compiler-level reminder that the value has to
 * come from `contextFromSession` or from one of the two internal constructors
 * below, all of which are auditable in one grep.
 */
declare const TenantBrand: unique symbol;

export type ActorType = "human" | "agent" | "system";

export interface TenantContext {
  readonly [TenantBrand]: true;
  readonly businessId: string;
  readonly actorId: string | null;
  readonly actorType: ActorType;
  readonly actorEmail: string | null;
  readonly role: Role | null;
  readonly permissions: readonly Permission[];
  readonly sessionId: string | null;
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** True when the actor reached this tenant through platform administration. */
  readonly viaSuperAdmin: boolean;
}

export class AuthorizationError extends Error {
  readonly status = 403;
  constructor(
    readonly permission: Permission | null,
    message: string,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class AuthenticationError extends Error {
  readonly status = 401;
  constructor(message = "Not signed in") {
    super(message);
    this.name = "AuthenticationError";
  }
}

/**
 * Raised instead of a 403 when revealing existence would itself leak.
 *
 * A cross-tenant read of a ticket id must not distinguish "exists, forbidden"
 * from "does not exist" — that difference is an enumeration oracle. Within a
 * tenant, a missing permission is a plain 403, because the resource's existence
 * is not the secret.
 */
export class NotFoundError extends Error {
  readonly status = 404;
  constructor(
    readonly resourceType: string,
    message = "Not found",
  ) {
    super(message);
    this.name = "NotFoundError";
  }
}

export interface BuildContextInput {
  businessId: string;
  actorId?: string | null;
  actorType: ActorType;
  actorEmail?: string | null;
  role: Role | null;
  permissions?: readonly Permission[];
  sessionId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  viaSuperAdmin?: boolean;
}

/**
 * The brand is a compile-time marker only.
 *
 * `TenantBrand` is `declare const`, so it exists in the type system and not at
 * runtime — writing it as a real key here throws `TenantBrand is not defined`
 * the first time a context is built. The object is assembled without it and
 * cast once, which is the only cast in this file and the reason it is here
 * rather than scattered across the constructors.
 */
function build(input: BuildContextInput): TenantContext {
  if (!input.businessId) {
    throw new AuthorizationError(null, "Tenant context requires a business id");
  }
  return Object.freeze({
    businessId: input.businessId,
    actorId: input.actorId ?? null,
    actorType: input.actorType,
    actorEmail: input.actorEmail ?? null,
    role: input.role,
    permissions: Object.freeze([
      ...(input.permissions ?? (input.role ? permissionsFor(input.role) : [])),
    ]),
    sessionId: input.sessionId ?? null,
    requestId: input.requestId ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    viaSuperAdmin: input.viaSuperAdmin ?? false,
  }) as unknown as TenantContext;
}

/** Built from a resolved session. The only human-facing constructor. */
export function humanContext(input: Omit<BuildContextInput, "actorType">): TenantContext {
  return build({ ...input, actorType: "human" });
}

/**
 * The worker and the pipeline, acting on a ticket that already belongs to a
 * tenant. Deliberately not given every permission: the agent may work tickets
 * and execute whitelisted actions, and may not change configuration. That
 * closes the loop the roadmap names — the agent cannot make itself more
 * autonomous — at the type level rather than by convention.
 */
export function agentContext(
  businessId: string,
  opts: { requestId?: string | null } = {},
): TenantContext {
  return build({
    businessId,
    actorType: "agent",
    actorId: null,
    actorEmail: null,
    role: null,
    permissions: AGENT_PERMISSIONS,
    requestId: opts.requestId ?? null,
  });
}

const AGENT_PERMISSIONS: readonly Permission[] = Object.freeze([
  "ticket:read",
  // The agent reads the desk's notes: a copilot that cannot see them would
  // summarise half a ticket.
  "ticket_internal:read",
  "ticket:create",
  "ticket:update",
  "ticket:close",
  "kb:read",
  "kb:create",
  "agent:read",
  "action:execute",
]);

/**
 * A requester holding a signed portal link, acting on their own tickets.
 *
 * Narrower than every other constructor on purpose: two permissions, and the
 * portal additionally filters every query to that one requester id. The link
 * is a capability, not a login, so the context it produces has to be the
 * smallest thing that still renders the page.
 */
export function portalContext(businessId: string): TenantContext {
  return build({
    businessId,
    actorType: "system",
    actorId: null,
    actorEmail: null,
    role: null,
    permissions: PORTAL_PERMISSIONS,
  });
}

const PORTAL_PERMISSIONS: readonly Permission[] = Object.freeze([
  "ticket:read",
  "ticket:create",
]);

/**
 * Migrations, seeds, the intake webhook before a ticket exists, and CLI jobs.
 *
 * Full permissions inside one tenant and no identity, so anything it writes is
 * audited as `system`. Used from a request path it would be a privilege
 * escalation, which is why every call site is one grep away.
 */
export function systemContext(
  businessId: string,
  opts: { requestId?: string | null } = {},
): TenantContext {
  return build({
    businessId,
    actorType: "system",
    actorId: null,
    actorEmail: null,
    role: "super_admin",
    requestId: opts.requestId ?? null,
  });
}

export function can(ctx: TenantContext, permission: Permission): boolean {
  return ctx.permissions.includes(permission);
}

export function canAll(
  ctx: TenantContext,
  permissions: readonly Permission[],
): boolean {
  return permissions.every((p) => can(ctx, p));
}

/** Throws rather than returning false, so a forgotten check is not a pass. */
export function requirePermission(
  ctx: TenantContext,
  permission: Permission,
): void {
  if (!can(ctx, permission)) {
    throw new AuthorizationError(
      permission,
      `${describeActor(ctx)} lacks ${permission}`,
    );
  }
}

/**
 * Assert that a row the caller already loaded belongs to this tenant.
 *
 * For the cases where a query cannot be scoped by `business_id` directly — a
 * join through another table, say. It throws `NotFoundError`, not a 403: the
 * caller must not be able to tell a foreign id from a missing one.
 */
export function assertSameTenant(
  ctx: TenantContext,
  row: { business_id: string } | null | undefined,
  resourceType: string,
): void {
  if (!row || row.business_id !== ctx.businessId) {
    throw new NotFoundError(resourceType);
  }
}

export function describeActor(ctx: TenantContext): string {
  if (ctx.actorType !== "human") return ctx.actorType;
  return ctx.actorEmail ?? ctx.actorId ?? "unknown user";
}

/**
 * The actor string written to `ticket_events.actor`.
 *
 * Keeps the existing `human:<id>` shape the event log already documents, but
 * with a real user id in it instead of the constant `console`.
 */
export function actorString(ctx: TenantContext): string {
  switch (ctx.actorType) {
    case "human":
      return `human:${ctx.actorId ?? "unknown"}`;
    case "agent":
      return "agent";
    default:
      return "system";
  }
}
