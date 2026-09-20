import type { Requester } from "@hd/core";
import type { TriageResult } from "./schema.js";

export interface CandidateAction {
  tool: string;
  args: Record<string, unknown>;
  /** Shown to the approver, and written to the event log. */
  rationale: string;
}

/**
 * Triage output to candidate tool, by table.
 *
 * The agent does not pick a tool out of free text. A closed mapping from a
 * classified category to at most one candidate action, gated afterwards by
 * the tenant whitelist, means the set of things the agent can do unattended
 * is enumerable by reading this file. Anything not in the table falls through
 * to a written reply or an escalation.
 */
export function candidateActionFor(
  triage: TriageResult,
  ctx: { requester: Pick<Requester, "email"> | null },
): CandidateAction | null {
  const email = ctx.requester?.email;
  if (!email) return null;

  const text = `${triage.subcategory} ${triage.reasoning}`.toLowerCase();

  if (triage.category === "access_identity") {
    if (/lock(ed)?\s*out|account lock|too many attempts/.test(text)) {
      return {
        tool: "identity.unlock_account",
        args: { email },
        rationale: "Requester is locked out after failed sign-ins; unlocking is reversible.",
      };
    }
    if (/password (reset|forgot|expired)|forgot.*password|reset.*password/.test(text)) {
      return {
        tool: "identity.reset_password",
        args: { email, notify_channel: "manager" },
        rationale: "Standard password reset with a forced change at next sign-in.",
      };
    }
  }

  if (triage.category === "software" && /licen[cs]e|seat|activation/.test(text)) {
    const sku = triage.affected_system;
    if (sku) {
      return {
        tool: "identity.grant_licence",
        args: { email, sku },
        rationale: `Requester needs a ${sku} seat.`,
      };
    }
  }

  return null;
}
