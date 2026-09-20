import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, pool, query } from "@hd/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "..", "db", "migrations");

async function main(): Promise<void> {
  const reset = process.argv.includes("--reset");

  if (reset) {
    console.log("[migrate] dropping and recreating schema public");
    await query(`drop schema public cascade`);
    await query(`create schema public`);
  }

  await query(`
    create table if not exists schema_migrations (
      filename    text primary key,
      applied_at  timestamptz not null default now()
    )
  `);

  const applied = new Set(
    (await query<{ filename: string }>(`select filename from schema_migrations`)).map(
      (r) => r.filename,
    ),
  );

  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    const client = await pool().connect();
    try {
      // One transaction per file: a half-applied migration is the worst
      // possible state to debug at 2am.
      await client.query("begin");
      await client.query(sql);
      await client.query(`insert into schema_migrations (filename) values ($1)`, [file]);
      await client.query("commit");
      console.log(`[migrate] applied ${file}`);
      count += 1;
    } catch (err) {
      await client.query("rollback");
      console.error(`[migrate] FAILED on ${file}`);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(count === 0 ? "[migrate] already up to date" : `[migrate] ${count} applied`);
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
