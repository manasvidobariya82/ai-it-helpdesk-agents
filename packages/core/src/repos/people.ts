import { query, queryOne } from "../db.js";
import { requirePermission, type TenantContext } from "../auth/context.js";
import type { Asset, Requester, Staff } from "../types.js";

/**
 * Identity resolution. The ops agent calls these "leads" and the helpdesk
 * calls them "requesters"; same shape, same lookup, different label.
 */
export async function upsertRequester(input: {
  business_id: string;
  email: string;
  full_name?: string | null;
}): Promise<Requester> {
  const email = input.email.trim().toLowerCase();
  const row = await queryOne<Requester>(
    `insert into requesters (business_id, email, full_name)
     values ($1, $2, $3)
     on conflict (business_id, email) do update
       set full_name = coalesce(requesters.full_name, excluded.full_name)
     returning *`,
    [input.business_id, email, input.full_name ?? null],
  );
  return row!;
}

/**
 * A requester in the caller's tenant.
 *
 * Requesters are people, and the directory is exactly the kind of table a
 * cross-tenant read is worth something for, so the tenant is in the predicate
 * and a foreign id comes back null.
 */
export async function getRequester(
  ctx: TenantContext,
  id: string,
): Promise<Requester | null> {
  requirePermission(ctx, "ticket:read");
  return queryOne<Requester>(
    `select * from requesters where id = $1 and business_id = $2`,
    [id, ctx.businessId],
  );
}

/** The intake path, which resolves its own tenant before a context exists. */
export async function getRequesterUnscoped(id: string): Promise<Requester | null> {
  return queryOne<Requester>(`select * from requesters where id = $1`, [id]);
}

export async function findRequesterByEmail(
  businessId: string,
  email: string,
): Promise<Requester | null> {
  return queryOne<Requester>(
    `select * from requesters where business_id = $1 and email = $2`,
    [businessId, email.trim().toLowerCase()],
  );
}

/**
 * Devices belonging to one requester.
 *
 * `assets` has no `business_id` column; it inherits the tenant from its
 * requester, so the scope is a join rather than a predicate on the table.
 */
export async function assetsForRequester(
  ctx: TenantContext,
  requesterId: string,
): Promise<Asset[]> {
  requirePermission(ctx, "ticket:read");
  return query<Asset>(
    `select a.*
       from assets a
       join requesters r on r.id = a.requester_id
      where a.requester_id = $1 and r.business_id = $2
      order by a.last_seen_at desc nulls last`,
    [requesterId, ctx.businessId],
  );
}

export async function primaryAsset(
  ctx: TenantContext,
  requesterId: string,
): Promise<Asset | null> {
  const rows = await assetsForRequester(ctx, requesterId);
  return rows.find((a) => a.kind === "laptop") ?? rows[0] ?? null;
}

// --- staff ------------------------------------------------------------------

export async function listStaff(ctx: TenantContext): Promise<Staff[]> {
  requirePermission(ctx, "ticket:read");
  return query<Staff>(
    `select * from staff where business_id = $1 and active order by full_name`,
    [ctx.businessId],
  );
}

export async function upsertStaff(input: {
  business_id: string;
  email: string;
  full_name: string;
  queue?: string;
}): Promise<Staff> {
  const row = await queryOne<Staff>(
    `insert into staff (business_id, email, full_name, queue)
     values ($1, $2, $3, $4)
     on conflict (business_id, email) do update
       set full_name = excluded.full_name, queue = excluded.queue, active = true
     returning *`,
    [input.business_id, input.email.trim().toLowerCase(), input.full_name, input.queue ?? "tier1"],
  );
  return row!;
}
