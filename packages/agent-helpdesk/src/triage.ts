import type { Business, Ticket } from "@hd/core";
import { env } from "@hd/core";
import { callStructured, triagePrompt } from "@hd/llm";
import {
  deviceLine,
  incidentsBlock,
  recentTicketsBlock,
  requesterLine,
  type EnrichedContext,
} from "./enrich.js";
import { prepareTicketInput, type PreparedInput } from "./input.js";
import { TriageWire, validateTriage, type TriageResult } from "./schema.js";

export interface TriageOutcome {
  triage: TriageResult;
  /** What redaction and the injection scan found on the way in. */
  input: PreparedInput;
  /**
   * The rendered context vars, minus the ticket block itself.
   *
   * Stored on the shadow record so an evaluation replay can rebuild the exact
   * prompt this classification saw. Enrichment is time-dependent — the
   * incidents open when the ticket arrived are not the incidents open now — so
   * a replay that re-enriches scores the model against a prompt it was never
   * given.
   */
  promptVars: Record<string, string>;
  promptVersion: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  attempts: number;
}

export async function triageTicket(
  business: Business,
  ticket: Ticket,
  ctx: EnrichedContext,
): Promise<TriageOutcome> {
  const system = triagePrompt.system({
    business_name: business.name,
    business_type: business.type,
  });

  const prepared = prepareTicketInput(ticket);

  // Everything except the ticket block, which is the requester's own text and
  // already stored (redacted) on the ticket. Keeping the two apart avoids a
  // second copy of untrusted content in a second table.
  const contextVars: Record<string, string> = {
    source: ticket.source,
    attachments:
      ticket.attachments.length > 0
        ? ticket.attachments.map((a) => a.filename).join(", ")
        : "none",
    requester_line: requesterLine(ctx),
    vip: String(ctx.requester?.vip ?? false),
    device_line: deviceLine(ctx),
    recent_tickets: recentTicketsBlock(ctx),
    active_incidents: incidentsBlock(ctx),
  };

  const user = triagePrompt.user({ ...contextVars, ticket_block: prepared.block });

  const result = await callStructured({
    schema: TriageWire,
    system,
    user,
    purpose: "triage",
    businessId: business.id,
    ticketId: ticket.id,
    model: env.TRIAGE_MODEL,
    effort: env.TRIAGE_EFFORT,
    maxTokens: 4000,
    validate: validateTriage,
  });

  return {
    triage: result.data,
    input: prepared,
    promptVars: {
      ...contextVars,
      business_name: business.name,
      business_type: business.type,
    },
    promptVersion: `${triagePrompt.name}@${triagePrompt.version}`,
    model: result.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    attempts: result.attempts,
  };
}
