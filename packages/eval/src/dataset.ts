import fs from "node:fs/promises";
import path from "node:path";
import { GoldenSample, assignSplit, datasetId } from "./sample.js";

/**
 * JSONL, one sample per line, sorted by id.
 *
 * JSONL rather than a single JSON array so that adding a sample is a one-line
 * diff instead of a reflowed file, and sorted by id so that two exports of the
 * same data produce the same bytes. A dataset whose diff is unreadable is a
 * dataset nobody reviews.
 */

export interface LoadedDataset {
  path: string;
  dataset_id: string;
  samples: GoldenSample[];
  /** Lines that failed to parse, with the reason. Never silently dropped. */
  errors: Array<{ line: number; message: string }>;
}

export async function loadDataset(file: string): Promise<LoadedDataset> {
  const raw = await fs.readFile(file, "utf8");
  const samples: GoldenSample[] = [];
  const errors: Array<{ line: number; message: string }> = [];
  const seen = new Set<string>();

  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("//")) continue;
    try {
      const parsed = GoldenSample.parse(JSON.parse(line));
      if (seen.has(parsed.id)) {
        errors.push({ line: i + 1, message: `duplicate sample id ${parsed.id}` });
        continue;
      }
      seen.add(parsed.id);
      samples.push(parsed);
    } catch (err) {
      errors.push({
        line: i + 1,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  samples.sort((a, b) => a.id.localeCompare(b.id));
  return { path: file, dataset_id: datasetId(samples), samples, errors };
}

export async function saveDataset(
  file: string,
  samples: readonly GoldenSample[],
): Promise<{ path: string; dataset_id: string; n: number }> {
  const sorted = [...samples].sort((a, b) => a.id.localeCompare(b.id));
  const body = sorted.map((s) => JSON.stringify(s)).join("\n");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body + (body ? "\n" : ""), "utf8");
  return { path: file, dataset_id: datasetId(sorted), n: sorted.length };
}

/**
 * Merge new samples into an existing set without touching labels already
 * reviewed by a person.
 *
 * An export that overwrites a hand-corrected label with whatever the database
 * currently says would quietly undo the labelling work the harness exists to
 * use. Existing samples keep their label and their split; only genuinely new
 * ids are added.
 */
export function mergeSamples(
  existing: readonly GoldenSample[],
  incoming: readonly GoldenSample[],
  opts: { holdoutPct?: number } = {},
): { merged: GoldenSample[]; added: number; skipped: number } {
  const byId = new Map(existing.map((s) => [s.id, s]));
  let added = 0;
  let skipped = 0;

  for (const s of incoming) {
    if (byId.has(s.id)) {
      skipped += 1;
      continue;
    }
    byId.set(s.id, { ...s, split: assignSplit(s.id, opts.holdoutPct ?? 30) });
    added += 1;
  }

  return {
    merged: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    added,
    skipped,
  };
}

export function selectSplit(
  samples: readonly GoldenSample[],
  split: "train" | "holdout" | "all",
): GoldenSample[] {
  if (split === "all") return [...samples];
  return samples.filter((s) => s.split === split);
}
