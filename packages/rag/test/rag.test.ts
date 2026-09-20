import { describe, expect, it } from "vitest";
import { chunkDocument } from "../src/chunk.js";
import { embed, embedOne, toVectorLiteral } from "../src/embed.js";

const cosine = (a: number[], b: number[]): number =>
  a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);

describe("chunker", () => {
  it("splits on headings so a chunk is one procedure", () => {
    const chunks = chunkDocument(
      `# Title\nIntro line.\n\n## Step one\nDo the thing.\n\n## Step two\nDo the other thing.`,
    );
    expect(chunks).toHaveLength(3);
    expect(chunks[1]!.content).toContain("Step one");
    expect(chunks[2]!.content).toContain("Step two");
  });

  it("packs long sections without losing text", () => {
    const para = "Sentence about the runbook. ".repeat(30);
    const chunks = chunkDocument(`## Long\n\n${para}\n\n${para}\n\n${para}`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length < 2000)).toBe(true);
  });

  it("returns nothing for empty input", () => {
    expect(chunkDocument("   \n\n  ")).toEqual([]);
  });

  it("numbers chunks in document order", () => {
    const chunks = chunkDocument(`# A\nx\n\n# B\ny\n\n# C\nz`);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
  });
});

describe("hash embedder", () => {
  it("is deterministic across calls", async () => {
    const a = await embedOne("VPN certificate expired");
    const b = await embedOne("VPN certificate expired");
    expect(a).toEqual(b);
  });

  it("produces unit vectors of the schema width", async () => {
    const v = await embedOne("password reset for a locked account");
    expect(v).toHaveLength(1536);
    expect(cosine(v, v)).toBeCloseTo(1, 5);
  });

  it("ranks a related document above an unrelated one", async () => {
    const query = await embedOne("my password expired and I cannot sign in");
    const { vectors } = await embed([
      "Password reset and expiry. The password expired after 90 days; use self-service reset to sign in again.",
      "Teams call audio cuts out when using a bluetooth headset on congested wifi.",
    ]);
    expect(cosine(query, vectors[0]!)).toBeGreaterThan(cosine(query, vectors[1]!));
  });

  it("survives an all-stopword document", async () => {
    const v = await embedOne("the and for are but not");
    expect(cosine(v, v)).toBeCloseTo(1, 5);
  });
});

describe("vector literal", () => {
  it("formats for pgvector", () => {
    expect(toVectorLiteral([0.5, -0.25])).toBe("[0.500000,-0.250000]");
  });

  it("does not emit NaN into SQL", () => {
    expect(toVectorLiteral([Number.NaN, Infinity])).toBe("[0,0]");
  });
});
