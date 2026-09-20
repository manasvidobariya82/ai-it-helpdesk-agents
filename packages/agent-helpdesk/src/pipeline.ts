import { createHash } from "node:crypto";
import {
  agentContext,
  appendEvent,
  appendMessage,
  systemContext,
  applyTriage,
  checkRateLimit,
  currentConfigVersionNumber,
  effectiveMode,
  env,
  getBusiness,
  getSettings,
  getTicketUnscoped,
  incrementClarify,
  recordAgentRun,
  recordShadow,
  routeQueue,
  setStatus,
  type Business,
  type BusinessSettings,
  type TenantContext,
  type Ticket,
} from "@hd/core";
import { LLMCostCapError, LLMUnavailableError, LLMValidationError } from "@hd/llm";
import { retrieve, type RetrievedChunk } from "@hd/rag";
import {
  ApprovalRequiredError,
  executeTool,
  getTool,
  type ToolContext,
} from "@hd/tools";
import { notifyApprovalRequest, requestApproval } from "@hd/core";
import { candidateActionFor } from "./actions.js";
import { decide, type Decision } from "./decide.js";
import { draftQuestion, draftReply, incidentAck, type Draft } from "./draft.js";
import { enrich, resolveIncidentHint, type EnrichedContext } from "./enrich.js";
import { triageTicket } from "./triage.js";
import type { TriageResult } from "./schema.js";

export interface PipelineResult {
  ticketId: string;
  ok: boolean;
  triage?: TriageResult;
  decision?: Decision;
  draft?: Draft;
  chunks?: RetrievedChunk[];
  error?: string;
}

/**
 * Intake -> enrich -> retrieve -> triage -> decide -> execute.
 *
 * Every stage writes to the event log before the next one runs, so a ticket
 * that fails halfway is still explainable. The pipeline never throws at the
 * caller: a failed ticket becomes a human-owned ticket, which is the correct
 * degraded state for a helpdesk.
 */
