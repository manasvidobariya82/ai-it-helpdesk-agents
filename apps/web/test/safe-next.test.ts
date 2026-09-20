import { describe, expect, it } from "vitest";
import { safeNext } from "../lib/safe-next";

describe("safeNext", () => {
  it("keeps a path on this site", () => {
    expect(safeNext("/tickets/abc?tab=events")).toBe("/tickets/abc?tab=events");
    expect(safeNext("/")).toBe("/");
  });

  it("falls back to the queue when there is nothing to go back to", () => {
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext(null)).toBe("/");
    expect(safeNext("")).toBe("/");
  });

  it("refuses anything a browser would take off-site", () => {
    for (const next of [
      "https://evil.example/login",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
    ]) {
      expect(safeNext(next)).toBe("/");
    }
  });
});
