import {
  agentContext,
  appendEvent,
  eventsFor,
  getBusiness,
  getTicketUnscoped,
  threadFor,
  type TenantContext,
  type Ticket,
} from "@hd/core";
import { callText, writebackPrompt } from "@hd/llm";
import { ingestDocument, retrieve } from "@hd/rag";
import { prepareTicketInput, prepareText } from "./input.js";

export interface WritebackResult {
  ticketId: string;
  written: boolean;
  docId?: string;
  reason?: string;
}

/**
 * The feedback loop that makes month three better than month one: a resolved
 * ticket becomes a retrievable knowledge base entry.
 *
 * Two guards matter here. Entries are stripped of anything identifying a
 * person before they are embedded, because they will be retrieved into future
 * prompts for other requesters. And a near-identical existing chunk is marked
 * superseded rather than left to compete - two versions of the same fix in the
 * index is how the agent ends up confidently giving last year's instructions.
 */
export async function writeBackResolution(
  tenant: TenantContext | null,
  ticketId: string,
): Promise<WritebackResult> {
  // Writeback runs both from the follow-up sweep, which already holds a
  // context, and from a queue job that has only an id. The second case resolves
  // the tenant from the ticket exactly once, here, and everything downstream is
  // scoped by the result.
  const ticket = await getTicketUnscoped(ticketId);
  if (!ticket) return { ticketId, written: false, reason: "ticket not found" };
  const ctx =
    tenant ??
    agentContext(ticket.business_id, { requestId: `writeback:${ticketId}` });
  if (ticket.business_id !== ctx.businessId) {
    return { ticketId, written: false, reason: "ticket not found" };
  }
  if (!ticket.category) return { ticketId, written: false, reason: "never triaged" };

  const business = await getBusiness(ticket.business_id);
  if (!business) return { ticketId, written: false, reason: "business not found" };

  const thread = await resolutionThread(ctx, ticket);
  if (!thread.trim()) {
    return { ticketId, written: false, reason: "no resolution content" };
  }

  const result = await callText({
    system: writebackPrompt.system({}),
    user: writebackPrompt.user({
      category: ticket.category,
      subcategory: ticket.subcategory ?? "",
      ticket_block: prepareTicketInput(ticket).block,
      // The thread contains the agent's own replies as well as the
      // requester's, and this text is about to be embedded and retrieved into
      // other people's prompts. It gets the same treatment.
      thread: prepareText("resolution-thread", thread).block,
    }),
    purpose: "writeback",
    businessId: business.id,
    ticketId: ticket.id,
    maxTokens: 1200,
  });

  if (result.text.includes("NO_REUSABLE_CONTENT")) {
    await appendEvent(ctx, {
      ticket_id: ticket.id,
      actor: "agent",
      kind: "note",
      payload: { stage: "writeback", skipped: "no reusable content" },
      model: result.model,
      cost_usd: result.costUsd,
    });
    return { ticketId, written: false, reason: "no reusable content" };
  }

  // Anything this close to the new entry is the same fix, older.
  const neighbours = await retrieve(ctx, {
    queryText: result.text,
    categories: [ticket.category],
    limit: 3,
    floor: 0.9,
  });
  const supersedes = neighbours
    .filter((n) => n.origin === "resolved_ticket")
    .map((n) => n.id);

  const title = `${ticket.category}: ${ticket.subcategory ?? ticket.subject}`.slice(0, 120);
  const ingested = await ingestDocument(ctx, {
    title,
    content: result.text,
    origin: "resolved_ticket",
    categories: [ticket.category],
    supersedes,
  });

  await appendEvent(ctx, {
    ticket_id: ticket.id,
    actor: "agent",
    kind: "note",
    payload: {
      stage: "writeback",
      doc_id: ingested.docId,
      chunks: ingested.chunks,
      superseded: supersedes,
      skipped_duplicate: ingested.skipped,
    },
    model: result.model,
    cost_usd: result.costUsd,
    latency_ms: result.latencyMs,
  });

  return { ticketId, written: !ingested.skipped, docId: ingested.docId };
}

/**
 * What was said and done on the ticket, in the order it happened.
 *
 * The words come from the conversation (docs/conversation.md): what the
 * requester and the desk said, and the agent's drafts, as they were read from
 * the event log before the conversation existed. Internal notes are left out.
 * They are the desk talking to itself, and this text becomes a knowledge base
 * entry that is retrieved into replies to other requesters. What was done
 * comes from the event log, which is still where tool calls live.
 */
async function resolutionThread(
  ctx: TenantContext,
  ticket: Ticket,
): Promise<string> {
  const [thread, events] = await Promise.all([
    threadFor(ctx, ticket.id),
    eventsFor(ctx, ticket.id),
  ]);

  const lines: { at: number; line: string }[] = [];
  for (const m of thread) {
    if (m.kind === "draft") {
      lines.push({ at: m.at.getTime(), line: `[draft] ${m.body}` });
    } else if (m.kind === "message" && m.visibility === "public") {
      lines.push({ at: m.at.getTime(), line: `[${m.from}] ${m.body}` });
    }
  }
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    const at = new Date(e.created_at).getTime();
    if (e.kind === "tool_call") {
      lines.push({
        at,
        line: `[tool] ${String(p.tool_name ?? "")} ${JSON.stringify(p.args ?? {})}`,
      });
    } else if (e.kind === "note" && p.stage !== "decision") {
      lines.push({ at, line: `[note] ${JSON.stringify(p)}` });
    }
  }
  // Stable, so two lines at the same instant keep the order they were read in.
  return lines
    .sort((a, b) => a.at - b.at)
    .map((l) => l.line)
    .join("\n\n");
}
