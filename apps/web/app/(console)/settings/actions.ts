"use server";

import { revalidatePath } from "next/cache";
import {
  AutonomyLevel,
  BusinessSettings,
  ConfigChangeDenied,
  ConfirmationRequired,
  SecondApproverRequired,
  decideConfigRequest,
  deleteCredential,
  getSettings,
  createApiKey,
  inviteUser,
  optIn,
  previewSettingsChange,
  revokeApiKey,
  Role as RoleEnum,
  putCredential,
  removeMember,
  rollbackConfig,
  Role,
  setRole,
  updateSettings,
} from "@hd/core";
import { requireConsole } from "../../../lib/auth";

/**
 * Which form is being submitted.
 *
 * One action per form rather than one generic "save settings", because the
 * impact step has to describe the change somebody is actually making. A single
 * form over thirty fields produces a confirmation dialog nobody reads.
 */
export type ConfigFormKind = "category" | "mode" | "general" | "notifications";

/**
 * Configuration changes.
 *
 * The governance gap this closes: a threshold moving from 0.90 to 0.82 is a
 * decision about how much of the helpdesk runs unattended, and it used to leave
 * no trace. Every change here now produces an immutable numbered version and
 * one audit row per changed field, with both values and a reason.
 *
 * These actions return a result rather than throwing. A server action that
 * throws gives the client an error boundary and a discarded form; the
 * confirmation step needs the impact summary to come *back* so a person can
 * read it and decide, which means it has to be a value.
 */

export type ConfigResult =
  | { status: "noop" }
  | { status: "applied"; version: number; fields: string[] }
  | {
      status: "confirm";
      impact: { field: string; text: string }[];
      /** Echoed back so the confirming submit carries the same intent. */
      reason: string;
    }
  | { status: "proposed"; requestId: string }
  | { status: "denied"; message: string }
  | { status: "error"; message: string };

function failure(err: unknown): ConfigResult {
  if (err instanceof ConfirmationRequired) {
    return { status: "confirm", impact: err.impact, reason: "" };
  }
  if (err instanceof SecondApproverRequired) {
    return { status: "proposed", requestId: err.requestId };
  }
  if (err instanceof ConfigChangeDenied) {
    return { status: "denied", message: err.message };
  }
  return {
    status: "error",
    message: err instanceof Error ? err.message : String(err),
  };
}

