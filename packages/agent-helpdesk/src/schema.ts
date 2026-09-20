import { TicketCategory, TicketPriority } from "@hd/core";
import { z } from "zod";

/**
 * The wire schema is deliberately types-and-enums only.
 *
 * Constrained decoding is reliable for shapes and enums; it is not the place
 * to express "at most 3 items" or "confidence between 0 and 1". Those are
 * validated after parsing by `validateTriage`, which throws, which triggers
 * the gateway's one retry with the error attached. A bound that the model
 * cannot see is a bound the model cannot correct.
 */
export const TriageWire = z.object({
  category: TicketCategory.describe("Single best category for this ticket."),
  subcategory: z
    .string()
    .describe("Free-text refinement, at most 60 characters. e.g. 'MFA device lost'."),
  priority: TicketPriority.describe("P1 to P4 by actual work impact."),
  confidence: z
    .number()
    .describe("0 to 1. How sure you are that BOTH category and priority are right."),
  is_security_sensitive: z
    .boolean()
    .describe("Credentials, phishing, malware, unexpected access, data exposure, lost device."),
  is_destructive_request: z
    .boolean()
    .describe("Fulfilling this would delete data, remove access, wipe a device, or change a security control."),
  affected_system: z
    .string()
    .nullable()
    .describe("Named system from the ticket text, or null. Never invent one."),
  missing_info: z
    .array(z.string())
    .describe("Up to 3 specific facts the requester could actually supply. Empty if none needed."),
  duplicate_of_hint: z
    .string()
    .nullable()
    .describe("Id of an active incident from the context block, or null."),
  reasoning: z.string().describe("At most 400 characters. Why this category and priority."),
});

export type TriageResult = z.infer<typeof TriageWire>;

/** Post-parse bounds. Throwing here is how the gateway learns to retry. */
export function validateTriage(t: TriageResult): void {
  const problems: string[] = [];

  if (!(t.confidence >= 0 && t.confidence <= 1)) {
    problems.push(`confidence must be between 0 and 1, got ${t.confidence}`);
  }
  if (t.subcategory.length > 60) {
    problems.push(`subcategory must be at most 60 characters, got ${t.subcategory.length}`);
  }
  if (t.missing_info.length > 3) {
    problems.push(`missing_info must have at most 3 entries, got ${t.missing_info.length}`);
  }
  if (t.missing_info.some((m) => m.trim().length === 0)) {
    problems.push("missing_info must not contain empty strings");
  }
  if (t.reasoning.length > 400) {
    problems.push(`reasoning must be at most 400 characters, got ${t.reasoning.length}`);
  }
  // The prompt states this rule, so a violation is a real error, not a nudge.
  if (t.is_security_sensitive && (t.priority === "P3" || t.priority === "P4")) {
    problems.push(
      `is_security_sensitive is true, so priority must be P1 or P2, got ${t.priority}`,
    );
  }

  if (problems.length) throw new Error(problems.join("; "));
}
