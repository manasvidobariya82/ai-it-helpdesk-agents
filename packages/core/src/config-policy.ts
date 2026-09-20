/**
 * What a configuration change means.
 *
 * Two questions, kept separate because they have different answers and
 * different consequences.
 *
 * **How risky is this field?** `critical` fields govern what the agent is
 * allowed to do without a person. `normal` fields are everything else. The
 * split decides which permission is needed and whether a reason is compulsory.
 *
 * **Which way does this change move?** A critical field can be moved in either
 * direction, and the directions are not symmetrical. Widening autonomy is the
 * change that can hurt somebody, and it is gated hardest. Narrowing it is the
 * brake, and a brake you have to get a second signature for is a brake that
 * does not work — so narrowing is always allowed immediately, by anyone who
 * could have widened it.
 *
 * That asymmetry is the whole design. Everything below is bookkeeping.
 */

export type ConfigRisk = "critical" | "normal";

/**
 * Which way a change moves relative to agent autonomy.
 *
 * `lateral` covers changes that are neither — swapping one routing queue for
 * another, say. They are still audited; they just do not need the extra gate.
 */
export type ConfigDirection = "widening" | "narrowing" | "lateral";

/**
 * Fields that govern autonomy or safety.
 *
 * A prefix matches the field itself and everything under it, so
 * `category_policies` covers `category_policies.vpn.confidence_threshold`.
 *
 * The list is deliberately generous. A field wrongly marked critical costs
 * somebody an extra sentence of justification; a field wrongly marked normal
 * is how the agent quietly gets more rope. Those are not comparable errors.
 */
export const CRITICAL_FIELDS = [
  // Confidence and auto-reply thresholds.
  "default_policy",
  "category_policies",

  // The kill switch.
  "agent_mode_override",

  // Action whitelist and tool permissions.
  "auto_action_whitelist",

  // Security and routing policy: who never gets an unattended answer.
  "never_auto_categories",
  "vip_always_human",
  "human_only_departments",
  "routing",

  // Evidence floor. Lowering it lets the agent answer on weaker runbook
  // support, which is a confidence threshold wearing a different hat.
  "kb_support_floor",

  // Auto-close. Shortening it closes tickets the requester has not replied to.
  "followup_hours",

  // PII handling.
  "scrub_secrets_at_rest",

  // Loop brakes. These exist so a runaway costs one hour rather than one night.
  "max_agent_runs_per_requester_hour",
  "max_agent_runs_per_tenant_hour",
  "max_clarify_rounds",

  // Change control itself. Critical, so that switching it off is audited and
  // gated like any other loosening of a safeguard.
  "require_dual_control_for_widening",

  // How long a queued action stays approvable. A longer window is a wider one:
  // it lets a stale approval fire against a situation that has moved on.
  "approval_expiry_hours",

  // Oversight, not preference. `notifications.enabled` silences every notice at
  // once, and `notifications.approval` is how anybody finds out that the agent
  // is waiting for authorization — an approval nobody is told about expires
  // unread, which is indistinguishable from one that was quietly denied. The
  // other notification toggles are ordinary settings: somebody deciding they do
  // not want assignment mail is not a safety decision.
  "notifications.enabled",
  "notifications.approval",
] as const;

/**
 * Kept as the old name so existing imports and the console keep working.
 * `CRITICAL_FIELDS` is what it has always meant.
 */
export const SECURITY_SENSITIVE_KEYS = CRITICAL_FIELDS;

export function classifyField(field: string): ConfigRisk {
  return CRITICAL_FIELDS.some((k) => field === k || field.startsWith(`${k}.`))
    ? "critical"
    : "normal";
}

// --- direction --------------------------------------------------------------

const AUTONOMY_RANK: Record<string, number> = {
  off: 0,
  suggest: 1,
  reply: 2,
  act: 3,
};

const MODE_RANK: Record<string, number> = { shadow: 0, assist: 1, auto: 2 };

/**
 * Fields where a larger number means more autonomy, and fields where a smaller
 * number does. Getting this backwards would gate the safe direction and wave
 * the dangerous one through, so they are listed rather than guessed.
 */
const HIGHER_IS_WIDER = new Set([
  "max_agent_runs_per_requester_hour",
  "max_agent_runs_per_tenant_hour",
  "max_clarify_rounds",
  "approval_expiry_hours",
]);

const LOWER_IS_WIDER = new Set([
  "confidence_threshold",
  "kb_support_floor",
  "followup_hours",
]);

/** Arrays whose entries are permissions: adding one widens. */
const ADDING_WIDENS = new Set(["auto_action_whitelist"]);

