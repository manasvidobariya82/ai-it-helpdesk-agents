import type pg from "pg";
import { query, queryOne, tx } from "../db.js";
import {
  can,
  NotFoundError,
  requirePermission,
  AuthorizationError,
  type TenantContext,
} from "../auth/context.js";
import {
  classifyField,
  describeImpact,
  directionOf,
  requiresDualControl,
  type FieldChange,
} from "../config-policy.js";
import { parseSettings, type BusinessSettings } from "../settings.js";
import { audit } from "./audit.js";

/**
 * Configuration versions.
 *
 * `audit_events` answers "who changed the VPN threshold and when". It cannot
 * answer "which threshold was in force when ticket #1842 was decided", because
 * that needs the whole configuration as it stood at a moment, not a list of the
 * edits around it. This does.
 *
 * Every accepted change produces a numbered, immutable snapshot. Tickets are
 * stamped with the version that decided them, so a replay six weeks later uses
 * the configuration that actually applied rather than today's.
 */

export interface ConfigVersion {
  id: string;
  business_id: string;
  version: number;
  settings: BusinessSettings;
  status: "current" | "superseded";
  source: "update" | "rollback" | "seed";
  restored_from: number | null;
  created_by: string | null;
  actor_email: string | null;
  actor_role: string | null;
  reason: string | null;
  summary: FieldChange[];
  request_id: string | null;
  created_at: Date;
}

interface ConfigVersionRow extends Omit<ConfigVersion, "settings" | "summary"> {
  settings: unknown;
  summary: unknown;
}

function hydrate(row: ConfigVersionRow): ConfigVersion {
  return {
    ...row,
    settings: parseSettings(row.settings),
    summary: Array.isArray(row.summary) ? (row.summary as FieldChange[]) : [],
  };
}

const VERSION_COLUMNS = `id, business_id, version, settings, status, source,
  restored_from, created_by, actor_email, actor_role, reason, summary,
  request_id, created_at`;

// --- reading ----------------------------------------------------------------

export async function currentConfigVersion(
  ctx: TenantContext,
): Promise<ConfigVersion | null> {
  requirePermission(ctx, "config:read");
  const row = await queryOne<ConfigVersionRow>(
    `select ${VERSION_COLUMNS} from config_versions
      where business_id = $1 and status = 'current'`,
    [ctx.businessId],
  );
  return row ? hydrate(row) : null;
}

/**
 * The current version number, by tenant id.
 *
 * Context-free like `getSettings`, and for the same reason: the pipeline runs
 * under `agentContext`, which holds no `config:read` — it has no business
 * reading configuration, it just has to stamp which configuration decided the
 * ticket. Returns a number and nothing else, so it discloses nothing a ticket
 * row would not.
 */
export async function currentConfigVersionNumber(
  businessId: string,
): Promise<number | null> {
  const row = await queryOne<{ version: number }>(
    `select version from config_versions
      where business_id = $1 and status = 'current'`,
    [businessId],
  );
  return row ? Number(row.version) : null;
}

export async function listConfigVersions(
  ctx: TenantContext,
  limit = 50,
  offset = 0,
): Promise<ConfigVersion[]> {
  requirePermission(ctx, "config:read");
  const rows = await query<ConfigVersionRow>(
    `select ${VERSION_COLUMNS} from config_versions
      where business_id = $1
      order by version desc
      limit $2 offset $3`,
    [ctx.businessId, limit, offset],
  );
  return rows.map(hydrate);
}

export async function getConfigVersion(
  ctx: TenantContext,
  version: number,
): Promise<ConfigVersion | null> {
  requirePermission(ctx, "config:read");
  const row = await queryOne<ConfigVersionRow>(
    `select ${VERSION_COLUMNS} from config_versions
      where business_id = $1 and version = $2`,
    [ctx.businessId, version],
  );
  return row ? hydrate(row) : null;
}

/**
 * The configuration in force at a moment.
 *
 * The fallback for "before any version existed" is the earliest version rather
 * than null, because a ticket decided before versioning was introduced was
 * decided under *something*, and the first recorded snapshot is the closest
 * honest answer available. The caller can tell the difference: the returned
 * version's `created_at` is later than the timestamp asked about.
 */
