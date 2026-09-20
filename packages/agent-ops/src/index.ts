/**
 * Business ops agent — placeholder.
 *
 * This package exists now so the boundary is real from the first commit. The
 * shared layer (`core`, `llm`, `rag`, `tools`) was extracted while the first
 * agent was built rather than after, because retrofitting a shared layer out
 * of a working monolith costs a fortnight every single time.
 *
 * What is deliberately NOT shared with the helpdesk agent:
 *
 *   Taxonomy   Lead stages and helpdesk categories have nothing to do with
 *              each other. Separate enums, separate prompts.
 *   SLA logic  Helpdesk runs on response-time clocks; ops runs on follow-up
 *              cadence. Different scheduling semantics, different tables.
 *   Tone       Helpdesk replies are short, literal and step-numbered. Ops
 *              outreach is persuasive. One shared voice config makes both
 *              worse, so each agent owns its own prompt registry entries.
 *   Autonomy   A bad sales email is embarrassing. A bad account deletion is a
 *              Tuesday you remember for years. The thresholds are tuned
 *              independently and stored per agent.
 *
 * The import rule that keeps this clean: `core`, `llm`, `rag` and `tools` must
 * never import from an `agent-*` package. If you want them to, the thing you
 * need belongs in core.
 */

export const AGENT_ID = "ops" as const;

export interface OpsAgentPlan {
  stage: "leads" | "followups" | "reports";
  status: "planned";
}

export const roadmap: OpsAgentPlan[] = [
  { stage: "leads", status: "planned" },
  { stage: "followups", status: "planned" },
  { stage: "reports", status: "planned" },
];