/** Arrays whose entries are restrictions: removing one widens. */
const REMOVING_WIDENS = new Set(["never_auto_categories", "human_only_departments"]);

/**
 * Booleans that are brakes: turning one off widens.
 *
 * Entries may be a leaf name or a full dotted path. The path form exists
 * because `enabled` is too generic a leaf to claim globally — it would capture
 * any future `something.enabled` and start gating it as a safety setting.
 */
const FALSE_IS_WIDER = new Set([
  "vip_always_human",
  "scrub_secrets_at_rest",
  "require_dual_control_for_widening",
  "notifications.enabled",
  "notifications.approval",
]);

/** The last dotted segment, so `category_policies.vpn.autonomy` reads as `autonomy`. */
function leaf(field: string): string {
  const parts = field.split(".");
  return parts[parts.length - 1] ?? field;
}

export function directionOf(
  field: string,
  oldValue: unknown,
  newValue: unknown,
): ConfigDirection {
  const key = leaf(field);

  if (key === "autonomy") {
    return compare(AUTONOMY_RANK[String(oldValue)], AUTONOMY_RANK[String(newValue)]);
  }

  if (field === "agent_mode_override") {
    // null means "follow the deployment", which is the widest this can be:
    // the override only ever narrows, so removing it removes a restriction.
    const rank = (v: unknown) =>
      v === null || v === undefined ? Number.MAX_SAFE_INTEGER : MODE_RANK[String(v)];
    return compare(rank(oldValue), rank(newValue));
  }

  if (HIGHER_IS_WIDER.has(key)) return compare(num(oldValue), num(newValue));
  if (LOWER_IS_WIDER.has(key)) return compare(num(newValue), num(oldValue));
  if (FALSE_IS_WIDER.has(key) || FALSE_IS_WIDER.has(field)) {
    if (oldValue === newValue) return "lateral";
    return newValue === false ? "widening" : "narrowing";
  }

  if (ADDING_WIDENS.has(key) || REMOVING_WIDENS.has(key)) {
    const before = new Set(asArray(oldValue));
    const after = new Set(asArray(newValue));
    const added = [...after].some((v) => !before.has(v));
    const removed = [...before].some((v) => !after.has(v));
    const widensOnAdd = ADDING_WIDENS.has(key);

    // A change that both adds and removes is reported as widening, because the
    // addition is the half that can hurt and the gate should see it.
    if (widensOnAdd) return added ? "widening" : removed ? "narrowing" : "lateral";
    return removed ? "widening" : added ? "narrowing" : "lateral";
  }

  return "lateral";
}

