import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { query, queryOne } from "../db.js";
import {
  NotFoundError,
  actorString,
  humanContext,
  requirePermission,
  type TenantContext,
} from "../auth/context.js";
import { parseRole, permissionsFor, type Role } from "../auth/permissions.js";
import { audit } from "./audit.js";
import { isUuid } from "./tickets.js";
import { grantableRoles } from "./users.js";

/**
 * Inbound API credentials.
 *
 * The same three properties as a session, for the same reasons. Only the hash
 * is stored, so a database dump is not a set of working keys. Revocation is a
 * column, not a request that the holder deletes their copy. And the tenant
 * comes out of the credential rather than from the request — which is the whole
 * reason this table exists instead of one deployment-wide API secret: a shared
 * secret cannot name a tenant, and "the caller tells us which business" is the
 * bug this codebase spent a phase removing from the intake webhook.
 *
 * A key's authority is a role, resolved through the same `ROLE_PERMISSIONS`
 * table the console uses. That is deliberate: a key is never more capable than
 * a person with that role, every permission check in the data layer applies to
 * it unchanged, and there is no second, quieter authorization model to keep in
 * sync with the first.
 */

/**
 * `hd_` then 32 random bytes, base64url.
 *
 * The prefix is for humans and for secret scanners — a string starting `hd_`
 * in a git diff is recognisably a credential, which is the difference between a
 * leaked key being noticed and being pushed.
 */
const TOKEN_PREFIX = "hd_";
const PREFIX_SHOWN = 11;

export interface ApiKeySummary {
  id: string;
  business_id: string;
  name: string;
  token_prefix: string;
  role: Role;
  created_by: string;
  last_used_at: Date | null;
  request_count: number;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}

export function generateApiToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/**
 * Mint a key.
 *
 * Needs `security:update`, the same permission as an integration secret: both
 * are credentials whose blast radius is not this tenant's own tickets. The role
 * is checked against `grantableRoles`, so an admin cannot mint a key that
 * outranks the admin — without that, key creation would be a privilege
 * escalation with an audit row saying it was fine.
 *
 * The token is returned exactly once and never stored. There is no "show key
 * again" because there is nothing to show.
 */
export async function createApiKey(
  ctx: TenantContext,
  input: { name: string; role?: Role; expiresAt?: Date | null },
): Promise<{ token: string; key: ApiKeySummary }> {
  requirePermission(ctx, "security:update");

  const role = input.role ?? "viewer";
  if (!grantableRoles(ctx).includes(role)) {
    throw new Error(
      `You cannot create a key with the ${role} role, because you could not grant that role to a person either.`,
    );
  }
  const name = input.name.trim();
  if (name.length < 2) throw new Error("a key needs a name you will recognise later");

  const token = generateApiToken();
  const key = await queryOne<ApiKeySummary>(
    `insert into api_keys
       (business_id, name, token_hash, token_prefix, role, created_by, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id, business_id, name, token_prefix, role, created_by,
               last_used_at, request_count, expires_at, revoked_at, created_at`,
    [
      ctx.businessId,
      name,
      hashToken(token),
      token.slice(0, PREFIX_SHOWN),
      role,
      actorString(ctx),
      input.expiresAt ?? null,
    ],
  );

  await audit(ctx, {
    action: "api_key.create",
    resource_type: "api_key",
    resource_id: key!.id,
    new_value: { name, role, expires_at: input.expiresAt ?? null },
    reason: "API key issued",
  });

  return { token, key: key! };
}

export async function listApiKeys(ctx: TenantContext): Promise<ApiKeySummary[]> {
  // `security:read` rather than `config:read`: the list tells you which
  // integrations can reach this tenant and with what authority.
  requirePermission(ctx, "security:read");
  return query<ApiKeySummary>(
    `select id, business_id, name, token_prefix, role, created_by,
            last_used_at, request_count, expires_at, revoked_at, created_at
       from api_keys
      where business_id = $1
      order by revoked_at nulls first, created_at desc`,
    [ctx.businessId],
  );
}

/**
 * Revoke a key.
 *
 * Kept as a row with a timestamp rather than deleted: "when did this key stop
 * working, and who stopped it" is a question somebody asks during an incident,
 * and a deleted row answers it with silence.
 */
export async function revokeApiKey(
  ctx: TenantContext,
  id: string,
  reason: string,
): Promise<ApiKeySummary> {
  requirePermission(ctx, "security:update");
  // A malformed id is a 404, not a Postgres cast error echoed to the console.
  if (!isUuid(id)) throw new NotFoundError("api_key");
  const row = await queryOne<ApiKeySummary>(
    `update api_keys
        set revoked_at = now()
      where id = $1 and business_id = $2 and revoked_at is null
      returning id, business_id, name, token_prefix, role, created_by,
                last_used_at, request_count, expires_at, revoked_at, created_at`,
    [id, ctx.businessId],
  );
  if (!row) throw new NotFoundError("api_key");

  await audit(ctx, {
    action: "api_key.revoke",
    resource_type: "api_key",
    resource_id: row.id,
    old_value: { name: row.name, role: row.role },
    new_value: { revoked: true },
    reason,
  });
  return row;
}