export async function runPipeline(ticketId: string): Promise<PipelineResult> {
  // The worker is handed a ticket id off a queue, with no session behind it, so
  // this is the one place allowed to look a ticket up unscoped. The tenant it
  // finds becomes the context for everything after, and that context carries
  // the agent's permissions — which deliberately exclude `config:update` and
  // `action:approve`. The agent cannot widen its own autonomy or sign off its
  // own actions, and that is enforced by the type rather than by convention.
  const ticket = await getTicketUnscoped(ticketId);
  if (!ticket) return { ticketId, ok: false, error: "ticket not found" };

  const tenant = agentContext(ticket.business_id, { requestId: `triage:${ticketId}` });

  const business = await getBusiness(ticket.business_id);
  if (!business) return { ticketId, ok: false, error: "business not found" };

  const settings = await getSettings(business.id);
  // Read alongside the settings, so the number stamped on the ticket is the
  // version those exact settings came from. Reading it later would leave a
  // window in which somebody saves a change and the ticket is labelled with a
  // configuration that did not decide it.
  const configVersion = await currentConfigVersionNumber(business.id);
  const ctx = await enrich(tenant, ticket);

  // A merged ticket is not work any more; its thread lives on the survivor.
  if (ticket.merged_into_id) {
    return { ticketId, ok: false, error: `merged into ${ticket.merged_into_id}` };
  }

  // The mode the tenant is actually running in. The override can only ever
  // narrow what the deployment allows, and it is read here rather than at
  // startup so flipping it takes effect on the next ticket.
  const mode = effectiveMode(env.AGENT_MODE, settings);

  // Rate limit before the model call, not after. The point is to stop a loop
  // costing money, and a loop that gets triaged before being rejected has
  // already cost it.
  const limit = await checkRateLimit(tenant, ticket.requester_id, settings);
  if (!limit.allowed) {
    await appendEvent(tenant, {
      ticket_id: ticket.id,
      actor: "system",
      kind: "note",
      payload: {
        stage: "rate_limited",
        scope: limit.scope,
        used: limit.used,
        limit: limit.limit,
      },
    });
    await setStatus(tenant, ticket.id, "triaged");
    return {
      ticketId,
      ok: false,
      error: `rate limit reached (${limit.scope}: ${limit.used}/${limit.limit} in the last hour)`,
    };
  }

  await recordAgentRun(tenant, {
    requester_id: ticket.requester_id,
    ticket_id: ticket.id,
  });

  // --- Triage ------------------------------------------------------------
  let triage: TriageResult;
  let injectionSuspected = false;
  // Hoisted out of the try so the shadow record below can attribute the
  // classification to a model and a prompt version, and replay the prompt.
  let triageModel: string | null = null;
  let triagePromptVersion: string | null = null;
  let triagePromptVars: Record<string, string> | null = null;
  try {
    const outcome = await triageTicket(business, ticket, ctx);
    triage = outcome.triage;
    injectionSuspected = outcome.input.injection.suspected;
    triageModel = outcome.model;
    triagePromptVersion = outcome.promptVersion;
    triagePromptVars = outcome.promptVars;
    await appendEvent(tenant, {
      ticket_id: ticket.id,
      actor: "agent",
      kind: "triage",
      payload: {
        ...outcome.triage,
        prompt_version: outcome.promptVersion,
        attempts: outcome.attempts,
        redactions: outcome.input.redactions,
      },
      model: outcome.model,
      tokens_in: outcome.tokensIn,
      tokens_out: outcome.tokensOut,
      cost_usd: outcome.costUsd,
      latency_ms: outcome.latencyMs,
    });

    // Recorded as its own event so it is visible in the timeline and greppable
    // in the log, rather than buried in the triage payload.
    if (outcome.input.injection.suspected) {
      await appendEvent(tenant, {
        ticket_id: ticket.id,
        actor: "system",
        kind: "note",
        payload: {
          stage: "injection_scan",
          signals: outcome.input.injection.signals,
          samples: outcome.input.injection.samples,
        },
      });
    }
  } catch (err) {
    return failToHuman(tenant, ticket, err);
  }

  // --- Retrieve ----------------------------------------------------------
  let chunks: RetrievedChunk[] = [];
  try {
    chunks = await retrieve(tenant, {
      queryText: `${ticket.subject}\n${ticket.body}`,
      categories: [triage.category],
      limit: 5,
    });
    await appendEvent(tenant, {
      ticket_id: ticket.id,
      actor: "agent",
      kind: "retrieval",
      payload: {
        query_categories: [triage.category],
        hits: chunks.map((c) => ({
          id: c.id,
          title: c.doc_title,
          origin: c.origin,
          score: Number(c.score.toFixed(4)),
        })),
      },
    });
  } catch (err) {
    // Retrieval failure is not fatal: it removes the runbook support that the
    // decision branch requires, so the ticket escalates on its own.
    await appendEvent(tenant, {
      ticket_id: ticket.id,
      actor: "system",
      kind: "error",
      payload: { stage: "retrieval", error: String(err) },
    });
  }

  // --- Decide ------------------------------------------------------------
  const matchedIncidentId = resolveIncidentHint(triage.duplicate_of_hint, ctx);
  const candidate = candidateActionFor(triage, ctx);
  const decision = decide({
    mode,
    settings,
    triage,
    kbTopScore: chunks[0]?.score ?? null,
    clarifyCount: ticket.clarify_count,
    matchedIncidentId,
    requesterVip: ctx.requester?.vip ?? false,
    requesterDepartment: ctx.requester?.department ?? null,
    injectionSuspected,
    candidateAction: candidate,
  });

  // The SLA clock can only be stamped once the priority is known, and
  // `applyTriage` stamps it from the row it locks rather than from `ticket`,
  // which was read before the model call. A requester who replied in the
  // meantime has been credited the wait, and the stamp has to carry it.
  const stamped = await applyTriage(
    tenant,
    ticket.id,
    {
      category: triage.category,
      subcategory: triage.subcategory,
      priority: triage.priority,
      confidence: triage.confidence,
      resolution_path: decision.path,
      status: decision.status,
      parent_incident_id: matchedIncidentId,
      injection_suspected: injectionSuspected,
      config_version: configVersion,
    },
    settings,
  );

  // The counterfactual, recorded whatever the mode. This is the table that
  // eventually tells you which categories are safe to automate.
  await recordShadow(tenant, {
    ticket_id: ticket.id,
    config_version: configVersion,
    agent_category: triage.category,
    agent_priority: triage.priority,
    agent_confidence: triage.confidence,
    agent_path: decision.intendedPath,
    agent_model: triageModel,
    agent_prompt_version: triagePromptVersion,
    prompt_vars: triagePromptVars,
    agent_security_sensitive: triage.is_security_sensitive,
    agent_destructive: triage.is_destructive_request,
  });

  await appendEvent(tenant, {
    ticket_id: ticket.id,
    actor: "agent",
    kind: "note",
    payload: {
      stage: "decision",
      rule: decision.rule,
      reason: decision.reason,
      // The three things a replay needs in order to reproduce this decision:
      // which prompt wrote it, which model ran it, and which configuration
      // judged it. Two of them were already recorded; the third is new.
      prompt_version: triagePromptVersion,
      model: triageModel,
      config_version: configVersion,
      mode,
      deployment_mode: env.AGENT_MODE,
      mode_override: settings.agent_mode_override,
      autonomy: decision.autonomy,
      confidence_threshold: decision.confidenceThreshold,
      intended_path: decision.intendedPath,
      intended_action: decision.intendedAction,
      effective_path: decision.path,
      effective_action: decision.action,
      kb_top_score: chunks[0]?.score ?? null,
      candidate_action: candidate?.tool ?? null,
      injection_suspected: injectionSuspected,
      sla_first_response_due: stamped?.first_response_due_at
        ? new Date(stamped.first_response_due_at).toISOString()
        : null,
      will_execute: decision.execute,
    },
  });

  // --- Draft & execute ---------------------------------------------------
  try {
    const draft = await produceDraft(
      business,
      settings,
      ticket,
      ctx,
      triage,
      chunks,
      decision,
      matchedIncidentId,
    );
    await carryOut(tenant, settings, ticket, triage, decision, draft, candidate, configVersion);
    return { ticketId, ok: true, triage, decision, draft: draft ?? undefined, chunks };
  } catch (err) {
    await appendEvent(tenant, {
      ticket_id: ticket.id,
      actor: "system",
      kind: "error",
      payload: { stage: "execute", error: String(err) },
    });
    await setStatus(tenant, ticket.id, "triaged");
    return { ticketId, ok: false, triage, decision, error: String(err) };
  }
}

