import type {
  AgentMode,
  BusinessSettings,
  ResolutionPath,
  TicketStatus,
} from "@hd/core";
import { policyFor, type AutonomyLevel } from "@hd/core";
import type { TriageResult } from "./schema.js";

/**
 * The decision branch.
 *
 * Pure on purpose: no database, no model, no clock. Everything that decides
 * whether an agent talks to a human being unattended is in one function that
 * a test can enumerate. If you change a rule here, change a test here.
 */

export type DecisionAction =
  | "send_reply" // reply to the requester and resolve
  | "ask_question" // one targeted clarification, then wait
  | "run_action" // whitelisted tool, then reply
  | "link_incident" // attach to the parent outage and acknowledge
  | "draft_only" // write it, park it in the review queue
  | "escalate"; // hand to a human with a summary

export interface DecisionInput {
  mode: AgentMode;
  settings: BusinessSettings;
  triage: TriageResult;
  /** Best cosine similarity from retrieval, or null when nothing was found. */
  kbTopScore: number | null;
  /** How many clarifying rounds this ticket has already had. */
  clarifyCount: number;
  /** Set when duplicate_of_hint resolved to a real open incident. */
  matchedIncidentId: string | null;
  requesterVip: boolean;
  /** Used by the tenant's department routing rules. */
  requesterDepartment: string | null;
  /** The injection scanner tripped on the requester's text. */
  injectionSuspected: boolean;
  /** Tool the agent would run, if the category maps to one. */
  candidateAction: { tool: string; args: Record<string, unknown> } | null;
}

export interface Decision {
  /**
   * What the agent would do with full autonomy. Always computed, including in
   * shadow mode - it is the counterfactual the calibration data is built from.
   */
  intendedPath: ResolutionPath;
  intendedAction: DecisionAction;
  /** What actually happens, after the mode and autonomy dials are applied. */
  path: ResolutionPath;
  action: DecisionAction;
  status: TicketStatus;
  /** Identifier of the rule that fired. Written to the event log. */
  rule: string;
  reason: string;
  autonomy: AutonomyLevel;
  confidenceThreshold: number;
  /** True only when the agent is permitted to contact the requester. */
  execute: boolean;
}

export function decide(input: DecisionInput): Decision {
  const { triage, settings } = input;
  const policy = policyFor(settings, triage.category);
  const threshold = policy.confidence_threshold;

  const base = intendedOutcome(input, threshold);
  const applied = applyMode(base, input.mode, policy.autonomy);

  return {
    intendedPath: base.path,
    intendedAction: base.action,
    path: applied.path,
    action: applied.action,
    status: applied.status,
    rule: base.rule,
    reason: base.reason,
    autonomy: policy.autonomy,
    confidenceThreshold: threshold,
    execute: applied.execute,
  };
}

interface Outcome {
  path: ResolutionPath;
  action: DecisionAction;
  rule: string;
  reason: string;
}

/**
 * First match wins, and the order is the safety argument. Every rule that can
 * stop the agent runs before every rule that can let it act.
 */
