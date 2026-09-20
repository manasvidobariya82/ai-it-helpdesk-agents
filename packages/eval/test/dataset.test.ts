import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assignSplit,
  baselineFrom,
  compareToBaseline,
  datasetId,
  loadDataset,
  mergeSamples,
  saveDataset,
  scoreRun,
  type GoldenSample,
  type ScoredSample,
} from "@hd/eval";

function golden(id: string, category: string, over?: Partial<GoldenSample>): GoldenSample {
  return {
    id,
    business_id: "b1",
    created_at: "2026-09-01T00:00:00.000Z",
    split: assignSplit(id),
    status: "reviewed",
    label_source: "human_correction",
    labeler: "reviewer@example.com",
    reviewed_at: "2026-09-02T00:00:00.000Z",
    label_version: "v1",
    input: {
      source: "email",
      subject: `subject ${id}`,
      body: `body ${id}`,
      attachments: [],
      requester_line: "",
      vip: false,
      device_line: "",
      recent_tickets: "",
      active_incidents: "",
      business_name: "Acme",
      business_type: "it_services",
      fidelity: "captured",
    },
    label: {
      category,
      priority: "P3",
      team: "tier1",
      path: null,
      is_security_sensitive: null,
      is_destructive_request: null,
    },
    recorded: null,
    note: null,
    ...over,
  };
}

const tmpFiles: string[] = [];
async function tmpFile(): Promise<string> {
  const file = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "hd-eval-")),
    "golden.jsonl",
  );
  tmpFiles.push(file);
  return file;
}

afterEach(async () => {
  await Promise.all(
    tmpFiles.splice(0).map((f) => fs.rm(path.dirname(f), { recursive: true, force: true })),
  );
});

describe("assignSplit", () => {
  it("is stable for the same id", () => {
    expect(assignSplit("ticket-a")).toBe(assignSplit("ticket-a"));
  });

  it("does not reshuffle when the dataset grows", () => {
    // The whole point of hashing rather than sampling: a sample that was
    // holdout last month is holdout today, so "held out of prompt iteration"
    // survives the set doubling in size.
    const ids = Array.from({ length: 200 }, (_v, i) => `t${i}`);
    const before = new Map(ids.map((id) => [id, assignSplit(id)]));
    const after = new Map(
      [...ids, ...Array.from({ length: 200 }, (_v, i) => `new${i}`)].map((id) => [
        id,
        assignSplit(id),
      ]),
    );
    for (const id of ids) expect(after.get(id)).toBe(before.get(id));
  });

  it("lands roughly on the requested proportion", () => {
    const ids = Array.from({ length: 1000 }, (_v, i) => `ticket-${i}`);
    const holdout = ids.filter((id) => assignSplit(id, 30) === "holdout").length;
    expect(holdout).toBeGreaterThan(240);
    expect(holdout).toBeLessThan(360);
  });
});

describe("dataset round trip", () => {
  it("writes and reads back the same samples", async () => {
    const file = await tmpFile();
    const samples = [golden("b", "hardware"), golden("a", "software")];
    const saved = await saveDataset(file, samples);
    const loaded = await loadDataset(file);

    expect(loaded.errors).toEqual([]);
    expect(loaded.samples.map((s) => s.id)).toEqual(["a", "b"]);
    expect(loaded.dataset_id).toBe(saved.dataset_id);
  });

  it("reports malformed lines instead of dropping them", async () => {
    const file = await tmpFile();
    await saveDataset(file, [golden("a", "hardware")]);
    await fs.appendFile(file, "{not json}\n", "utf8");

    const loaded = await loadDataset(file);
    expect(loaded.samples).toHaveLength(1);
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.errors[0]!.line).toBe(2);
  });

  it("changes the dataset id when a label changes", () => {
    const a = [golden("1", "hardware")];
    const b = [golden("1", "software")];
    expect(datasetId(a)).not.toBe(datasetId(b));
  });
});

describe("mergeSamples", () => {
  it("keeps a hand-corrected label over a fresh export", () => {
    // An export that overwrote reviewed labels would undo exactly the work the
    // harness exists to consume.
    const existing = [golden("1", "security_incident", { note: "checked by hand" })];
    const incoming = [golden("1", "other")];
    const { merged, added, skipped } = mergeSamples(existing, incoming);

    expect(added).toBe(0);
    expect(skipped).toBe(1);
    expect(merged[0]!.label.category).toBe("security_incident");
    expect(merged[0]!.note).toBe("checked by hand");
  });

  it("adds genuinely new ids with a derived split", () => {
    const { merged, added } = mergeSamples([golden("1", "hardware")], [
      golden("2", "software"),
    ]);
    expect(added).toBe(1);
    expect(merged.map((s) => s.id)).toEqual(["1", "2"]);
    expect(merged[1]!.split).toBe(assignSplit("2"));
  });
});

describe("baseline comparison", () => {
  const scored = (correctOf: number, total: number): ScoredSample[] =>
    Array.from({ length: total }, (_v, i) => ({
      id: `t${i}`,
      predicted: { category: "hardware", priority: "P3", confidence: 0.9, team: "tier1" },
      actual: {
        category: i < correctOf ? "hardware" : "software",
        priority: "P3",
        team: "tier1",
        path: null,
        is_security_sensitive: null,
        is_destructive_request: null,
      },
    }));

  it("passes when the metrics hold", () => {
    const base = baselineFrom(
      scoreRun(scored(90, 100), { model: "m1", promptVersion: "p1" }),
      "pinned",
    );
    const next = scoreRun(scored(91, 100), { model: "m1", promptVersion: "p2" });
    const result = compareToBaseline(next, base);

    expect(result.comparable).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.changed.prompt).toBe(true);
    expect(result.changed.model).toBe(false);
  });

  it("fails when accuracy drops past tolerance", () => {
    const base = baselineFrom(scoreRun(scored(95, 100)), "pinned");
    const next = scoreRun(scored(80, 100));
    const result = compareToBaseline(next, base);

    expect(result.passed).toBe(false);
    expect(result.regressions.map((r) => r.metric)).toContain("category_accuracy");
  });

  it("tolerates noise smaller than the tolerance", () => {
    const base = baselineFrom(scoreRun(scored(90, 100)), "pinned");
    const next = scoreRun(scored(89, 100));
    expect(compareToBaseline(next, base).passed).toBe(true);
  });

  it("refuses to compare two different datasets", () => {
    // Scores from different label sets are not a regression test, they are a
    // coincidence. Better to say so than to print a delta that looks real.
    const base = baselineFrom(
      scoreRun(scored(90, 100), { datasetId: "aaaa", split: "holdout" }),
      "pinned",
    );
    const next = scoreRun(scored(90, 100), { datasetId: "bbbb", split: "holdout" });
    const result = compareToBaseline(next, base);

    expect(result.comparable).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Re-baseline");
  });
});
