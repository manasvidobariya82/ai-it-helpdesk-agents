import type { BusinessSettings } from "./settings.js";
import type { TicketPriority } from "./types.js";

/**
 * Which team a ticket goes to.
 *
 * This was two words inline in the pipeline — `priority === "P1" ? "oncall" :
 * "tier1"` — which is a defensible default and an undefensible place to keep
 * it. A routing rule that lives inside a call site cannot be scored against a
 * golden label, cannot be changed per tenant, and cannot be part of the
 * fingerprint that decides whether an evaluation baseline is still valid.
 *
 * Pure, like `decide`: no database, no clock. The whole routing policy is
 * visible in one function and one settings block.
 */
export function routeQueue(
  category: string | null,
  priority: TicketPriority | null,
  settings: BusinessSettings,
): string {
  const rules = settings.routing;

  // Priority wins over category. An outage does not wait in a queue that is
  // staffed office hours because the classifier called it `software`.
  if (priority && rules.escalate_priorities.includes(priority)) {
    return rules.escalation_queue;
  }

  if (category && rules.category_queues[category]) {
    return rules.category_queues[category]!;
  }

  return rules.default_queue;
}

/**
 * A stable description of the routing policy, for the evaluation fingerprint.
 *
 * Changing any of this changes which team a ticket reaches, so a baseline
 * measured before the change is not comparable to a run after it.
 */
export function routingFingerprint(settings: BusinessSettings): string {
  const rules = settings.routing;
  const pairs = Object.entries(rules.category_queues)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return [
    `default=${rules.default_queue}`,
    `escalation=${rules.escalation_queue}`,
    `priorities=${[...rules.escalate_priorities].sort().join("|")}`,
    `categories=${pairs}`,
  ].join(";");
}
