import {
  prepareText,
  TriageWire,
  validateTriage,
  type TriageResult,
} from "@hd/agent-helpdesk";
import { env } from "@hd/core";
import { callStructured, triagePrompt } from "@hd/llm";
import type { ScoredSample } from "./report.js";
import type { GoldenInput, GoldenSample } from "./sample.js";

/**
 * Re-run triage over a frozen dataset with the current prompt and model.
 *
 * This is the half of the harness that answers "did that prompt edit help".
 * Scoring `triage_shadow` tells you how the classifier performed on the
 * traffic it saw; replay tells you how *this* version performs on a fixed set,
 * which is the only comparison that survives a change in the ticket mix.
 *
 * It costs real money and real tokens, so it runs on demand rather than on
 * every ticket, and the CLI prints the spend.
 */

export interface ReplayOptions {
  model?: string;
  /** Requests in flight at once. The gateway's cost cap is still per tenant. */
  concurrency?: number;
  /** Tenant to bill and to attribute the usage rows to. */
  businessId: string | null;
  onProgress?: (done: number, total: number) => void;
}

export interface ReplayFailure {
  id: string;
  error: string;
}

export interface ReplayRun {
  scored: ScoredSample[];
  failures: ReplayFailure[];
  model: string;
  prompt_version: string;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  /** Samples whose context was rebuilt rather than captured. */
  reconstructed: number;
}

export async function replayDataset(
  samples: readonly GoldenSample[],
  opts: ReplayOptions,
): Promise<ReplayRun> {
  const model = opts.model ?? env.TRIAGE_MODEL;
  const concurrency = Math.max(1, opts.concurrency ?? 4);

  const scored: ScoredSample[] = [];
  const failures: ReplayFailure[] = [];
  let costUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let latencyMs = 0;
  let done = 0;

  const queue = [...samples];
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const sample = queue.shift();
      if (!sample) return;
      try {
        const result = await replayOne(sample, { model, businessId: opts.businessId });
        costUsd += result.costUsd;
        tokensIn += result.tokensIn;
        tokensOut += result.tokensOut;
        latencyMs += result.latencyMs;
        scored.push(result.scored);
      } catch (err) {
        // A failed call is a failed sample, not a zero score. Counting it as a
        // miss would blame the classifier for an outage.
        failures.push({
          id: sample.id,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        done += 1;
        opts.onProgress?.(done, samples.length);
      }
    }
  });

  await Promise.all(workers);
  scored.sort((a, b) => a.id.localeCompare(b.id));

  return {
    scored,
    failures,
    model,
    prompt_version: `${triagePrompt.name}@${triagePrompt.version}`,
    cost_usd: costUsd,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    latency_ms: latencyMs,
    reconstructed: samples.filter((s) => s.input.fidelity === "reconstructed").length,
  };
}

async function replayOne(
  sample: GoldenSample,
  opts: { model: string; businessId: string | null },
): Promise<{
  scored: ScoredSample;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}> {
  const result = await replayTriage(sample.input, { ...opts, purpose: "eval_replay" });

  return {
    scored: {
      id: sample.id,
      predicted: {
        category: result.triage.category,
        priority: result.triage.priority,
        confidence: result.triage.confidence,
        is_security_sensitive: result.triage.is_security_sensitive,
        is_destructive_request: result.triage.is_destructive_request,
      },
      actual: sample.label,
    },
    costUsd: result.costUsd,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    latencyMs: result.latencyMs,
  };
}

export interface ReplayedTriage {
  triage: TriageResult;
  model: string;
  prompt_version: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

/**
 * One triage call on frozen input, exactly as the live path makes it.
 *
 * Shared by `replay` and the golden-set runner, so both score the classifier
 * on the prompt production sends: the same system prompt, the same scan,
 * redaction and fence on the requester's text, the same schema and validator.
 */
export async function replayTriage(
  input: GoldenInput,
  opts: { model?: string; businessId: string | null; purpose?: string },
): Promise<ReplayedTriage> {
  const model = opts.model ?? env.TRIAGE_MODEL;
  const system = triagePrompt.system({
    business_name: input.business_name,
    business_type: input.business_type,
  });

  // Same treatment the live path gives requester text: scan, redact, fence.
  // Replaying raw text would score the model on a prompt production never
  // sends, and would put unredacted content through the gateway besides.
  const prepared = prepareText("ticket", `Subject: ${input.subject}

${input.body}`);

  const result = await callStructured({
    schema: TriageWire,
    system,
    user: triageUserPrompt(input, prepared.block),
    purpose: opts.purpose ?? "eval_replay",
    businessId: opts.businessId,
    ticketId: null,
    model,
    effort: env.TRIAGE_EFFORT,
    maxTokens: 4000,
    validate: validateTriage,
  });

  return {
    triage: result.data,
    model: result.model,
    prompt_version: `${triagePrompt.name}@${triagePrompt.version}`,
    costUsd: result.costUsd,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    latencyMs: result.latencyMs,
  };
}

/** The triage user message for frozen input, around an already-fenced ticket block. */
export function triageUserPrompt(input: GoldenInput, ticketBlock: string): string {
  return triagePrompt.user({
    source: input.source,
    ticket_block: ticketBlock,
    attachments: input.attachments.length > 0 ? input.attachments.join(", ") : "none",
    requester_line: input.requester_line,
    vip: String(input.vip),
    device_line: input.device_line,
    recent_tickets: input.recent_tickets,
    active_incidents: input.active_incidents,
  });
}