export async function configVersionAt(
  ctx: TenantContext,
  when: Date,
): Promise<ConfigVersion | null> {
  requirePermission(ctx, "config:read");
  const row = await queryOne<ConfigVersionRow>(
    `select ${VERSION_COLUMNS} from config_versions
      where business_id = $1 and created_at <= $2
      order by version desc
      limit 1`,
    [ctx.businessId, when],
  );
  if (row) return hydrate(row);

  const earliest = await queryOne<ConfigVersionRow>(
    `select ${VERSION_COLUMNS} from config_versions
      where business_id = $1
      order by version asc
      limit 1`,
    [ctx.businessId],
  );
  return earliest ? hydrate(earliest) : null;
}

/** Every change to one field, newest first. The investigation query. */
export async function fieldHistory(
  ctx: TenantContext,
  field: string,
  limit = 50,
): Promise<
  {
    config_version: number | null;
    old_value: unknown;
    new_value: unknown;
    reason: string | null;
    actor_email: string | null;
    actor_role: string | null;
    created_at: Date;
  }[]
> {
  requirePermission(ctx, "audit:read");
  return query(
    `select config_version, old_value, new_value, reason,
            actor_email, actor_role, created_at
       from audit_events
      where business_id = $1 and field = $2
      order by created_at desc, id desc
      limit $3`,
    [ctx.businessId, field, limit],
  );
}

// --- previewing -------------------------------------------------------------

export interface ChangePreview {
  changes: FieldChange[];
  /** One sentence per change, for the confirmation screen. */
  impact: { field: string; text: string }[];
  /** True when any change widens autonomy on a critical field. */
  needsAcknowledgement: boolean;
  /** True when the tenant additionally requires a second administrator. */
  needsSecondApprover: boolean;
  /** Critical changes the caller is not permitted to make at all. */
  deniedFields: string[];
}

/** The flat diff between two settings objects. `a.b.c` keys, leaves only. */
export function diffSettings(
  before: BusinessSettings,
  after: BusinessSettings,
): FieldChange[] {
  const beforeFlat = flatten(before);
  const afterFlat = flatten(after);
  const fields = [...new Set([...beforeFlat.keys(), ...afterFlat.keys()])].sort();

  const changes: FieldChange[] = [];
  for (const field of fields) {
    const oldValue = beforeFlat.get(field);
    const newValue = afterFlat.get(field);
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;

    // A category with no explicit policy was not unconfigured — it was running
    // under `default_policy`. Comparing a newly added policy against `undefined`
    // reports "lateral" and waves through exactly the change this gate exists
    // for: adding `vpn: { autonomy: "reply", threshold: 0.82 }` to a tenant
    // whose default is `off` at 0.95 is the widest change on the page.
    const effectiveOld =
      oldValue ?? fallbackFor(field, beforeFlat) ?? oldValue;
    const effectiveNew =
      newValue ?? fallbackFor(field, afterFlat) ?? newValue;

    changes.push({
      field,
      old_value: oldValue ?? null,
      new_value: newValue ?? null,
      risk: classifyField(field),
      direction: directionOf(field, effectiveOld, effectiveNew),
    });
  }
  return changes;
}

/**
 * What a category policy leaf falls back to when it is absent.
 *
 * Only `category_policies.<category>.<leaf>` has a fallback, and it is the
 * matching leaf of `default_policy`. Everything else genuinely has no prior
 * value, and inventing one would be worse than reporting `lateral`.
 */
function fallbackFor(field: string, flat: Map<string, unknown>): unknown {
  const m = field.match(/^category_policies\.[^.]+\.(.+)$/);
  return m ? flat.get(`default_policy.${m[1]}`) : undefined;
}

/**
 * Arrays are compared whole rather than per index.
 *
 * `auto_action_whitelist.0` changing from one tool name to another is not a
 * fact anybody wants in an audit log; "the whitelist gained
 * `identity.reset_password`" is.
 */
function flatten(value: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) out.set(prefix, value);
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const field = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      for (const [ck, cv] of flatten(v, field)) out.set(ck, cv);
    } else {
      out.set(field, v);
    }
  }
  return out;
}

/**
 * What would happen, without doing it.
 *
 * The console calls this to render the confirmation screen. It takes no locks
 * and writes nothing, so it is safe to call on every keystroke if anybody wants
 * to.
 */
