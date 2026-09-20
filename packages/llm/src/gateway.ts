import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { env, recordUsage, spendToday } from "@hd/core";
import type { z } from "zod";
import {
  LLMCostCapError,
  LLMRefusalError,
  LLMUnavailableError,
  LLMValidationError,
} from "./errors.js";
import { costOf } from "./models.js";

let clientRef: Anthropic | null = null;

/**
 * One wrapper for every model call in the platform. Feature code never
 * constructs a client: schema validation, retries, token accounting and the
 * per-tenant cost cap all live here so they cannot be skipped by accident,
 * and swapping models is a change in one file.
 */
export function client(): Anthropic {
  if (!clientRef) {
    // The SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
    // `ant auth login` profile on its own.
    clientRef = new Anthropic();
  }
  return clientRef;
}

export function credentialsConfigured(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface StructuredCallOptions<S extends z.ZodType> {
  /** Wire schema. Keep it types-and-enums; enforce bounds in `validate`. */
  schema: S;
  /** Stable across calls, so it caches. Volatile context goes in `user`. */
  system: string;
  user: string;
  purpose: string;
  businessId: string | null;
  ticketId?: string | null;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  /** Applied after schema parse; throwing here triggers the one retry. */
  validate?: (value: z.infer<S>) => void;
}

export interface StructuredCallResult<T> {
  data: T;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  latencyMs: number;
  attempts: number;
}

/**
 * A structured model call that either returns schema-valid data or throws.
 * There is deliberately no best-effort middle ground: a malformed triage that
 * silently defaults to P4 is worse than a triage that fails loudly and sends
 * the ticket to a human.
 */
export async function callStructured<S extends z.ZodType>(
  opts: StructuredCallOptions<S>,
): Promise<StructuredCallResult<z.infer<S>>> {
  if (!credentialsConfigured()) throw new LLMUnavailableError();

  const model = opts.model ?? env.TRIAGE_MODEL;
  const cap = env.LLM_DAILY_COST_CAP_USD;
  const spent = await spendToday(opts.businessId);
  if (spent >= cap) throw new LLMCostCapError(spent, cap);

  const started = Date.now();
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let costUsd = 0;
  let attempts = 0;
  let lastError: LLMValidationError | null = null;

  // The retry appends the validation error as a new turn, which keeps the
  // cached system prefix intact.
  const turns: Anthropic.MessageParam[] = [{ role: "user", content: opts.user }];

  try {
    while (attempts < 2) {
      attempts += 1;
      const response = await client().messages.parse({
        model,
        max_tokens: opts.maxTokens ?? 4000,
        system: [
          {
            type: "text",
            text: opts.system,
            cache_control: { type: "ephemeral" },
          },
        ],
        output_config: {
          format: zodOutputFormat(opts.schema),
          effort: opts.effort ?? env.TRIAGE_EFFORT,
        },
        messages: turns,
      });

      const u = response.usage;
      tokensIn += u.input_tokens;
      tokensOut += u.output_tokens;
      cacheRead += u.cache_read_input_tokens ?? 0;
      cacheWrite += u.cache_creation_input_tokens ?? 0;
      costUsd += costOf(model, u);

      if (response.stop_reason === "refusal") {
        throw new LLMRefusalError(response.stop_details?.category ?? null);
      }

      const parsed = response.parsed_output as z.infer<S> | null;
      if (parsed === null || parsed === undefined) {
        lastError = new LLMValidationError(
          "Model output did not parse against the schema",
          null,
          response.content,
        );
      } else {
        try {
          opts.validate?.(parsed);
          return {
            data: parsed,
            model,
            tokensIn,
            tokensOut,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            costUsd,
            latencyMs: Date.now() - started,
            attempts,
          };
        } catch (err) {
          lastError = new LLMValidationError(
            err instanceof Error ? err.message : String(err),
            err,
            parsed,
          );
        }
      }

      if (attempts < 2) {
        turns.push(
          {
            role: "assistant",
            content: JSON.stringify(lastError.rawOutput ?? {}),
          },
          {
            role: "user",
            content: [
              `That response was rejected by the validator: ${lastError.message}`,
              "Return a corrected object. Change only what the error names.",
            ].join("\n"),
          },
        );
      }
    }
    throw (
      lastError ?? new LLMValidationError("Unknown validation failure", null, null)
    );
  } finally {
    await recordUsage({
      business_id: opts.businessId,
      ticket_id: opts.ticketId ?? null,
      purpose: opts.purpose,
      model,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      cost_usd: costUsd,
      latency_ms: Date.now() - started,
      ok: lastError === null,
      error: lastError?.message ?? null,
    }).catch((err) => console.error("[llm] failed to record usage", err));
  }
}

export interface TextCallOptions {
  system: string;
  user: string;
  purpose: string;
  businessId: string | null;
  ticketId?: string | null;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
}

export interface TextCallResult {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
}

/** Free-text generation (reply drafting). Same accounting, no schema. */
export async function callText(opts: TextCallOptions): Promise<TextCallResult> {
  if (!credentialsConfigured()) throw new LLMUnavailableError();

  const model = opts.model ?? env.DRAFT_MODEL;
  const spent = await spendToday(opts.businessId);
  if (spent >= env.LLM_DAILY_COST_CAP_USD) {
    throw new LLMCostCapError(spent, env.LLM_DAILY_COST_CAP_USD);
  }

  const started = Date.now();
  const response = await client().messages.create({
    model,
    max_tokens: opts.maxTokens ?? 2000,
    system: [
      { type: "text", text: opts.system, cache_control: { type: "ephemeral" } },
    ],
    output_config: { effort: opts.effort ?? "low" },
    messages: [{ role: "user", content: opts.user }],
  });

  if (response.stop_reason === "refusal") {
    throw new LLMRefusalError(response.stop_details?.category ?? null);
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const costUsd = costOf(model, response.usage);
  const latencyMs = Date.now() - started;

  await recordUsage({
    business_id: opts.businessId,
    ticket_id: opts.ticketId ?? null,
    purpose: opts.purpose,
    model,
    tokens_in: response.usage.input_tokens,
    tokens_out: response.usage.output_tokens,
    cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
    cache_write_tokens: response.usage.cache_creation_input_tokens ?? 0,
    cost_usd: costUsd,
    latency_ms: latencyMs,
  }).catch((err) => console.error("[llm] failed to record usage", err));

  return {
    text,
    model,
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
    costUsd,
    latencyMs,
  };
}
