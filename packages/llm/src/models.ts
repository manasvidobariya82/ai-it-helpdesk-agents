/**
 * Model catalogue and cost accounting. Prices are USD per million tokens.
 * Cache reads bill at ~0.1x input, cache writes at ~1.25x input.
 */
export interface ModelPrice {
  input: number;
  output: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-fable-5-1": { input: 10.0, output: 50.0 },
  // Embeddings, priced per million input tokens.
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
  hash: { input: 0, output: 0 },
};

/** Mirrors the SDK's `usage` shape, where the cache fields are nullable. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function costOf(model: string, usage: TokenUsage): number {
  const price = MODEL_PRICES[model];
  if (!price) return 0; // Unknown model: report zero rather than invent a number.
  const perToken = price.input / 1_000_000;
  return (
    usage.input_tokens * perToken +
    usage.output_tokens * (price.output / 1_000_000) +
    (usage.cache_read_input_tokens ?? 0) * perToken * 0.1 +
    (usage.cache_creation_input_tokens ?? 0) * perToken * 1.25
  );
}
