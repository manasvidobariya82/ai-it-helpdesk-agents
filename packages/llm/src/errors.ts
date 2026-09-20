export class LLMUnavailableError extends Error {
  constructor(message = "No Anthropic credentials configured") {
    super(message);
    this.name = "LLMUnavailableError";
  }
}

/** The model produced output that failed schema validation twice. */
export class LLMValidationError extends Error {
  constructor(
    message: string,
    readonly issues: unknown,
    readonly rawOutput: unknown,
  ) {
    super(message);
    this.name = "LLMValidationError";
  }
}

/** Per-tenant daily spend ceiling hit. Fails loudly; never degrades silently. */
export class LLMCostCapError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly capUsd: number,
  ) {
    super(`Daily model spend cap reached: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)}`);
    this.name = "LLMCostCapError";
  }
}

/** The model declined the request (stop_reason: "refusal"). */
export class LLMRefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`Model refused the request (category: ${category ?? "unknown"})`);
    this.name = "LLMRefusalError";
  }
}
