import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyBounce,
  closePool,
  closeQueues,
  env,
  intakeMessage,
  listBusinesses,
  outboundForTicket,
  parseDeliveryStatus,
  systemContext,
} from "@hd/core";
import { runPipeline } from "@hd/agent-helpdesk";
import { normalizeEml } from "../apps/worker/src/intake/email.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const emailsDir = path.join(here, "..", "db", "seed", "emails");

/**
 * End-to-end run with no worker and no Redis: parse the sample emails, create
 * the tickets, and drive the pipeline inline, printing what the agent decided
 * and why.
 *
 * Useful for seeing the decision branch exercised across every case at once,
 * and for checking a prompt change without waiting on a queue.
 */
async function main(): Promise<void> {
  const businesses = await listBusinesses();
  const business = businesses[0];
  if (!business) {
    console.error("No tenant. Run: npm run db:migrate && npm run db:seed");
    process.exit(1);
  }

  // The demo drives intake directly, so it names its tenant once here rather
  // than putting a business id on each message.
  const tenant = systemContext(business.id, { requestId: "demo" });

  const only = process.argv[2];
  const files = (await fs.readdir(emailsDir))
    .filter((f) => f.endsWith(".eml"))
    .filter((f) => (only ? f.includes(only) : true))
    .sort();

  console.log(`\nMode: ${env.AGENT_MODE}   Model: ${env.TRIAGE_MODEL}   Embedder: ${env.EMBEDDING_PROVIDER}\n`);

  console.log(`Outbound transport: ${env.OUTBOUND_EMAIL_PROVIDER}
`);

  for (const file of files) {
    const raw = await fs.readFile(path.join(emailsDir, file));

    // Bounces are read before normalization, the same as in the worker. A
    // delivery status notification must never become a ticket, and dropping it
    // as an auto-reply loses the only notice that a reply never arrived.
    const bounce = parseDeliveryStatus(raw.toString("utf8"));
    if (bounce) {
      const outcome = await applyBounce(tenant, bounce);
      console.log(`${file}`);
      console.log(
        `  ${bounce.kind} bounce for ${bounce.recipient ?? "an unknown address"} — ${outcome.applied}` +
          (outcome.suppressed ? ", address suppressed" : ""),
      );
      console.log(`  ${bounce.status ?? ""} ${bounce.diagnostic ?? ""}`.trimEnd());
      console.log();
      continue;
    }

    const msg = await normalizeEml(raw, { fallbackId: `demo:${file}` });

    if (!msg) {
      console.log(`${file}\n  dropped at intake (auto-reply or no sender)\n`);
      continue;
    }

    const { ticket, created } = await intakeMessage(tenant, msg);
    if (!created) {
      console.log(`${file}\n  duplicate of ${ticket.id}, skipped\n`);
      continue;
    }

    const result = await runPipeline(ticket.id);

    console.log(`${file}`);
    console.log(`  "${ticket.subject}"`);
    if (!result.ok) {
      console.log(`  FAILED: ${result.error}\n`);
      continue;
    }
    const t = result.triage!;
    const d = result.decision!;
    console.log(
      `  ${t.priority} ${t.category}/${t.subcategory}  confidence ${t.confidence.toFixed(2)}` +
        (t.is_security_sensitive ? "  [security]" : "") +
        (t.is_destructive_request ? "  [destructive]" : ""),
    );
    console.log(`  rule: ${d.rule}`);
    console.log(`  ${d.reason}`);
    console.log(
      `  would: ${d.intendedAction} (${d.intendedPath})   did: ${d.action} (${d.path})`,
    );
    if (result.chunks?.length) {
      console.log(
        `  kb:    ${result.chunks
          .slice(0, 2)
          .map((c) => `${c.doc_title} ${c.score.toFixed(2)}`)
          .join(", ")}`,
      );
    }
    if (result.draft) {
      const preview = result.draft.body.split("\n").slice(0, 3).join(" ").slice(0, 140);
      console.log(`  draft: ${preview}…`);
    }
    console.log();
  }

  await closeQueues().catch(() => {});
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  await closeQueues().catch(() => {});
  await closePool().catch(() => {});
  process.exit(1);
});
