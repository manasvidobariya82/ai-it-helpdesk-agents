import { query, queryOne, tx } from "../db.js";
import {
  requirePermission,
  NotFoundError,
  type TenantContext,
} from "../auth/context.js";
import { parseSettings, type BusinessSettings } from "../settings.js";
import type { Business } from "../types.js";

export async function getBusiness(id: string): Promise<Business | null> {
  return queryOne<Business>(`select * from businesses where id = $1`, [id]);
}

export async function listBusinesses(): Promise<Business[]> {
  return query<Business>(`select * from businesses order by name`);
}

/**
 * The tenant the caller is actually in.
 *
 * `listBusinesses` above stays unscoped because sign-in and the seed need it
 * before a context exists; everything that runs inside a request uses this,
 * and it cannot name a business the context does not.
 */
export async function currentBusiness(ctx: TenantContext): Promise<Business> {
  const row = await queryOne<Business>(`select * from businesses where id = $1`, [
    ctx.businessId,
  ]);
  if (!row) throw new NotFoundError("business");
  return row;
}

export async function getSettings(businessId: string): Promise<BusinessSettings> {
  const row = await queryOne<{ settings: unknown }>(
    `select settings from businesses where id = $1`,
    [businessId],
  );
  return parseSettings(row?.settings);
}

/** Settings for the caller's own tenant. Reading configuration is a permission. */
export async function readSettings(ctx: TenantContext): Promise<BusinessSettings> {
  requirePermission(ctx, "config:read");
  return getSettings(ctx.businessId);
}

/**
 * Classification, diffing and writing all moved out of this file.
 *
 * Which fields are autonomy-governing is a policy question and lives in
 * `config-policy.ts`. Writing a change is a versioning question and lives in
 * `repos/config.ts`, because every accepted change now produces an immutable
 * numbered snapshot rather than an in-place update. Both are exported from the
 * package root, so `import { updateSettings } from "@hd/core"` is unchanged.
 *
 * What is left here is the plain reads, which is all this file should ever
 * have held.
 */

/**
 * The escape hatch for migrations, seeds and the CLI.
 *
 * Takes no context and writes no audit row, so it is named to be obvious in a
 * diff and must never be reachable from a request path.
 */
export async function updateSettingsUnaudited(
  businessId: string,
  settings: BusinessSettings,
): Promise<void> {
  await query(`update businesses set settings = $2 where id = $1`, [
    businessId,
    JSON.stringify(settings),
  ]);
}

/**
 * Delete a tenant and everything belonging to it.
 *
 * `audit_events` and `config_versions` refuse deletes, which is what makes them
 * evidence — and which also made a business undeletable, because the foreign
 * keys cascade into both. Offboarding a customer, answering an erasure request
 * and tearing down a test fixture all hit the same wall.
 *
 * So the guard stays and this is the one thing that lifts it: `hd.purge` is set
 * for exactly this transaction, the cascade runs, and the setting dies with the
 * transaction. An ordinary delete against either table still fails, from this
 * application's connection as much as from anywhere else.
 *
 * Named to be obvious in a diff, takes no context, writes no audit row — there
 * would be nowhere left to write it — and must never be reachable from a
 * request path. Erasing a tenant is an operator action with a paper trail
 * somewhere other than the database it is erasing.
 */
export async function purgeBusinessUnaudited(businessId: string): Promise<void> {
  await tx(async (client) => {
    await client.query(`set local hd.purge = 'on'`);
    await client.query(`delete from businesses where id = $1`, [businessId]);
  });
}
