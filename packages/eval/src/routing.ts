import { clamp01, wilsonLowerBound } from "./metrics.js";

/**
 * Routing metrics — what the classification actually cost.
 *
 * Accuracy says how often the label was right. It does not say how often a
 * ticket landed on the wrong desk, and those are different numbers: a
 * `hardware` ticket called `software` is one misclassification and, if both
 * route to tier1, zero misrouted tickets. The false-routing rate is the one
 * that shows up as somebody's afternoon.
 *
 * It is also the number autonomy should be argued from, because it is scoped
 * to the tickets that autonomy would actually have handled — the ones above
 * their category's threshold. A classifier that is wrong constantly below the
 * line and right above it is a usable classifier.
 */

export interface RoutingSample {
  id: string;
  category: string;
  confidence: number;
  predicted_team: string;
  actual_team: string;
  /** Whether the category itself was right, for the correction rate. */
  category_correct: boolean;
}

export interface RoutingOutcome {
  /** Tickets that cleared their category's threshold and would auto-route. */
  routed: number;
  /** Of the whole slice, the share that would auto-route. */
  coverage: number;
  /** Auto-routed tickets that reached the wrong team. */
  misrouted: number;
  /**
   * Misrouted as a share of auto-routed. The trust metric: of the work the
   * agent took off a human's desk unattended, how much it put on the wrong one.
   */
  false_routing_rate: number | null;
  /** Wilson 95% upper bound on that rate — the pessimistic read. */
  false_routing_upper_bound: number | null;
  /** Tickets held back for a human because they were below the line. */
  held: number;
  /** Of those held, how many the agent had right anyway — the cost of caution. */
  held_correct: number;
  /** Misroutes among the held tickets, which a human caught. */
  held_misrouted: number;
  /** The per-ticket detail, for the misrouted ones only. */
  misroutes: Array<{ id: string; from: string; to: string; confidence: number }>;
}

export interface RoutingPolicyView {
  /** Threshold in force for a category, or null when it has none. */
  thresholdFor: (category: string) => number | null;
  /** Categories no threshold can open. They never count as auto-routed. */
  neverAuto: ReadonlySet<string>;
}

export function routingOutcome(
  samples: readonly RoutingSample[],
  policy: RoutingPolicyView,
): RoutingOutcome {
  const misroutes: RoutingOutcome["misroutes"] = [];
  let routed = 0;
  let misrouted = 0;
  let held = 0;
  let heldCorrect = 0;
  let heldMisrouted = 0;

  for (const s of samples) {
    const threshold = policy.thresholdFor(s.category);
    const wrongTeam = s.predicted_team !== s.actual_team;
    // A never-auto category is held however confident the model is. That is
    // the point of the list: it is a judgement that outranks the measurement.
    const wouldRoute =
      !policy.neverAuto.has(s.category) &&
      threshold !== null &&
      clamp01(s.confidence) >= threshold;

    if (wouldRoute) {
      routed += 1;
      if (wrongTeam) {
        misrouted += 1;
        misroutes.push({
          id: s.id,
          from: s.predicted_team,
          to: s.actual_team,
          confidence: s.confidence,
        });
      }
    } else {
      held += 1;
      if (s.category_correct) heldCorrect += 1;
      if (wrongTeam) heldMisrouted += 1;
    }
  }

  return {
    routed,
    coverage: samples.length === 0 ? 0 : routed / samples.length,
    misrouted,
    false_routing_rate: routed === 0 ? null : misrouted / routed,
    false_routing_upper_bound:
      routed === 0 ? null : 1 - wilsonLowerBound(routed - misrouted, routed),
    held,
    held_correct: heldCorrect,
    held_misrouted: heldMisrouted,
    misroutes: misroutes.sort((a, b) => b.confidence - a.confidence).slice(0, 20),
  };
}

/**
 * The same question per category, because "which categories can safely operate
 * at which threshold" is answered one category at a time.
 */
export interface CategoryRouting extends RoutingOutcome {
  category: string;
  threshold: number | null;
  never_auto: boolean;
  n: number;
}

export function routingByCategory(
  samples: readonly RoutingSample[],
  policy: RoutingPolicyView,
): CategoryRouting[] {
  const groups = new Map<string, RoutingSample[]>();
  for (const s of samples) {
    const list = groups.get(s.category);
    if (list) list.push(s);
    else groups.set(s.category, [s]);
  }

  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([category, rows]) => ({
      category,
      threshold: policy.thresholdFor(category),
      never_auto: policy.neverAuto.has(category),
      n: rows.length,
      ...routingOutcome(rows, policy),
    }));
}