function compare(before: number | undefined, after: number | undefined): ConfigDirection {
  if (before === undefined || after === undefined) return "lateral";
  if (Number.isNaN(before) || Number.isNaN(after)) return "lateral";
  if (after > before) return "widening";
  if (after < before) return "narrowing";
  return "lateral";
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

// --- impact -----------------------------------------------------------------

export interface FieldChange {
  field: string;
  old_value: unknown;
  new_value: unknown;
  risk: ConfigRisk;
  direction: ConfigDirection;
}

/**
 * True when a change needs a second administrator.
 *
 * Critical *and* widening. Narrowing never qualifies, whatever the field: a
 * person who has decided the agent is misbehaving must be able to stop it
 * without finding a colleague, and every second spent looking for one is a
 * second the agent is still answering tickets.
 */
export function requiresDualControl(change: FieldChange): boolean {
  return change.risk === "critical" && change.direction === "widening";
}

/**
 * One sentence a person can check before they confirm.
 *
 * The point is to turn `0.9 -> 0.82` into a claim about the world, because the
 * number on its own is not something anybody can sanity-check at the moment
 * they are clicking the button.
 */
export function describeImpact(change: FieldChange): string {
  const key = leaf(change.field);
  const scope = categoryOf(change.field);
  const where = scope ? ` for ${scope}` : "";

  if (key === "confidence_threshold") {
    const before = num(change.old_value);
    const after = num(change.new_value);
    if (before !== undefined && after !== undefined) {
      return after < before
        ? `The agent will answer${where} on classifications it is less sure of ` +
            `(${pct(after)} confidence rather than ${pct(before)}). More tickets ` +
            "answered unattended, and more of them wrong."
        : `The agent will answer${where} only when more certain (${pct(after)} ` +
            `rather than ${pct(before)}). Fewer unattended answers, more work for people.`;
    }
  }

  if (key === "autonomy") {
    const copy: Record<string, string> = {
      off: "classify only; a person writes every reply",
      suggest: "draft into the review queue; nothing sends",
      reply: "send replies unattended above the confidence threshold",
      act: "send replies and run whitelisted tools unattended",
    };
    return `Tickets${where} move from "${copy[String(change.old_value)] ?? change.old_value}" to "${copy[String(change.new_value)] ?? change.new_value}".`;
  }

  if (change.field === "agent_mode_override") {
    if (change.new_value === null) {
      return "Removes the tenant kill switch. Autonomy returns to whatever the deployment mode allows.";
    }
    return `Caps this tenant at ${change.new_value} regardless of the deployment mode. Takes effect on the next ticket.`;
  }

  if (key === "auto_action_whitelist") {
    const added = diffArrays(change.old_value, change.new_value).added;
    const removed = diffArrays(change.old_value, change.new_value).removed;
    if (added.length) {
      return `The agent may now run ${added.join(", ")} unattended, with no approval step.`;
    }
    if (removed.length) {
      return `${removed.join(", ")} will now queue for human approval.`;
    }
  }

  if (key === "never_auto_categories") {
    const removed = diffArrays(change.old_value, change.new_value).removed;
    if (removed.length) {
      return `${removed.join(", ")} becomes automatable. No measured accuracy previously opened it.`;
    }
  }

  if (key === "vip_always_human") {
    return change.new_value === false
      ? "VIP tickets may now be answered by the agent without a person."
      : "VIP tickets will always go to a person.";
  }

  if (key === "require_dual_control_for_widening") {
    return change.new_value === false
      ? "Removes the second-administrator requirement. One person will be able to widen autonomy alone."
      : "Widening autonomy will need a second administrator to approve it.";
  }

  if (key === "scrub_secrets_at_rest") {
    return change.new_value === false
      ? "Passwords and keys pasted into tickets will be stored in plain text."
      : "Credentials will be scrubbed from ticket bodies at intake.";
  }

  if (key === "kb_support_floor") {
    const before = num(change.old_value);
    const after = num(change.new_value);
    if (before !== undefined && after !== undefined && after < before) {
      return "The agent will treat weaker runbook matches as support for a reply.";
    }
    return "The agent will require closer runbook matches before replying.";
  }

  if (key === "followup_hours") {
    return `Resolved tickets auto-close after ${change.new_value}h instead of ${change.old_value}h without a reply.`;
  }

  if (key === "approval_expiry_hours") {
    const before = num(change.old_value);
    const after = num(change.new_value);
    return after !== undefined && before !== undefined && after > before
      ? `Queued actions stay approvable for ${after}h instead of ${before}h. A stale approval can fire further from the moment it was asked for.`
      : `Queued actions expire after ${after}h instead of ${before}h.`;
  }

  if (key.startsWith("max_agent_runs")) {
    return `Raises the loop brake from ${change.old_value} to ${change.new_value} agent runs per hour.`;
  }

  if (change.field === "notifications.enabled") {
    return change.new_value === false
      ? "Silences every notification this tenant sends. Assignments, SLA warnings, escalations and approval requests will reach nobody by email."
      : "Notifications are sent again, subject to the individual toggles below.";
  }

  if (change.field === "notifications.approval") {
    return change.new_value === false
      ? "Nobody is emailed when the agent asks for authorization. Queued actions will expire unread, which looks exactly like a rejection."
      : "Approvers are emailed when the agent asks for authorization.";
  }

  if (change.field.startsWith("notifications.")) {
    const name = key.replace(/_/g, " ");
    if (typeof change.new_value === "boolean") {
      return change.new_value
        ? `${name} notifications will be sent.`
        : `${name} notifications will not be sent. Individuals can already opt out of these themselves.`;
    }
    if (change.field === "notifications.sla_warning_at_percent") {
      return `SLA warnings go out with ${change.new_value}% of the window left instead of ${change.old_value}%.`;
    }
    if (change.field === "notifications.ops_address") {
      return change.new_value
        ? `Escalations and approvals with no individual recipient go to ${change.new_value}.`
        : "Escalations and approvals with no individual recipient will be skipped and noted on the ticket rather than sent anywhere.";
    }
  }

  return `${change.field}: ${JSON.stringify(change.old_value)} → ${JSON.stringify(change.new_value)}`;
}

function diffArrays(before: unknown, after: unknown) {
  const b = new Set(asArray(before));
  const a = new Set(asArray(after));
  return {
    added: [...a].filter((v) => !b.has(v)),
    removed: [...b].filter((v) => !a.has(v)),
  };
}

/** `category_policies.vpn.confidence_threshold` -> `vpn`. */
function categoryOf(field: string): string | null {
  const m = field.match(/^category_policies\.([^.]+)/);
  return m ? m[1]! : null;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
