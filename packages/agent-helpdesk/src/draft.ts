import type { Business, BusinessSettings, Requester, Ticket } from "@hd/core";
import { callText, clarifyPrompt, replyPrompt } from "@hd/llm";
import { formatExcerpts, type RetrievedChunk } from "@hd/rag";
import { requesterLine } from "./enrich.js";
import { prepareTicketInput } from "./input.js";
import type { TriageResult } from "./schema.js";

export interface Draft {
  body: string;
  kind: "reply" | "question" | "incident_ack";
  sources: { title: string; url: string | null; score: number }[];
  model: string | null;
  /** `name@version` of the prompt that wrote it, as triage records its own. Null for a template. */
  promptVersion: string | null;
  costUsd: number;
  latencyMs: number;
}

/**
 * What a draft reads from the ticket. `id` attributes the model call's cost to
 * the ticket, and is null when no ticket row stands behind the words, as in a
 * golden-set run.
 */
export type DraftTicket = Pick<Ticket, "subject" | "body"> & { id: string | null };

export interface DraftOptions {
  /** The usage purpose the call is billed under. `draft` on the live path. */
  purpose?: string;
}

export async function draftReply(
  business: Pick<Business, "id" | "name">,
  settings: BusinessSettings,
  ticket: DraftTicket,
  ctx: { requester: Pick<Requester, "email" | "full_name" | "department" | "role"> | null },
  triage: TriageResult,
  chunks: RetrievedChunk[],
  opts: DraftOptions = {},
): Promise<Draft> {
  const result = await callText({
    system: replyPrompt.system({ business_name: business.name }),
    user: replyPrompt.user({
      requester_line: requesterLine(ctx),
      ticket_block: prepareTicketInput(ticket).block,
      category: triage.category,
      subcategory: triage.subcategory,
      priority: triage.priority,
      kb_excerpts: formatExcerpts(chunks),
      signature: settings.signature,
    }),
    purpose: opts.purpose ?? "draft",
    businessId: business.id,
    ticketId: ticket.id,
    maxTokens: 1500,
  });

  return {
    body: result.text,
    kind: "reply",
    sources: chunks.map((c) => ({ title: c.doc_title, url: c.source_url, score: c.score })),
    model: result.model,
    promptVersion: `${replyPrompt.name}@${replyPrompt.version}`,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
  };
}

export async function draftQuestion(
  business: Pick<Business, "id">,
  settings: BusinessSettings,
  ticket: DraftTicket,
  triage: TriageResult,
  opts: DraftOptions = {},
): Promise<Draft> {
  const result = await callText({
    system: clarifyPrompt.system({}),
    user: clarifyPrompt.user({
      ticket_block: prepareTicketInput(ticket).block,
      missing_info: triage.missing_info.map((m, i) => `${i + 1}. ${m}`).join("\n"),
      signature: settings.signature,
    }),
    purpose: opts.purpose ?? "draft",
    businessId: business.id,
    ticketId: ticket.id,
    maxTokens: 400,
  });

  return {
    body: result.text,
    kind: "question",
    sources: [],
    model: result.model,
    promptVersion: `${clarifyPrompt.name}@${clarifyPrompt.version}`,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
  };
}

/**
 * Incident acknowledgements are templated, not generated. There is nothing for
 * a model to add, the wording matters during an outage, and it is one fewer
 * call multiplied by however many people are reporting the same thing.
 */
export function incidentAck(
  settings: BusinessSettings,
  incident: Pick<Ticket, "subject">,
): Draft {
  const body = [
    `We are already tracking this. It is a known issue affecting ${incident.subject.toLowerCase()}.`,
    "",
    "You do not need to do anything. This ticket is linked to the main incident and you will be updated there as it progresses.",
    "",
    settings.signature,
  ].join("\n");

  return {
    body,
    kind: "incident_ack",
    sources: [],
    model: null,
    promptVersion: null,
    costUsd: 0,
    latencyMs: 0,
  };
}