function intendedOutcome(input: DecisionInput, threshold: number): Outcome {
  const { triage, settings } = input;

  // 1. Never automate anything irreversible. No confidence score overrides this.
  if (triage.is_destructive_request) {
    return {
      path: "escalated",
      action: "escalate",
      rule: "destructive_request",
      reason:
        "Fulfilling this request would remove access, delete data, or change a security control.",
    };
  }

  // 2. Security work is judgement work, and the cost of being wrong is asymmetric.
  if (triage.is_security_sensitive || triage.category === "security_incident") {
    return {
      path: "escalated",
      action: "escalate",
      rule: "security_sensitive",
      reason: "Security-sensitive tickets always go to a human.",
    };
  }

  // 3. If the text tried to steer the agent, every downstream judgement made
  //    from that text is suspect, including the classification itself. A
  //    person looks at it. This does not block triage - it blocks acting on it.
  if (input.injectionSuspected) {
    return {
      path: "escalated",
      action: "escalate",
      rule: "injection_suspected",
      reason:
        "The ticket text contains what looks like an instruction aimed at the agent. Classification may be unreliable.",
    };
  }

  // 4. A VIP who is blocked gets a person, not a runbook. This is a routing
  //    decision the tenant makes, not a judgement about the ticket.
  if (input.requesterVip && settings.vip_always_human) {
    return {
      path: "escalated",
      action: "escalate",
      rule: "vip_requester",
      reason: "Tenant policy routes VIP requesters straight to a human.",
    };
  }

  // 5. Some departments are routed to a person regardless of category.
  if (
    input.requesterDepartment &&
    settings.human_only_departments.some(
      (d) => d.toLowerCase() === input.requesterDepartment!.toLowerCase(),
    )
  ) {
    return {
      path: "escalated",
      action: "escalate",
      rule: "department_policy",
      reason: `Tenant policy routes ${input.requesterDepartment} to a human.`,
    };
  }

  // 6. P1 means people are not working. A human owns that from the first minute.
  if (triage.priority === "P1") {
    return {
      path: "escalated",
      action: "escalate",
      rule: "priority_p1",
      reason: "P1: outage or a fully blocked VIP.",
    };
  }

  // 7. A known outage: link and acknowledge rather than open the fortieth duplicate.
  if (input.matchedIncidentId) {
    return {
      path: "auto_reply",
      action: "link_incident",
      rule: "known_incident",
      reason: `Matches active incident ${input.matchedIncidentId}.`,
    };
  }

  // 8. Ask before guessing - but only for as many rounds as the tenant allows.
  //
  // The second branch is unreachable in production today, and deliberately
  // so: intake does not re-enqueue triage when a reply threads onto an open
  // ticket, so this runs once per ticket with clarifyCount 0 and always asks.
  // Only max_clarify_rounds = 0 reaches clarify_exhausted, and that setting
  // means "never ask". The rule is here for the day the agent reads replies;
  // eval/golden-set/cases/case-061.json pins what it must do then.
  if (triage.missing_info.length > 0) {
    if (input.clarifyCount < settings.max_clarify_rounds) {
      return {
        path: "clarify",
        action: "ask_question",
        rule: "missing_info",
        reason: `Cannot resolve without: ${triage.missing_info.join("; ")}.`,
      };
    }
    return {
      path: "escalated",
      action: "escalate",
      rule: "clarify_exhausted",
      reason: `Still missing ${triage.missing_info.join("; ")} after ${input.clarifyCount} round(s).`,
    };
  }

  // 9. Honest low confidence is the cheap outcome. Take it.
  if (triage.confidence < threshold) {
    return {
      path: "escalated",
      action: "escalate",
      rule: "low_confidence",
      reason: `Triage confidence ${triage.confidence.toFixed(2)} is below the ${threshold.toFixed(2)} threshold for ${triage.category}.`,
    };
  }

  // 10. No runbook, no unattended reply. A confident model with no source is
  //     exactly the setup that produces a fluent wrong answer.
  const support = input.kbTopScore ?? 0;
  if (support < settings.kb_support_floor) {
    return {
      path: "escalated",
      action: "escalate",
      rule: "no_kb_support",
      reason:
        input.kbTopScore === null
          ? "No knowledge base match for this ticket."
          : `Best knowledge base match scored ${support.toFixed(2)}, below the ${settings.kb_support_floor.toFixed(2)} support floor.`,
    };
  }

  // 11. A whitelisted action is better than instructions the requester has to follow.
  if (
    input.candidateAction &&
    settings.auto_action_whitelist.includes(input.candidateAction.tool)
  ) {
    return {
      path: "auto_action",
      action: "run_action",
      rule: "whitelisted_action",
      reason: `${input.candidateAction.tool} is whitelisted for unattended use.`,
    };
  }

  return {
    path: "auto_reply",
    action: "send_reply",
    rule: "confident_with_runbook",
    reason: `Confidence ${input.triage.confidence.toFixed(2)} with runbook support ${support.toFixed(2)}.`,
  };
}

interface AppliedOutcome {
  path: ResolutionPath;
  action: DecisionAction;
  status: TicketStatus;
  execute: boolean;
}

/**
 * The autonomy dial. Two independent gates: the global mode (how far along the
 * phase plan this deployment is) and the per-category autonomy level (which
 * categories have earned it). Both must open. Neither can widen the other.
 */
function applyMode(
  outcome: Outcome,
  mode: AgentMode,
  autonomy: AutonomyLevel,
): AppliedOutcome {
  // Escalation is never gated, in any mode. It contacts nobody and changes
  // nothing outside our own ticket record; all it does is put the work in
  // front of a person with the agent's summary attached. In shadow mode that
  // summary is the most useful thing the agent produces.
  if (outcome.action === "escalate") {
    return { path: "escalated", action: "escalate", status: "triaged", execute: true };
  }

  // Shadow mode: classify, draft, log the counterfactual, contact nobody.
  if (mode === "shadow") {
    return { path: "human_only", action: "draft_only", status: "triaged", execute: false };
  }

  // Assist mode: everything the agent would send becomes a reviewable draft.
  if (mode === "assist") {
    return { path: "human_only", action: "draft_only", status: "triaged", execute: false };
  }

  // Auto mode: the per-category level decides.
  switch (autonomy) {
    case "off":
      return { path: "human_only", action: "draft_only", status: "triaged", execute: false };
    case "suggest":
      return { path: "human_only", action: "draft_only", status: "triaged", execute: false };
    case "reply":
      // A category cleared for replies is not cleared for actions.
      if (outcome.action === "run_action") {
        return {
          path: "human_only",
          action: "draft_only",
          status: "awaiting_approval",
          execute: false,
        };
      }
      return {
        path: outcome.path,
        action: outcome.action,
        status: statusFor(outcome.action),
        execute: true,
      };
    case "act":
      return {
        path: outcome.path,
        action: outcome.action,
        status: statusFor(outcome.action),
        execute: true,
      };
  }
}

function statusFor(action: DecisionAction): TicketStatus {
  switch (action) {
    case "ask_question":
      return "awaiting_user";
    case "run_action":
      return "in_progress";
    case "send_reply":
    case "link_incident":
      return "resolved";
    case "draft_only":
      return "triaged";
    case "escalate":
      return "triaged";
  }
}
