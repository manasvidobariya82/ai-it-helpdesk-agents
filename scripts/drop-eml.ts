import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "@hd/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.join(here, "..", "db", "seed", "emails");

/**
 * Copy the sample emails into the intake folder so the worker picks them up.
 *
 * Each copy gets a fresh Message-ID, otherwise the second run deduplicates
 * against the first and nothing appears - which looks like a broken pipeline
 * when it is actually idempotency working correctly.
 */
async function main(): Promise<void> {
  const target = path.resolve(env.INTAKE_MAILDIR);
  await fs.mkdir(target, { recursive: true });

  const only = process.argv[2];
  const files = (await fs.readdir(sourceDir))
    .filter((f) => f.endsWith(".eml"))
    .filter((f) => (only ? f.includes(only) : true));

  if (files.length === 0) {
    console.log(`[drop] no matching emails${only ? ` for "${only}"` : ""}`);
    return;
  }

  const stamp = Date.now();
  for (const file of files) {
    const raw = await fs.readFile(path.join(sourceDir, file), "utf8");
    const freshened = raw.replace(
      /^Message-ID:\s*<(.+)>$/im,
      (_m, id: string) => `Message-ID: <${stamp}-${id}>`,
    );
    await fs.writeFile(path.join(target, `${stamp}-${file}`), freshened, "utf8");
    console.log(`[drop] ${file}`);
  }

  console.log(
    `\n[drop] ${files.length} file(s) in ${target}\n` +
      `The worker polls every 5s. If it is not running: npm run dev:worker`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
