import "dotenv/config";
import {
  NotFoundError,
  backfillConversation,
  closePool,
  closeQueues,
  query,
  systemContext,
  type BackfillResult,
  type LegacySkipReason,
} from "@hd/core";

/**
 * Copy every ticket's history from before the conversation into it (D4 in
 * docs/conversation.md).
 *
 *   npm run conversations:backfill [-- --dry-run] [--business <id>]
 *
 * Safe to run any number of times, and while the product is running: each
 * ticket is one transaction under its conversation's lock, and a copy's key
 * comes from its record, so a second run writes only what the first did not.
 * A dry run takes no locks and writes nothing, and reports what a run would do.
 *
 * A ticket is refused, never partly copied, when copying it would put a
 * message out of order or when its record is missing something that cannot be
 * guessed. Refusals are listed at the end and the exit code is 1, so a deploy
 * that runs this notices. A tenant or ticket deleted while this runs is
 * counted as gone.
 */

const dryRun = process.argv.includes("--dry-run");
const businessArg = process.argv.indexOf("--business");
const onlyBusiness = businessArg >= 0 ? process.argv[businessArg + 1] : undefined;

interface Tally {
  tickets: number;
  written: number;
  present: number;
  gone: number;
  skipped: Record<LegacySkipReason, number>;
  refused: BackfillResult[];
}

async function main(): Promise<void> {
  const businesses = await query<{ id: string; name: string }>(
    `select id, name from businesses
      where $1::uuid is null or id = $1::uuid
      order by created_at, id`,
    [onlyBusiness ?? null],
  );
  if (onlyBusiness && businesses.length === 0) {
    throw new Error(`no business ${onlyBusiness}`);
  }

  const total: Tally = {
    tickets: 0,
    written: 0,
    present: 0,
    gone: 0,
    skipped: { no_body: 0, merged_copy: 0, same_delivery: 0 },
    refused: [],
  };

  for (const business of businesses) {
    const ctx = systemContext(business.id, { requestId: "conversation-backfill" });
    const tickets = await query<{ id: string }>(
      `select id from tickets where business_id = $1 order by created_at, id`,
      [business.id],
    );
    let written = 0;
    for (const { id } of tickets) {
      let result: BackfillResult;
      try {
        result = await backfillConversation(ctx, id, { dryRun });
      } catch (err) {
        if (err instanceof NotFoundError) {
          total.gone += 1;
          continue;
        }
        throw err;
      }
      total.tickets += 1;
      if (result.refused) {
        total.refused.push(result);
        continue;
      }
      written += result.written;
      total.written += result.written;
      total.present += result.present;
      for (const s of result.skipped) total.skipped[s.reason] += 1;
    }
    console.log(
      `[backfill] ${business.name}: ${tickets.length} tickets, ${written} messages ${dryRun ? "to write" : "written"}`,
    );
  }

  console.log(
    `[backfill] ${dryRun ? "dry run, nothing written. " : ""}` +
      `${total.tickets} tickets: ${total.written} messages ${dryRun ? "to write" : "written"}, ` +
      `${total.present} already there, ${total.gone} gone while running`,
  );
  console.log(
    `[backfill] not copied: ${total.skipped.merged_copy} merge copies (copied on their own ticket), ` +
      `${total.skipped.same_delivery} repeat sends of one email, ${total.skipped.no_body} without words`,
  );
  for (const r of total.refused) {
    console.log(`[backfill] REFUSED ticket ${r.ticketId}: ${r.refused}`);
  }

  await closeQueues().catch(() => {});
  await closePool();
  process.exit(total.refused.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("[backfill] fatal", err);
  await closeQueues().catch(() => {});
  await closePool().catch(() => {});
  process.exit(1);
});
