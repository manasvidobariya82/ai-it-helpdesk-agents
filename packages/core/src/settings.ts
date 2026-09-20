import { z } from "zod";

/**
 * Per-category autonomy. This is the dial phase 4 turns, one category at a
 * time, and the reason autonomy lives in the database rather than in code:
 * widening it should not need a deploy, and narrowing it should not either.
 *
 *   off     - agent classifies only; a human writes every reply
 *   suggest - agent drafts; the draft waits in the review queue
 *   reply   - agent sends replies unattended above the confidence threshold
 *   act     - agent may also run whitelisted safe_write tools
 */
export const AutonomyLevel = z.enum(["off", "suggest", "reply", "act"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

export const CategoryPolicy = z.object({
  autonomy: AutonomyLevel.default("off"),
  /**
   * Per-category, because they calibrate differently. Do not hand-pick these:
   * run shadow mode, bucket by confidence, and set each where measured
   * accuracy crosses ~95%.
   */
  confidence_threshold: z.number().min(0).max(1).default(0.95),
});
export type CategoryPolicy = z.infer<typeof CategoryPolicy>;

export const BusinessHours = z.object({
  tz: z.string().default("UTC"),
  /** ISO weekdays: 1 = Monday. */
  days: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
  start: z.string().regex(/^\d{2}:\d{2}$/).default("09:00"),
  end: z.string().regex(/^\d{2}:\d{2}$/).default("17:30"),
  /** ISO dates (YYYY-MM-DD) treated as non-working. */
  holidays: z.array(z.string()).default([]),
});
export type BusinessHours = z.infer<typeof BusinessHours>;

const PriorityMinutes = z.object({
  P1: z.number().int().positive(),
  P2: z.number().int().positive(),
  P3: z.number().int().positive(),
  P4: z.number().int().positive(),
});

export const SlaPolicy = z.object({
  first_response_minutes: PriorityMinutes.default({
    P1: 15,
    P2: 60,
    P3: 240,
    P4: 480,
  }),
  resolution_minutes: PriorityMinutes.default({
    P1: 240,
    P2: 480,
    P3: 1440,
    P4: 4320,
  }),
  /**
   * Priorities whose clock runs around the clock rather than through business
   * hours. An outage at 2am does not get to wait until 9.
   */
  calendar_priorities: z.array(z.enum(["P1", "P2", "P3", "P4"])).default(["P1"]),
});
export type SlaPolicy = z.infer<typeof SlaPolicy>;

/**
 * Which team gets the ticket. Defaults reproduce what the pipeline hard-coded
 * before this existed, so adding the block changes no behaviour on its own.
 *
 * It is configuration rather than code because the evaluation harness scores
 * routing against a golden `expected_team`, and a rule you cannot change is a
 * rule you cannot fix when the measurement says it is wrong.
 */
export const RoutingPolicy = z.object({
  default_queue: z.string().default("tier1"),
  escalation_queue: z.string().default("oncall"),
  /** Priorities that go to the escalation queue whatever the category says. */
  escalate_priorities: z.array(z.enum(["P1", "P2", "P3", "P4"])).default(["P1"]),
  /** Per-category overrides, keyed by TicketCategory. */
  category_queues: z.record(z.string(), z.string()).default({}),
});
export type RoutingPolicy = z.infer<typeof RoutingPolicy>;

/**
 * Which notifications this tenant sends.
 *
 * Everything here defaults to on, which is the opposite of how autonomy
 * defaults, and for a reason: an unsent notification is a person not finding
 * out, and the failure mode of a helpdesk nobody hears from is worse than the
 * failure mode of a helpdesk that emails too much. The volume problem is then
 * solved by the people receiving them — each notification carries an
 * unsubscribe link, and an individual's opt-out is recorded against their
 * address rather than in here.
 *
 * Two of these fields are treated as safety settings in `config-policy.ts`:
 * `enabled`, which silences everything at once, and `approval`, which is how
 * anybody finds out that the agent is waiting for authorization. Turning either
 * off reduces human oversight of the agent, which is the definition that file
 * uses for a widening change.
 */
export const NotificationPolicy = z.object({
  /** The master switch. Off means this tenant sends notifications to nobody. */
  enabled: z.boolean().default(true),

  /** A ticket was assigned to a member of staff. */
  assignment: z.boolean().default(true),
  /** An SLA clock is about to run out. */
  sla_warning: z.boolean().default(true),
  /** The agent handed a ticket to a queue. */
  escalation: z.boolean().default(true),
  /** The agent is waiting for a human to authorize an action. */
  approval: z.boolean().default(true),
  /** The requester's ticket was resolved by a person. */
  resolution: z.boolean().default(true),

  /**
   * How much of the SLA window has to be left before the warning goes out, as a
   * percentage. 20% means a four-hour target warns with 48 minutes to go and a
   * fifteen-minute target warns with three — which is the right shape: the
   * warning is useful in proportion to how long the remedy takes.
   */
  sla_warning_at_percent: z.number().int().min(1).max(50).default(20),

  /**
   * Where escalation and approval notices go when no individual is the obvious
   * recipient — an unassigned ticket, or a tenant whose approvers have all
   * opted out. Null means those notices are skipped rather than sent somewhere
   * arbitrary, and the skip is recorded on the ticket.
   */
  ops_address: z.string().nullable().default(null),
});
export type NotificationPolicy = z.infer<typeof NotificationPolicy>;

export const BusinessSettings = z.object({
  /** Fallback for categories with no explicit policy. Deliberately closed. */
  default_policy: CategoryPolicy.default({
    autonomy: "off",
    confidence_threshold: 0.95,
  }),
  /** Keyed by TicketCategory. Unknown keys are ignored by policyFor(). */
  category_policies: z.record(z.string(), CategoryPolicy).default({}),

  /**
   * The kill switch. When set, it caps the effective mode for this tenant
   * regardless of what the deployment's AGENT_MODE says, and it takes effect
   * on the next ticket because settings are read per run. An env var that
   * needs a restart is not a kill switch.
   */
  agent_mode_override: z.enum(["shadow", "assist", "auto"]).nullable().default(null),
  /** Free text shown in the console banner when the override is set. */
  agent_mode_override_reason: z.string().nullable().default(null),

  /** Minimum cosine similarity for a KB chunk to count as support for a reply. */
  kb_support_floor: z.number().min(0).max(1).default(0.62),
  /** Tools this tenant permits the agent to invoke without a human. */
  auto_action_whitelist: z.array(z.string()).default([]),
  /** How many clarifying rounds before the agent gives up and escalates. */
  max_clarify_rounds: z.number().int().min(0).max(3).default(1),
  /**
   * How long a queued action stays approvable.
   *
   * "Reset this person's password" is reasonable to approve within the hour and
   * unreasonable to approve on Monday, by which time nobody remembers the
   * ticket. Capped at a week because an approval that can wait a month is not
   * an approval, it is a standing permission, and those belong in the whitelist
   * where they are visible.
   */
  approval_expiry_hours: z.number().int().min(1).max(168).default(24),
  /** Hours after a resolve before the follow-up check runs. */
  followup_hours: z.number().int().min(1).max(168).default(24),

  // --- routing ------------------------------------------------------------
  /** Send every VIP ticket to a person, whatever the category says. */
  vip_always_human: z.boolean().default(true),
  /** Departments that never get an unattended reply (Legal, HR, Finance...). */
  human_only_departments: z.array(z.string()).default([]),
  /**
   * Categories a threshold can never open. `security_incident` is here because
   * no observed accuracy should be able to automate it: the cost of the rare
   * miss is not on the same scale as the saving on the common case, and that
   * is a judgement, not a measurement. The evaluation harness reports these as
   * `human_only` rather than recommending a number for them.
   */
  never_auto_categories: z.array(z.string()).default(["security_incident"]),
  routing: RoutingPolicy.default(RoutingPolicy.parse({})),

  // --- rate limits --------------------------------------------------------
  /**
   * API requests per key per minute.
   *
   * Not an autonomy control, which is why it is classified as an ordinary
   * setting: it is there so one integration's retry loop cannot crowd out
   * everybody else, and the cost of getting it wrong is a 429 rather than a
   * wrong action taken on somebody's behalf.
   */
  api_rate_limit_per_minute: z.number().int().min(1).max(10_000).default(120),
  /** Agent runs per requester per hour. Beyond this, tickets park for a human. */
  max_agent_runs_per_requester_hour: z.number().int().min(1).default(10),
  /** Agent runs per tenant per hour. A runaway loop should cost one hour, not one night. */
  max_agent_runs_per_tenant_hour: z.number().int().min(1).default(500),

  // --- redaction ----------------------------------------------------------
  /** Scrub credentials out of the stored ticket body at intake. */
  scrub_secrets_at_rest: z.boolean().default(true),

  // --- change control -----------------------------------------------------
  /**
   * Require a second administrator before a change that widens autonomy takes
   * effect. Narrowing is never held up: a brake that needs two signatures is
   * a brake that does not work.
   *
   * Defaults to off, because a deployment with one administrator would
   * otherwise be unable to configure itself at all. Turning it on is a
   * narrowing change and needs nobody; turning it off again is a widening one
   * and needs the second signature it is about to remove — so a tenant cannot
   * quietly opt out of its own change control.
   */
  require_dual_control_for_widening: z.boolean().default(false),

  business_hours: BusinessHours.default(BusinessHours.parse({})),
  sla: SlaPolicy.default(SlaPolicy.parse({})),
  notifications: NotificationPolicy.default(NotificationPolicy.parse({})),
  signature: z.string().default("— IT Support"),
});
export type BusinessSettings = z.infer<typeof BusinessSettings>;

export function parseSettings(raw: unknown): BusinessSettings {
  const parsed = BusinessSettings.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  // Malformed settings must never widen autonomy. Fall back to the closed default.
  console.error("[settings] invalid business settings, using defaults", parsed.error.issues);
  return BusinessSettings.parse({});
}

export function policyFor(
  settings: BusinessSettings,
  category: string,
): CategoryPolicy {
  return settings.category_policies[category] ?? settings.default_policy;
}

const MODE_RANK = { shadow: 0, assist: 1, auto: 2 } as const;
export type ModeName = keyof typeof MODE_RANK;

/**
 * The effective mode is the more restrictive of the deployment's mode and the
 * tenant's override. An override can only ever narrow autonomy - a tenant
 * cannot switch itself to `auto` on a deployment still running in shadow.
 */
export function effectiveMode(
  deploymentMode: ModeName,
  settings: BusinessSettings,
): ModeName {
  const override = settings.agent_mode_override;
  if (!override) return deploymentMode;
  return MODE_RANK[override] < MODE_RANK[deploymentMode] ? override : deploymentMode;
}
