import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, env, listBusinesses, systemContext } from "@hd/core";
import { ingestDocument, kbStats, parseRunbook } from "@hd/rag";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultDir = path.join(here, "..", "db", "seed", "kb");

/**
 * Ingest a folder of markdown runbooks.
 *
 * Front matter is a `categories:` line; everything else is content. Re-running
 * is safe - documents are keyed by a content hash, so unchanged files are
 * skipped and edited ones are re-ingested as new documents.
 */
async function main(): Promise<void> {
  const dirArg = process.argv[2];
  const dir = dirArg ? path.resolve(dirArg) : defaultDir;

  const businesses = await listBusinesses();
  const business = businesses[0];
  if (!business) {
    console.error("[kb] no tenant. Run: npm run db:seed");
    process.exit(1);
  }

  // A CLI has no session, so it acts as the system inside one named tenant.
  const tenant = systemContext(business.id, { requestId: "kb:ingest" });

  const files = (await fs.readdir(dir)).filter((f) => /\.(md|markdown|txt)$/i.test(f));
  if (files.length === 0) {
    console.log(`[kb] nothing to ingest in ${dir}`);
    await closePool();
    return;
  }

  console.log(`[kb] embedder: ${env.EMBEDDING_PROVIDER}`);

  for (const file of files) {
    const raw = await fs.readFile(path.join(dir, file), "utf8");
    const { categories, body, title } = parseRunbook(raw, file);
    const result = await ingestDocument(tenant, {
      title,
      content: body,
      origin: "runbook",
      categories,
      sourceUrl: `file://${path.join(dir, file)}`,
    });
    console.log(
      result.skipped
        ? `[kb] unchanged ${file}`
        : `[kb] ${file} -> ${result.chunks} chunks (${categories.join(", ") || "no category"})`,
    );
  }

  console.table(await kbStats(tenant));
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
