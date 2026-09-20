import fs from "node:fs/promises";
import path from "node:path";
import {
  applyBounce,
  env,
  intakeMessage,
  parseDeliveryStatus,
  systemContext,
} from "@hd/core";
import { normalizeEml } from "./email.js";

/**
 * Dev intake: a folder of .eml files.
 *
 * Real deployments use the inbound webhook in the dashboard (Postmark or
 * SendGrid parse) or IMAP. This adapter exists so the whole pipeline can be
 * exercised end to end with no mail provider and no credentials - drop a file
 * in the folder and watch the ticket appear.
 *
 * Processed files are renamed rather than deleted, so a rerun is a rename away.
 */
export async function pollMaildir(businessId: string): Promise<number> {
  // A dev poller has no session, so it runs as the system inside the tenant it
  // was told to poll. Naming the context here rather than passing an id down
  // keeps the rule intact: intake never reads a tenant off the message.
  const tenant = systemContext(businessId, { requestId: "maildir" });
  const dir = path.resolve(env.INTAKE_MAILDIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0; // folder does not exist yet; nothing to do
  }

  const pending = entries.filter((f) => f.endsWith(".eml"));
  let handled = 0;

  for (const file of pending) {
    const full = path.join(dir, file);
    try {
      const raw = await fs.readFile(full);

      // Bounces are read before anything else looks at the message. They used
      // to be dropped as auto-replies — correct, in that a DSN must never
      // become a ticket, and a silent loss of the only notification that a
      // reply never arrived. This is where "outbound failure handling" actually
      // happens for an SMTP deployment: no provider webhook is involved, the
      // failure comes back as mail.
      const text = raw.toString("utf8");
      const bounce = parseDeliveryStatus(text, {
        from: header(text, "From"),
        subject: header(text, "Subject"),
      });
      if (bounce) {
        const outcome = await applyBounce(tenant, bounce);
        console.log(
          `[intake] ${file} is a ${bounce.kind} bounce for ${bounce.recipient ?? "an unknown address"}` +
            ` -> ${outcome.applied}${outcome.suppressed ? ", address suppressed" : ""}`,
        );
        await fs.rename(full, `${full}.processed`);
        handled += 1;
        continue;
      }

      const msg = await normalizeEml(raw, { fallbackId: `file:${file}` });
      if (!msg) {
        console.log(`[intake] skipped ${file} (auto-reply or no sender)`);
      } else {
        const result = await intakeMessage(tenant, msg);
        console.log(
          `[intake] ${file} -> ticket ${result.ticket.id}` +
            (result.created ? "" : " (duplicate, ignored)"),
        );
        handled += 1;
      }
      await fs.rename(full, `${full}.processed`);
    } catch (err) {
      console.error(`[intake] failed on ${file}`, err);
      await fs.rename(full, `${full}.failed`).catch(() => {});
    }
  }

  return handled;
}

/**
 * One top-level header out of a raw message.
 *
 * Only the header block — everything before the first blank line — so a quoted
 * `From:` inside the body cannot answer. Enough for the bounce check's
 * corroboration; anything that needs real parsing goes through mailparser.
 */
function header(raw: string, name: string): string | null {
  const head = raw.replace(/\r\n/g, "\n").split("\n\n")[0] ?? "";
  const match = head.match(new RegExp(`^${name}:[ \t]*(.*)$`, "im"));
  const value = match?.[1]?.trim();
  if (!value) return null;
  const address = value.match(/<([^>]*)>/);
  return (address ? address[1]! : value).trim().toLowerCase();
}
