import { describe, expect, it } from "vitest";
import { TriageWire, validateTriage, type TriageResult } from "../src/schema.js";

const valid: TriageResult = {
  category: "network_connectivity",
  subcategory: "VPN certificate expired",
  priority: "P2",
  confidence: 0.91,
  is_security_sensitive: false,
  is_destructive_request: false,
  affected_system: "GlobalProtect",
  missing_info: [],
  duplicate_of_hint: null,
  reasoning: "Explicit certificate error, documented cause, single user blocked.",
};

describe("wire schema", () => {
  it("accepts a well-formed triage", () => {
    expect(TriageWire.safeParse(valid).success).toBe(true);
  });

  it("rejects an unknown category rather than coercing it", () => {
    const result = TriageWire.safeParse({ ...valid, category: "printer_problems" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing field rather than defaulting it", () => {
    const { priority, ...withoutPriority } = valid;
    expect(TriageWire.safeParse(withoutPriority).success).toBe(false);
  });
});

describe("post-parse bounds", () => {
  it("passes a valid object", () => {
    expect(() => validateTriage(valid)).not.toThrow();
  });

  it("rejects confidence outside 0..1", () => {
    expect(() => validateTriage({ ...valid, confidence: 1.4 })).toThrow(/between 0 and 1/);
    expect(() => validateTriage({ ...valid, confidence: -0.1 })).toThrow(/between 0 and 1/);
  });

  it("caps missing_info at three entries", () => {
    expect(() =>
      validateTriage({ ...valid, missing_info: ["a", "b", "c", "d"] }),
    ).toThrow(/at most 3/);
  });

  it("rejects empty missing_info entries", () => {
    expect(() => validateTriage({ ...valid, missing_info: ["   "] })).toThrow(
      /empty strings/,
    );
  });

  it("enforces the security priority floor stated in the prompt", () => {
    expect(() =>
      validateTriage({ ...valid, is_security_sensitive: true, priority: "P4" }),
    ).toThrow(/must be P1 or P2/);
    expect(() =>
      validateTriage({ ...valid, is_security_sensitive: true, priority: "P2" }),
    ).not.toThrow();
  });

  it("reports every problem at once so one retry can fix them all", () => {
    try {
      validateTriage({
        ...valid,
        confidence: 2,
        missing_info: ["a", "b", "c", "d"],
        reasoning: "x".repeat(500),
      });
      throw new Error("should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/confidence/);
      expect(message).toMatch(/missing_info/);
      expect(message).toMatch(/reasoning/);
    }
  });
});