async function produceDraft(
  business: Business,
  settings: BusinessSettings,
  ticket: Ticket,
  ctx: EnrichedContext,
  triage: TriageResult,
  chunks: RetrievedChunk[],
  decision: Decision,
  matchedIncidentId: string | null,
): Promise<Draft | null> {
  // Escalations get a summary written by the escalation path, not a reply.
  if (decision.intendedAction === "escalate") return null;

  if (decision.intendedAction === "link_incident") {
    const incident = ctx.incidents.find((i) => i.id === matchedIncidentId);
    return incident ? incidentAck(settings, incident) : null;
  }

  if (decision.intendedAction === "ask_question") {
    return draftQuestion(business, settings, ticket, triage);
  }

  return draftReply(business, settings, ticket, ctx, triage, chunks);
}

async function carryOut(
  tenant: TenantContext,
  settings: BusinessSettings,
  ticket: Ticket,
  triage: TriageResult,
  decision: Decision,
  draft: Draft | null,
  candidate: { tool: string; args: Record<string, unknown>; rationale: string } | null,
  configVersion: number | null,
): Promise<void> {
  const toolCtx: ToolContext = {
    tenant,
    ticketId: ticket.id,
  };
  const toolOpts = {
    whitelist: settings.auto_action_whitelist,
    agent: "helpdesk" as const,
    rationale: decision.reason,
  };

  if (decision.action === "escalate") {
    await executeTool(
      "ticket.escalate",
      {
        reason: `${decision.rule}: ${decision.reason}`,
        summary: escalationSummary(ticket, triage, decision),
        suggested_fix: candidate ? candidate.rationale : null,
        queue: routeQueue(triage.category, triage.priority, settings),
      },
      toolCtx,
      toolOpts,
    );
    return;
  }

  // Not permitted to contact anyone: park the draft for review. This is the
  // whole of phases 2 and 3, and most of phase 4.
  //
  // In the conversation, internal, as a draft (docs/conversation.md). It used
  // to be a `draft` event. A person sending it writes a new message derived
  // from it, so what the agent proposed and what was sent both stay on record.
  if (!decision.execute) {
    if (draft) {
      const templated = draft.model === null;
      await appendMessage(
        // A template has no model, so it is the system's words, not the agent's (C6).
        templated ? systemContext(tenant.businessId, { requestId: tenant.requestId }) : tenant,
        ticket.id,
        {
          kind: "draft",
          visibility: "internal",
          channel: "internal",
          body: draft.body,
          // The same words proposed twice are one draft.
          idempotencyKey: `draft:${ticket.id}:${sha256(draft.body)}`,
          ai: templated
            ? undefined
            : {
                model: draft.model!,
                promptVersion: draft.promptVersion,
                configVersion,
                sources: draft.sources,
                usage: { costUsd: draft.costUsd, latencyMs: draft.latencyMs },
              },
          metadata: {
            draft_kind: draft.kind,
            would_have: decision.intendedAction,
            rule: decision.rule,
            ...(templated ? { template: draft.kind } : {}),
          },
        },
      );
    }
    return;
  }

  if (decision.action === "run_action" && candidate) {
    try {
      await executeTool(candidate.tool, candidate.args, toolCtx, {
        ...toolOpts,
        rationale: candidate.rationale,
      });
    } catch (err) {
      if (err instanceof ApprovalRequiredError) {
        const tool = getTool(candidate.tool);
        const summary = tool?.summarize(candidate.args) ?? candidate.tool;
        const request = await requestApproval(tenant, {
          ticket_id: ticket.id,
          tool_name: candidate.tool,
          args: candidate.args,
          risk_tier: err.riskTier,
          rationale: candidate.rationale,
        });
        await appendEvent(tenant, {
          ticket_id: ticket.id,
          actor: "agent",
          kind: "approval",
          payload: {
            requested: candidate.tool,
            summary,
            risk_tier: err.riskTier,
          },
        });
        await setStatus(tenant, ticket.id, "awaiting_approval");

        // And tell the approvers. The request has carried a deadline since
        // approval expiry landed, and nobody was told it existed — so one
        // raised at 5pm expired overnight and read, from the ticket, exactly
        // like a refusal.
        await notifyApprovalRequest(tenant, {
          approvalId: request.id,
          ticketId: ticket.id,
          tool: candidate.tool,
          summary,
          rationale: candidate.rationale,
          riskTier: err.riskTier,
          expiresAt: request.expires_at,
        });
        return;
      }
      throw err;
    }
  }

  if (draft) {
    await executeTool(
      "ticket.send_reply",
      {
        body: draft.body,
        close_after: decision.action !== "ask_question",
        // What wrote the words (C6). A template names itself, and no model.
        provenance: {
          model: draft.model,
          template: draft.model === null ? draft.kind : null,
          prompt_version: draft.promptVersion,
          config_version: configVersion,
          sources: draft.sources,
          cost_usd: draft.costUsd,
          latency_ms: draft.latencyMs,
        },
      },
      toolCtx,
      toolOpts,
    );
    if (decision.action === "ask_question") {
      await incrementClarify(tenant, ticket.id);
      await setStatus(tenant, ticket.id, "awaiting_user");
    }
  }
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function escalationSummary(
  ticket: Ticket,
  triage: TriageResult,
  decision: Decision,
): string {
  return [
    `${triage.priority} ${triage.category}/${triage.subcategory} — ${ticket.subject}`,
    `Why the agent stopped: ${decision.reason}`,
    triage.affected_system ? `Affected system: ${triage.affected_system}` : null,
    triage.missing_info.length
      ? `Still unknown: ${triage.missing_info.join("; ")}`
      : null,
    `Agent reasoning: ${triage.reasoning}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function failToHuman(
  tenant: TenantContext,
  ticket: Ticket,
  err: unknown,
): Promise<PipelineResult> {
  const reason =
    err instanceof LLMUnavailableError
      ? "No model credentials configured"
      : err instanceof LLMCostCapError
        ? err.message
        : err instanceof LLMValidationError
          ? `Triage failed validation twice: ${err.message}`
          : String(err);

  await appendEvent(tenant, {
    ticket_id: ticket.id,
    actor: "system",
    kind: "error",
    payload: { stage: "triage", error: reason },
  });
  // Never let a malformed or missing triage silently default to P4.
  await setStatus(tenant, ticket.id, "triaged");
  return { ticketId: ticket.id, ok: false, error: reason };
}
