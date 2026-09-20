import "dotenv/config";

// Before core loads, because it reads the prefix once. The enqueue is part of
// what is timed, so it has to be real — but the tenant is purged afterwards,
// and in the worker's namespace a running worker would spend model calls
// triaging five hundred tickets that are about to stop existing.
process.env.QUEUE_PREFIX = "hd-bench";
const {
  closePool,
  closeQueues,
  intakeMessage,
  obliterateQueues,
  purgeBusinessUnaudited,
  queryOne,
  systemContext,
} = await import("@hd/core");

/**
 * The P1 exit criterion: p95 intake → enqueued under 2s at 10x current volume.
 *
 * `npm run bench:intake [messages] [concurrency]`
 *
 * What is being timed is the whole of `intakeMessage`: deduplication, identity
 * resolution, threading, secret scrubbing, the ticket insert, the opening
 * event, and the enqueue. That is the span the criterion names, and it is the
 * span a mail server is waiting on — everything after the enqueue is the
 * worker's problem and has its own queue to absorb it.
 *
 * **On "10x current volume".** Nothing in this repository states a current
 * volume, so the number is derived rather than assumed: a small IT services
 * tenant of the size this build models runs on the order of 100 tickets a day,
 * so 10x is 1,000 a day. Spread over an eight-hour working day that is about
 * two a minute, which no latency test would strain — so the default here is
 * deliberately harsher than the criterion. It drives 500 messages at a
 * concurrency of 20, which is roughly a day's traffic delivered in under a
 * minute, and is what a mail server does after an outage when it flushes a
 * spool that has been backing up.
 *
 * The tenant it creates is purged afterwards, including on failure.
 */

const COUNT = Number(process.argv[2] ?? 500);
const CONCURRENCY = Number(process.argv[3] ?? 20);
const TARGET_P95_MS = 2_000;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index]!;
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const row = await queryOne<{ id: string }>(
    `insert into businesses (name, type, settings, intake_address)
     values ($1, 'it_services', '{}'::jsonb, $2) returning id`,
    [`bench-${stamp}`, `bench-${stamp}@example.test`],
  );
  const businessId = row!.id;
  const ctx = systemContext(businessId, { requestId: "bench-intake" });

  console.log(
    `[bench] ${COUNT} messages, concurrency ${CONCURRENCY}, tenant ${businessId}`,
  );

  const latencies: number[] = [];
  let enqueued = 0;
  let failed = 0;
  let nextIndex = 0;

  const startedAll = Date.now();

  // A fixed pool of workers rather than 500 promises at once: the point is to
  // measure the system under sustained pressure, not to measure how Node
  // behaves when handed five hundred simultaneous database calls.
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= COUNT) return;

      // Every message is a distinct requester and a distinct source id, so
      // nothing dedupes or threads and each call does the full amount of work.
      const started = Date.now();
      try {
        const result = await intakeMessage(ctx, {
          source: "email",
          source_message_id: `bench-${stamp}-${i}@example.test`,
          requester_email: `bench-person-${i}@example.test`,
          requester_name: `Bench Person ${i}`,
          subject: `[bench ${i}] laptop will not connect to the vpn`,
          body:
            "It worked yesterday and stopped this morning. " +
            "I have restarted twice. The wifi is fine, it is only the vpn. " +
            `Reference ${i}.`,
          attachments: [],
          received_at: new Date(),
          meta: {},
        });
        latencies.push(Date.now() - started);
        if (result.enqueued) enqueued += 1;
      } catch (err) {
        failed += 1;
        latencies.push(Date.now() - started);
        if (failed <= 3) console.error("[bench] intake failed", err);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const wallMs = Date.now() - startedAll;
  const sorted = [...latencies].sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);
  const mean = Math.round(sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1));

  console.log("");
  console.log(`  messages      ${COUNT}`);
  console.log(`  enqueued      ${enqueued}`);
  console.log(`  failed        ${failed}`);
  console.log(`  wall clock    ${(wallMs / 1000).toFixed(1)}s`);
  console.log(`  throughput    ${(COUNT / (wallMs / 1000)).toFixed(1)}/s`);
  console.log("");
  console.log(`  mean          ${mean}ms`);
  console.log(`  p50           ${percentile(sorted, 50)}ms`);
  console.log(`  p95           ${p95}ms   (target < ${TARGET_P95_MS}ms)`);
  console.log(`  p99           ${percentile(sorted, 99)}ms`);
  console.log(`  max           ${sorted[sorted.length - 1] ?? 0}ms`);
  console.log("");

  await purgeBusinessUnaudited(businessId);
  await obliterateQueues().catch((err) => console.warn("[bench] queues not emptied", err));
  await closeQueues().catch(() => {});
  await closePool();

  const passed = p95 < TARGET_P95_MS && failed === 0;
  console.log(
    passed
      ? `[bench] PASS — p95 ${p95}ms is inside the ${TARGET_P95_MS}ms target`
      : `[bench] FAIL — p95 ${p95}ms, ${failed} failures`,
  );
  process.exit(passed ? 0 : 1);
}

main().catch(async (err) => {
  console.error("[bench] fatal", err);
  await closeQueues().catch(() => {});
  await closePool().catch(() => {});
  process.exit(1);
});