function num(formData: FormData, key: string, fallback: number): number {
  const raw = formData.get(key);
  if (raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** The settings object a form is proposing, built from the current one. */
async function proposedFrom(
  businessId: string,
  formData: FormData,
  kind: ConfigFormKind,
): Promise<BusinessSettings> {
  const current = await getSettings(businessId);

  if (kind === "category") {
    const category = String(formData.get("category") ?? "").trim();
    if (!category) throw new Error("category is required");
    return BusinessSettings.parse({
      ...current,
      category_policies: {
        ...current.category_policies,
        [category]: {
          autonomy: AutonomyLevel.parse(formData.get("autonomy")),
          confidence_threshold: num(
            formData,
            "confidence_threshold",
            current.default_policy.confidence_threshold,
          ),
        },
      },
    });
  }

  if (kind === "mode") {
    const raw = String(formData.get("agent_mode_override") ?? "");
    const override = raw === "" ? null : (raw as "shadow" | "assist" | "auto");
    return BusinessSettings.parse({
      ...current,
      agent_mode_override: override,
      agent_mode_override_reason: override
        ? String(formData.get("reason") ?? "").trim() || null
        : null,
    });
  }

  if (kind === "notifications") {
    return BusinessSettings.parse({
      ...current,
      notifications: {
        ...current.notifications,
        // Checkboxes are absent from the form data when unchecked, which is
        // exactly the semantics wanted here: absent means off.
        enabled: formData.get("notify_enabled") === "on",
        assignment: formData.get("notify_assignment") === "on",
        sla_warning: formData.get("notify_sla_warning") === "on",
        escalation: formData.get("notify_escalation") === "on",
        approval: formData.get("notify_approval") === "on",
        resolution: formData.get("notify_resolution") === "on",
        sla_warning_at_percent: num(
          formData,
          "sla_warning_at_percent",
          current.notifications.sla_warning_at_percent,
        ),
        ops_address:
          String(formData.get("ops_address") ?? "").trim() || null,
      },
    });
  }

  return BusinessSettings.parse({
    ...current,
    signature: String(formData.get("signature") ?? current.signature),
    followup_hours: num(formData, "followup_hours", current.followup_hours),
    max_clarify_rounds: num(formData, "max_clarify_rounds", current.max_clarify_rounds),
    max_agent_runs_per_requester_hour: num(
      formData,
      "max_agent_runs_per_requester_hour",
      current.max_agent_runs_per_requester_hour,
    ),
    max_agent_runs_per_tenant_hour: num(
      formData,
      "max_agent_runs_per_tenant_hour",
      current.max_agent_runs_per_tenant_hour,
    ),
    scrub_secrets_at_rest: formData.get("scrub_secrets_at_rest") === "on",
    require_dual_control_for_widening:
      formData.get("require_dual_control_for_widening") === "on",
  });
}

/**
 * What would happen, without doing it.
 *
 * Called before the confirmation dialog opens, so the impact shown is computed
 * by the same code that will enforce the gate a moment later rather than by the
 * form's own idea of what it is changing.
 */
export async function previewChange(
  kind: ConfigFormKind,
  formData: FormData,
): Promise<
  | { status: "ok"; impact: { field: string; text: string }[]; needsConfirm: boolean; needsSecond: boolean }
  | { status: "error"; message: string }
> {
  try {
    const { ctx } = await requireConsole();
    const next = await proposedFrom(ctx.businessId, formData, kind);
    const preview = await previewSettingsChange(ctx, next);
    return {
      status: "ok",
      impact: preview.impact,
      needsConfirm: preview.needsAcknowledgement,
      needsSecond: preview.needsSecondApprover,
    };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function apply(
  kind: ConfigFormKind,
  formData: FormData,
): Promise<ConfigResult> {
  try {
    const { ctx } = await requireConsole();
    const next = await proposedFrom(ctx.businessId, formData, kind);
    const result = await updateSettings(ctx, next, {
      reason: String(formData.get("reason") ?? ""),
      acknowledgeWidening: formData.get("acknowledge") === "on",
    });

    revalidatePath("/settings");
    revalidatePath("/");
    if (result.version === null) return { status: "noop" };
    return {
      status: "applied",
      version: result.version,
      fields: result.changes.map((c) => c.field),
    };
  } catch (err) {
    const out = failure(err);
    if (out.status === "confirm") {
      out.reason = String(formData.get("reason") ?? "");
    }
    if (out.status === "proposed") revalidatePath("/settings");
    return out;
  }
}

export async function updateCategoryPolicy(formData: FormData): Promise<ConfigResult> {
  return apply("category", formData);
}

/**
 * Notification policy.
 *
 * Goes through the same gate as everything else, and two of its fields are
 * classified critical: the master switch and the approval notice. Turning
 * either off means the agent operates with less human visibility, which is the
 * definition of a widening change — so it needs `security:update`, a reason and
 * a confirmation, while switching off assignment email does not.
 */
export async function updateNotifications(formData: FormData): Promise<ConfigResult> {
  return apply("notifications", formData);
}

/**
 * Issue an API key.
 *
 * Returns the token, once. Nothing stores it — only its hash goes in the table
 * — so there is no "show it again", and saying so in the result is kinder than
 * a page that pretends the key can be recovered.
 *
 * `createApiKey` requires `security:update` and refuses a role the creator
 * could not grant to a person, so this action adds no checks of its own.
 */
export async function issueApiKey(
  formData: FormData,
): Promise<ConfigResult & { token?: string }> {
  try {
    const { ctx } = await requireConsole();
    const name = String(formData.get("name") ?? "").trim();
    const role = RoleEnum.parse(String(formData.get("role") ?? "viewer"));
    const days = num(formData, "expires_days", 0);

    const { token, key } = await createApiKey(ctx, {
      name,
      role,
      expiresAt: days > 0 ? new Date(Date.now() + days * 86_400_000) : null,
    });
    revalidatePath("/settings");
    return { status: "applied", version: 0, fields: [key.token_prefix], token };
  } catch (err) {
    return failure(err);
  }
}

/** Stop a key working. Kept as a revoked row, not deleted. */
export async function revokeKey(id: string, reason: string): Promise<ConfigResult> {
  try {
    const { ctx } = await requireConsole();
    const why = reason.trim();
    if (why.length < 4) {
      return { status: "error", message: "Say why this key is being revoked." };
    }
    const key = await revokeApiKey(ctx, id, why);
    revalidatePath("/settings");
    return { status: "applied", version: 0, fields: [key.name] };
  } catch (err) {
    return failure(err);
  }
}

/**
 * Put an address back on the list.
 *
 * Separate from the settings forms because it is not configuration: an opt-out
 * is a person's own choice, and undoing it is a decision about somebody else's
 * inbox. Audited with a compulsory reason.
 */
export async function resubscribe(
  email: string,
  kind: string,
  reason: string,
): Promise<ConfigResult> {
  try {
    const { ctx } = await requireConsole();
    const why = reason.trim();
    if (why.length < 4) {
      return {
        status: "error",
        message: "Say why this address should receive notifications again.",
      };
    }
    const lifted = await optIn(
      ctx,
      email,
      kind as Parameters<typeof optIn>[2],
      why,
    );
    revalidatePath("/settings");
    return lifted
      ? { status: "applied", version: 0, fields: [`optout:${email}:${kind}`] }
      : { status: "noop" };
  } catch (err) {
    return failure(err);
  }
}

export async function updateModeOverride(formData: FormData): Promise<ConfigResult> {
  return apply("mode", formData);
}

export async function updateGeneral(formData: FormData): Promise<ConfigResult> {
  return apply("general", formData);
}

/**
 * Restore an earlier version.
 *
 * The rollback is itself a new version, so the history reads v17 → 0.82, v18 →
 * rollback to 0.90. Undo that erases the record of the mistake erases the only
 * evidence it happened.
 */
export async function rollbackToVersion(formData: FormData): Promise<ConfigResult> {
  try {
    const { ctx } = await requireConsole();
    const version = Number(formData.get("version"));
    const result = await rollbackConfig(ctx, version, {
      reason: String(formData.get("reason") ?? ""),
      acknowledgeWidening: formData.get("acknowledge") === "on",
    });
    revalidatePath("/settings");
    revalidatePath("/audit");
    revalidatePath("/");
    if (result.version === null) return { status: "noop" };
    return {
      status: "applied",
      version: result.version,
      fields: result.changes.map((c) => c.field),
    };
  } catch (err) {
    return failure(err);
  }
}

/** The second administrator's decision on a widening change. */
export async function decideProposal(formData: FormData): Promise<ConfigResult> {
  try {
    const { ctx } = await requireConsole();
    const result = await decideConfigRequest(
      ctx,
      String(formData.get("request_id")),
      formData.get("decision") === "approve" ? "approved" : "rejected",
      { reason: String(formData.get("decision_reason") ?? "") || null },
    );
    revalidatePath("/settings");
    revalidatePath("/audit");
    revalidatePath("/");
    if (!result || result.version === null) return { status: "noop" };
    return {
      status: "applied",
      version: result.version,
      fields: result.changes.map((c) => c.field),
    };
  } catch (err) {
    return failure(err);
  }
}

// --- people -----------------------------------------------------------------

export async function inviteUserAction(formData: FormData): Promise<void> {
  const { ctx } = await requireConsole();
  await inviteUser(ctx, {
    email: String(formData.get("email") ?? ""),
    fullName: String(formData.get("full_name") ?? ""),
    role: Role.parse(formData.get("role")),
    password: String(formData.get("password") ?? "") || null,
  });
  revalidatePath("/settings");
}

export async function setRoleAction(formData: FormData): Promise<void> {
  const { ctx } = await requireConsole();
  await setRole(ctx, String(formData.get("user_id")), Role.parse(formData.get("role")));
  revalidatePath("/settings");
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const { ctx } = await requireConsole();
  await removeMember(ctx, String(formData.get("user_id")));
  revalidatePath("/settings");
}

// --- integration credentials ------------------------------------------------

export async function putCredentialAction(formData: FormData): Promise<void> {
  const { ctx } = await requireConsole();
  await putCredential(ctx, {
    provider: String(formData.get("provider") ?? "").trim(),
    label: String(formData.get("label") ?? "").trim(),
    secret: String(formData.get("secret") ?? ""),
  });
  revalidatePath("/settings");
}

export async function deleteCredentialAction(formData: FormData): Promise<void> {
  const { ctx } = await requireConsole();
  await deleteCredential(ctx, String(formData.get("provider") ?? ""));
  revalidatePath("/settings");
}