export interface ApiCaller {
  ctx: TenantContext;
  key: ApiKeySummary;
}

/**
 * The tenant and the authority behind one request.
 *
 * Returns null for every failure — malformed token, unknown key, revoked,
 * expired, unparseable role — because telling the caller which one it was tells
 * them whether a key exists. The row lookup is by hash, so nothing derived from
 * the request body or the URL influences which tenant comes back.
 *
 * The context it builds is a human one with the key's role. That is not a
 * fiction: an API key acts for whoever holds it, its permissions are exactly
 * that role's, and every audit row it produces names the key in `actor_email`
 * so the trail says "this integration did it" rather than inventing a person.
 */
export async function contextForApiKey(
  token: string | null | undefined,
): Promise<ApiCaller | null> {
  if (!token) return null;
  const trimmed = token.trim();
  // Length-checked before hashing so an obviously wrong value costs nothing.
  if (!trimmed.startsWith(TOKEN_PREFIX) || trimmed.length < 20) return null;

  const row = await queryOne<ApiKeySummary & { token_hash: string }>(
    `select id, business_id, name, token_hash, token_prefix, role, created_by,
            last_used_at, request_count, expires_at, revoked_at, created_at
       from api_keys
      where token_hash = $1 and revoked_at is null`,
    [hashToken(trimmed)],
  );
  if (!row) return null;

  // The hash lookup already matched, so this compares equal values; it is here
  // so the comparison in the authentication path is constant-time by
  // construction rather than by argument about how Postgres indexes work.
  const a = Buffer.from(row.token_hash);
  const b = Buffer.from(hashToken(trimmed));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;

  const role = parseRole(row.role);
  // A role the enum does not recognise grants nothing rather than defaulting to
  // something convenient.
  if (!role) return null;

  const ctx = humanContext({
    businessId: row.business_id,
    actorId: null,
    actorEmail: `api_key:${row.token_prefix}`,
    role,
    permissions: permissionsFor(role),
    requestId: null,
  });

  return { ctx, key: row };
}

export interface ApiRateVerdict {
  allowed: boolean;
  used: number;
  limit: number;
  /** Seconds until the window rolls, for a `Retry-After` header. */
  retryAfter: number;
}

/**
 * Requests per key per minute.
 *
 * A sliding window over the last sixty seconds, counted from the request log.
 * Both choices are for legibility: a caller can reason about "120 a minute",
 * and the rows the limiter counts are the same rows that answer "what has this
 * key been doing" — which is a question about a credential somebody else holds,
 * and nothing else in this schema could answer it. `retryAfter` is the whole
 * window, which is conservative: by then every request it counted has aged out.
 */
export async function checkApiRateLimit(
  caller: ApiCaller,
  perMinute: number,
): Promise<ApiRateVerdict> {
  const row = await queryOne<{ used: number }>(
    `select count(*)::int as used
       from api_requests
      where api_key_id = $1 and created_at > now() - interval '1 minute'`,
    [caller.key.id],
  );
  const used = Number(row?.used ?? 0);
  return {
    allowed: used < perMinute,
    used,
    limit: perMinute,
    retryAfter: 60,
  };
}

/**
 * Record one request.
 *
 * Written after the response is decided, including the failures: a 403 from an
 * API key is more interesting than a 200, and a log that only contains
 * successes cannot show somebody probing.
 */
export async function recordApiRequest(input: {
  businessId: string;
  apiKeyId: string | null;
  method: string;
  path: string;
  status: number;
  latencyMs: number | null;
  ip: string | null;
}): Promise<void> {
  await query(
    `insert into api_requests
       (business_id, api_key_id, method, path, status, latency_ms, ip)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.businessId,
      input.apiKeyId,
      input.method,
      input.path.slice(0, 500),
      input.status,
      input.latencyMs,
      input.ip,
    ],
  );
  if (input.apiKeyId) {
    await query(
      `update api_keys
          set last_used_at = now(), request_count = request_count + 1
        where id = $1`,
      [input.apiKeyId],
    );
  }
}

/** Recent API traffic for one tenant, for the console. */
export async function recentApiRequests(
  ctx: TenantContext,
  limit = 50,
): Promise<
  {
    id: number;
    method: string;
    path: string;
    status: number;
    latency_ms: number | null;
    key_name: string | null;
    created_at: Date;
  }[]
> {
  requirePermission(ctx, "security:read");
  return query(
    `select r.id, r.method, r.path, r.status, r.latency_ms,
            k.name as key_name, r.created_at
       from api_requests r
       left join api_keys k on k.id = r.api_key_id
      where r.business_id = $1
      order by r.created_at desc
      limit $2`,
    [ctx.businessId, limit],
  );
}