export async function previewSettingsChange(
  ctx: TenantContext,
  next: BusinessSettings,
): Promise<ChangePreview> {
  requirePermission(ctx, "config:read");
  const before = await readSettingsRaw(ctx.businessId);
  const changes = diffSettings(before, next);

  const critical = changes.filter((c) => c.risk === "critical");
  const widening = changes.filter(requiresDualControl);

  return {
    changes,
    impact: changes.map((c) => ({ field: c.field, text: describeImpact(c) })),
    needsAcknowledgement: widening.length > 0,
    needsSecondApprover:
      widening.length > 0 && before.require_dual_control_for_widening,
    deniedFields: can(ctx, "security:update") ? [] : critical.map((c) => c.field),
  };
}

async function readSettingsRaw(businessId: string): Promise<BusinessSettings> {
  const row = await queryOne<{ settings: unknown }>(
    `select settings from businesses where id = $1`,
    [businessId],
  );
  return parseSettings(row?.settings);
}

// --- writing ----------------------------------------------------------------

export class ConfigChangeDenied extends Error {
  readonly status = 403;
  constructor(
    readonly fields: readonly string[],
    message?: string,
  ) {
    super(
      message ??
        `Changing ${fields.join(", ")} requires security:update. ` +
          "These settings govern how autonomous the agent is.",
    );
    this.name = "ConfigChangeDenied";
  }
}

/** Thrown when a widening change was submitted without an explicit acknowledgement. */
export class ConfirmationRequired extends Error {
  readonly status = 428;
  constructor(
    readonly impact: { field: string; text: string }[],
    readonly changes: FieldChange[],
  ) {
    super(
      "This change widens what the agent may do without a person. " +
        "Re-submit with acknowledgeWidening once the impact has been read.",
    );
    this.name = "ConfirmationRequired";
  }
}

/** Thrown when the tenant requires a second administrator. Carries the proposal. */
export class SecondApproverRequired extends Error {
  readonly status = 202;
  constructor(readonly requestId: string) {
    super("Submitted for approval by a second administrator.");
    this.name = "SecondApproverRequired";
  }
}

export interface UpdateSettingsOptions {
  reason?: string | null;
  /** Set once the caller has been shown, and accepted, the impact summary. */
  acknowledgeWidening?: boolean;
}

export interface UpdateSettingsResult {
  changes: FieldChange[];
  settings: BusinessSettings;
  version: number | null;
  /** Set when the change is parked awaiting a second administrator. */
  pendingRequestId?: string;
}

/**
 * Apply a settings change, producing a new immutable version.
 *
 * The gates, in the order they fire:
 *
 *   1. `config:update` to change anything at all.
 *   2. `security:update` for any critical field. Refusal is itself audited —
 *      an attempt to widen autonomy is worth more in the log than a successful
 *      ordinary edit.
 *   3. A written reason for any critical field.
 *   4. An explicit acknowledgement for anything that *widens* autonomy, so a
 *      confirmation step exists on the server and not only in the dialog.
 *   5. A second administrator, when the tenant asks for one.
 *
 * Then the write: a new `config_versions` row, the old one superseded, the
 * denormalized `businesses.settings` updated, and one `audit_events` row per
 * changed field — all in one transaction, so there is no state where the
 * settings moved and the history did not.
 */
export async function updateSettings(
  ctx: TenantContext,
  next: BusinessSettings,
  opts: UpdateSettingsOptions = {},
): Promise<UpdateSettingsResult> {
  requirePermission(ctx, "config:update");

  const before = await readSettingsRaw(ctx.businessId);
  const changes = diffSettings(before, next);
  if (changes.length === 0) {
    return { changes: [], settings: before, version: null };
  }

  const critical = changes.filter((c) => c.risk === "critical");

  if (critical.length > 0 && !can(ctx, "security:update")) {
    await audit(ctx, {
      action: "authz.denied",
      resource_type: "business_settings",
      resource_id: ctx.businessId,
      new_value: { attempted_fields: critical.map((c) => c.field) },
      reason: "security:update required",
    });
    throw new ConfigChangeDenied(critical.map((c) => c.field));
  }

  const reason = opts.reason?.trim() ?? "";
  if (critical.length > 0 && !reason) {
    throw new Error(
      `A reason is required when changing ${critical.map((c) => c.field).join(", ")}.`,
    );
  }

  const widening = changes.filter(requiresDualControl);
  if (widening.length > 0 && !opts.acknowledgeWidening) {
    throw new ConfirmationRequired(
      widening.map((c) => ({ field: c.field, text: describeImpact(c) })),
      widening,
    );
  }

  if (widening.length > 0 && before.require_dual_control_for_widening) {
    const request = await proposeChange(ctx, next, changes, reason);
    throw new SecondApproverRequired(request);
  }

  const version = await commitVersion(ctx, {
    settings: next,
    changes,
    reason: reason || null,
    source: "update",
    restoredFrom: null,
  });

  return { changes, settings: next, version };
}

