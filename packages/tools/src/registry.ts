import {
  actorString,
  checkApproval,
  logToolCall,
  requirePermission,
  type TenantContext,
} from "@hd/core";
import type { z } from "zod";

/**
 * Risk tiers.
 *
 * The rule this whole file exists to enforce: the agent may act unattended
 * only inside an explicit whitelist. Blacklisting is the wrong shape - the
 * dangerous action is always the one nobody thought to add to the list.
 *
 *   read        - looks something up, changes nothing
 *   internal    - writes only to our own ticket record; nothing leaves the
 *                 system and no account is touched. Never gated: escalating
 *                 to a human is the safe outcome, and a gate that can block
 *                 it turns a cautious agent into a stuck one.
 *   safe_write  - reversible, low blast radius, and visible outside the
 *                 system (a reply to a person, a password reset).
 *                 Whitelistable per tenant.
 *   sensitive   - reversible but consequential; always needs a human
 *   destructive - deletes data, removes access, wipes, changes a security
 *                 control. Never executable without an approved request, and
 *                 there is no tenant setting that changes that.
 */
export type RiskTier =
  | "read"
  | "internal"
  | "safe_write"
  | "sensitive"
  | "destructive";

export type AgentId = "helpdesk" | "ops";

/**
 * What a tool is allowed to touch.
 *
 * Carries the whole `TenantContext` rather than a loose `businessId` and an
 * `actor` string. A tool that writes to the database gets the same scoping
 * every repository gets, and the actor written to the log is derived from the
 * authenticated identity instead of being passed in by the caller — which is
 * what let the console attribute everything to the constant `human:console`.
 */
export interface ToolContext {
  tenant: TenantContext;
  ticketId: string | null;
  /** Set only when an approval for this exact call has been granted. */
  approvalId?: string | null;
}

/** The string written to `ticket_events.actor`, derived, never supplied. */
export function toolActor(ctx: ToolContext): string {
  return actorString(ctx.tenant);
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  riskTier: RiskTier;
  agents: AgentId[];
  schema: S;
  /** Human-readable summary of the call, shown in the approval queue. */
  summarize: (args: z.infer<S>) => string;
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}

const tools = new Map<string, ToolDefinition>();

export function defineTool<S extends z.ZodType>(
  def: ToolDefinition<S>,
): ToolDefinition<S> {
  if (tools.has(def.name)) throw new Error(`Duplicate tool: ${def.name}`);
  tools.set(def.name, def as unknown as ToolDefinition);
  return def;
}

export function getTool(name: string): ToolDefinition | undefined {
  return tools.get(name);
}

export function listTools(agent?: AgentId): ToolDefinition[] {
  const all = [...tools.values()];
  return (agent ? all.filter((t) => t.agents.includes(agent)) : all).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export class ToolNotFoundError extends Error {
  constructor(name: string) {
    super(`Unknown tool: ${name}`);
    this.name = "ToolNotFoundError";
  }
}

export class ToolPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolPermissionError";
  }
}

/**
 * Thrown when the approval id handed to `executeTool` does not authorize the
 * call it was handed to.
 *
 * The gate used to unlock on `Boolean(ctx.approvalId)`, which checked that an
 * approval id was *present* and never that it was *valid*. Any non-empty string
 * ran a destructive tool — a rejected approval's id, an already-executed one,
 * one from another tenant, or the word "yes".
 */
export class ApprovalInvalidError extends Error {
  readonly status = 403;
  constructor(
    readonly toolName: string,
    readonly reason: "not_found" | "not_approved" | "expired" | "args_changed",
  ) {
    super(
      {
        not_found: `No approval for ${toolName} exists in this tenant.`,
        not_approved: `The approval for ${toolName} is not in an approved state. An approval authorizes one call; it cannot be replayed.`,
        expired: `The approval for ${toolName} expired before it was executed. Raise it again rather than reviving it.`,
        args_changed: `The arguments differ from the ones that were approved. An approval covers one specific call, not the tool in general.`,
      }[reason],
    );
    this.name = "ApprovalInvalidError";
  }
}

/** Thrown when a call is legitimate but must go through the approval queue. */
export class ApprovalRequiredError extends Error {
  constructor(
    readonly toolName: string,
    readonly riskTier: RiskTier,
    readonly args: Record<string, unknown>,
    readonly rationale: string,
  ) {
    super(`Tool ${toolName} (${riskTier}) requires human approval`);
    this.name = "ApprovalRequiredError";
  }
}

export interface ExecuteOptions {
  /** Tool names this tenant permits unattended. Only consulted for safe_write. */
  whitelist: string[];
  /** Why the agent wants this. Recorded, and shown to the approver. */
  rationale: string;
  agent: AgentId;
}

/**
 * The only way a tool runs. Validates arguments, applies the risk gate, logs
 * the call with its ticket id whatever the outcome.
 */
export async function executeTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
  opts: ExecuteOptions,
): Promise<unknown> {
  const tool = getTool(name);
  if (!tool) throw new ToolNotFoundError(name);

  if (!tool.agents.includes(opts.agent)) {
    throw new ToolPermissionError(`Tool ${name} is not available to the ${opts.agent} agent`);
  }

  const parsed = tool.schema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new ToolPermissionError(
      `Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  }
  const args = parsed.data as Record<string, unknown>;

  // An approval row IS the authorisation for this one call: it was written by
  // somebody holding `action:approve`, against these exact arguments, and it
  // has a deadline. All four of those are checked — presence alone means
  // nothing, which is what this used to rely on.
  let approved = false;
  if (ctx.approvalId) {
    const check = await checkApproval(ctx.tenant, ctx.approvalId, name, args);
    if (!check.ok) throw new ApprovalInvalidError(name, check.reason);
    approved = true;
  }

  // Without an approval the caller needs `action:execute` in their own right.
  // A `read` tool is exempt because reading is already gated by the repository
  // it calls.
  if (!approved && tool.riskTier !== "read") {
    requirePermission(ctx.tenant, "action:execute");
  }

  if (!approved) {
    // `read` and `internal` never reach the gate.
    if (tool.riskTier === "destructive") {
      // No whitelist entry and no tenant setting can bypass this.
      throw new ApprovalRequiredError(name, tool.riskTier, args, opts.rationale);
    }
    if (tool.riskTier === "sensitive") {
      throw new ApprovalRequiredError(name, tool.riskTier, args, opts.rationale);
    }
    if (tool.riskTier === "safe_write" && !opts.whitelist.includes(name)) {
      throw new ApprovalRequiredError(name, tool.riskTier, args, opts.rationale);
    }
  }

  const started = Date.now();
  try {
    const result = await tool.execute(args, ctx);
    await logToolCall(ctx.tenant, {
      ticket_id: ctx.ticketId,
      action_request_id: ctx.approvalId ?? null,
      tool_name: name,
      args,
      ok: true,
      result,
      latency_ms: Date.now() - started,
    });
    return result;
  } catch (err) {
    await logToolCall(ctx.tenant, {
      ticket_id: ctx.ticketId,
      action_request_id: ctx.approvalId ?? null,
      tool_name: name,
      args,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - started,
    });
    throw err;
  }
}