/**
 * The transaction every accepted change goes through.
 *
 * The lock on `businesses` is what makes version numbers safe: two
 * administrators saving at the same moment would otherwise both read v16 and
 * both try to write v17, and one of them would lose their change silently
 * rather than loudly.
 */
async function commitVersion(
  ctx: TenantContext,
  input: {
    settings: BusinessSettings;
    changes: FieldChange[];
    reason: string | null;
    source: "update" | "rollback";
    restoredFrom: number | null;
  },
): Promise<number> {
  return tx(async (client) => {
    const locked = await client.query<{ id: string }>(
      `select id from businesses where id = $1 for update`,
      [ctx.businessId],
    );
    if (locked.rowCount === 0) throw new NotFoundError("business");

    const last = await client.query<{ version: number }>(
      `select coalesce(max(version), 0) as version
         from config_versions where business_id = $1`,
      [ctx.businessId],
    );
    const version = Number(last.rows[0]?.version ?? 0) + 1;

    await client.query(
      `update config_versions set status = 'superseded'
        where business_id = $1 and status = 'current'`,
      [ctx.businessId],
    );

    await client.query(
      `insert into config_versions
         (business_id, version, settings, status, source, restored_from,
          created_by, actor_email, actor_role, reason, summary, request_id)
       values ($1,$2,$3::jsonb,'current',$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
      [
        ctx.businessId,
        version,
        JSON.stringify(input.settings),
        input.source,
        input.restoredFrom,
        ctx.actorId,
        ctx.actorEmail,
        ctx.role,
        input.reason,
        JSON.stringify(input.changes),
        ctx.requestId,
      ],
    );

    await client.query(`update businesses set settings = $2::jsonb where id = $1`, [
      ctx.businessId,
      JSON.stringify(input.settings),
    ]);

    for (const change of input.changes) {
      await auditInTx(client, ctx, change, {
        version,
        reason: input.reason,
        source: input.source,
      });
    }

    return version;
  });
}

/**
 * The audit row for one field, written on the transaction's own connection.
 *
 * Deliberately not the shared `audit()` helper: that one uses the pool, and a
 * settings write that committed while its audit rows rolled back is precisely
 * the state this feature exists to make impossible.
 */
async function auditInTx(
  client: pg.PoolClient,
  ctx: TenantContext,
  change: FieldChange,
  meta: { version: number; reason: string | null; source: string },
): Promise<void> {
  await client.query(
    `insert into audit_events
       (business_id, actor_id, actor_type, actor_email, actor_role, action,
        resource_type, resource_id, field, old_value, new_value, reason,
        request_id, session_id, ip, user_agent, metadata, config_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,
             $17::jsonb,$18)`,
    [
      ctx.businessId,
      ctx.actorId,
      ctx.actorType,
      ctx.actorEmail,
      ctx.role,
      change.risk === "critical" ? "config.autonomy_change" : "config.update",
      "business_settings",
      change.field,
      change.field,
      JSON.stringify(change.old_value ?? null),
      JSON.stringify(change.new_value ?? null),
      meta.reason,
      ctx.requestId,
      ctx.sessionId,
      ctx.ip,
      ctx.userAgent,
      JSON.stringify({
        risk: change.risk,
        direction: change.direction,
        impact: describeImpact(change),
        source: meta.source,
      }),
      meta.version,
    ],
  );
}

// --- rollback ---------------------------------------------------------------

/**
 * Restore the settings from an earlier version.
 *
 * A rollback is a new version, never a deletion. v17 set the threshold to 0.82;
 * rolling back produces v18 holding 0.90, and v17 stays in the history saying
 * what it said. "Undo" that removes the record of the mistake removes the only
 * evidence that it happened.
 *
 * It goes through the same gates as any other change, because it is one: a
 * rollback *to* a more permissive configuration widens autonomy exactly as much
 * as setting those values by hand would.
 */
export async function rollbackConfig(
  ctx: TenantContext,
  toVersion: number,
  opts: { reason: string; acknowledgeWidening?: boolean },
): Promise<UpdateSettingsResult> {
  requirePermission(ctx, "config:update");
  if (!opts.reason?.trim()) {
    throw new Error("A rollback requires a reason.");
  }

  const target = await getConfigVersion(ctx, toVersion);
  if (!target) throw new NotFoundError("config_version");

  const before = await readSettingsRaw(ctx.businessId);
  const changes = diffSettings(before, target.settings);
  if (changes.length === 0) {
    return { changes: [], settings: before, version: null };
  }

  const critical = changes.filter((c) => c.risk === "critical");
  if (critical.length > 0 && !can(ctx, "security:update")) {
    await audit(ctx, {
      action: "authz.denied",
      resource_type: "config_version",
      resource_id: String(toVersion),
      new_value: { attempted_fields: critical.map((c) => c.field) },
      reason: "security:update required for rollback",
    });
    throw new ConfigChangeDenied(critical.map((c) => c.field));
  }

  const widening = changes.filter(requiresDualControl);
  if (widening.length > 0 && !opts.acknowledgeWidening) {
    throw new ConfirmationRequired(
      widening.map((c) => ({ field: c.field, text: describeImpact(c) })),
      widening,
    );
  }
  if (widening.length > 0 && before.require_dual_control_for_widening) {
    const request = await proposeChange(
      ctx,
      target.settings,
      changes,
      `Rollback to v${toVersion}: ${opts.reason}`,
    );
    throw new SecondApproverRequired(request);
  }

  const version = await commitVersion(ctx, {
    settings: target.settings,
    changes,
    reason: `Rollback to v${toVersion}: ${opts.reason}`,
    source: "rollback",
    restoredFrom: toVersion,
  });

  return { changes, settings: target.settings, version };
}

// --- dual control -----------------------------------------------------------

export interface ConfigChangeRequest {
  id: string;
  business_id: string;
  proposed_settings: BusinessSettings;
  summary: FieldChange[];
  reason: string;
  base_version: number;
  status: "pending" | "applied" | "rejected" | "expired" | "stale";
  requested_by: string | null;
  requested_by_email: string | null;
  created_at: Date;
  expires_at: Date;
  decided_by: string | null;
  decided_by_email: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  applied_version: number | null;
}

const PROPOSAL_TTL_HOURS = 72;

async function proposeChange(
  ctx: TenantContext,
  settings: BusinessSettings,
  changes: FieldChange[],
  reason: string,
): Promise<string> {
  const current = await queryOne<{ version: number }>(
    `select coalesce(max(version), 0) as version
       from config_versions where business_id = $1`,
    [ctx.businessId],
  );

  const row = await queryOne<{ id: string }>(
    `insert into config_change_requests
       (business_id, proposed_settings, summary, reason, base_version,
        requested_by, requested_by_email, expires_at)
     values ($1,$2::jsonb,$3::jsonb,$4,$5,$6,$7, now() + ($8 || ' hours')::interval)
     returning id`,
    [
      ctx.businessId,
      JSON.stringify(settings),
      JSON.stringify(changes),
      reason,
      Number(current?.version ?? 0),
      ctx.actorId,
      ctx.actorEmail,
      String(PROPOSAL_TTL_HOURS),
    ],
  );

  await audit(ctx, {
    action: "config.change_proposed",
    resource_type: "config_change_request",
    resource_id: row!.id,
    new_value: { fields: changes.map((c) => c.field) },
    reason,
    metadata: { needs: "a second administrator", widening: true },
  });

  return row!.id;
}

export async function pendingConfigRequests(
  ctx: TenantContext,
): Promise<ConfigChangeRequest[]> {
  requirePermission(ctx, "config:read");
  const rows = await query<
    Omit<ConfigChangeRequest, "proposed_settings" | "summary"> & {
      proposed_settings: unknown;
      summary: unknown;
    }
  >(
    `select * from config_change_requests
      where business_id = $1 and status = 'pending' and expires_at > now()
      order by created_at asc`,
    [ctx.businessId],
  );
  return rows.map((r) => ({
    ...r,
    proposed_settings: parseSettings(r.proposed_settings),
    summary: Array.isArray(r.summary) ? (r.summary as FieldChange[]) : [],
  }));
}

/**
 * The second administrator's decision.
 *
 * Three things are checked beyond the permission, and each one is a way this
 * could otherwise be theatre:
 *
 *   - The approver is not the proposer. Otherwise one person with two clicks
 *     satisfies a control designed to need two people.
 *   - The proposal has not expired. A month-old proposal approved by somebody
 *     who has forgotten the context is a rubber stamp.
 *   - The configuration has not moved since. The approver agreed to a specific
 *     diff; if the base has changed, applying the proposed settings would
 *     silently revert whatever happened in between.
 */
export async function decideConfigRequest(
  ctx: TenantContext,
  requestId: string,
  decision: "approved" | "rejected",
  opts: { reason?: string | null } = {},
): Promise<UpdateSettingsResult | null> {
  requirePermission(ctx, "config:update");
  requirePermission(ctx, "security:update");

  const row = await queryOne<
    Omit<ConfigChangeRequest, "proposed_settings" | "summary"> & {
      proposed_settings: unknown;
      summary: unknown;
    }
  >(
    `select * from config_change_requests
      where id = $1 and business_id = $2 and status = 'pending'`,
    [requestId, ctx.businessId],
  );
  if (!row) return null;

  if (row.requested_by && row.requested_by === ctx.actorId) {
    await audit(ctx, {
      action: "authz.denied",
      resource_type: "config_change_request",
      resource_id: requestId,
      reason: "an administrator cannot approve their own configuration change",
    });
    throw new AuthorizationError(
      null,
      "A change that needs a second administrator cannot be approved by the person who proposed it.",
    );
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await query(
      `update config_change_requests set status = 'expired' where id = $1`,
      [requestId],
    );
    throw new Error("This proposal has expired. Propose the change again.");
  }

  if (decision === "rejected") {
    await query(
      `update config_change_requests
          set status = 'rejected', decided_by = $2, decided_by_email = $3,
              decided_at = now(), decision_reason = $4
        where id = $1`,
      [requestId, ctx.actorId, ctx.actorEmail, opts.reason ?? null],
    );
    await audit(ctx, {
      action: "config.change_rejected",
      resource_type: "config_change_request",
      resource_id: requestId,
      old_value: { status: "pending" },
      new_value: { status: "rejected" },
      reason: opts.reason ?? null,
    });
    return null;
  }

  const currentVersion = await queryOne<{ version: number }>(
    `select coalesce(max(version), 0) as version
       from config_versions where business_id = $1`,
    [ctx.businessId],
  );
  if (Number(currentVersion?.version ?? 0) !== row.base_version) {
    await query(`update config_change_requests set status = 'stale' where id = $1`, [
      requestId,
    ]);
    throw new Error(
      `The configuration has changed since this was proposed (v${row.base_version} → ` +
        `v${currentVersion?.version}). Propose the change again against the current version.`,
    );
  }

  const settings = parseSettings(row.proposed_settings);
  const before = await readSettingsRaw(ctx.businessId);
  const changes = diffSettings(before, settings);

  const version = await commitVersion(ctx, {
    settings,
    changes,
    reason: `${row.reason} (proposed by ${row.requested_by_email ?? "unknown"}, approved by ${ctx.actorEmail ?? "unknown"})`,
    source: "update",
    restoredFrom: null,
  });

  await query(
    `update config_change_requests
        set status = 'applied', decided_by = $2, decided_by_email = $3,
            decided_at = now(), decision_reason = $4, applied_version = $5
      where id = $1`,
    [requestId, ctx.actorId, ctx.actorEmail, opts.reason ?? null, version],
  );

  await audit(ctx, {
    action: "config.change_approved",
    resource_type: "config_change_request",
    resource_id: requestId,
    old_value: { status: "pending" },
    new_value: { status: "applied", version },
    reason: opts.reason ?? null,
    metadata: {
      proposed_by: row.requested_by_email,
      approved_by: ctx.actorEmail,
    },
  });

  return { changes, settings, version };
}

/**
 * Mark proposals past their expiry.
 *
 * Called by the worker's sweep. Expiry is also checked at decision time, so a
 * sweep that has not run cannot let a stale proposal through — this exists to
 * keep the queue honest, not to enforce the rule.
 */
export async function expireConfigRequests(): Promise<number> {
  const rows = await query<{ id: string }>(
    `update config_change_requests
        set status = 'expired'
      where status = 'pending' and expires_at <= now()
      returning id`,
  );
  return rows.length;
}
