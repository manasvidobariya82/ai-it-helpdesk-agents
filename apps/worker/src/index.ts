import { Worker } from "bullmq";
import {
  QUEUE_NAMES,
  agentContext,
  appendEvent,
  closePool,
  closeQueues,
  consumerOptions,
  deliverDue,
  deliverOutbound,
  dueOutbound,
  env,
  expireApprovals,
  expireConfigRequests,
  listBusinesses,
  clearHeartbeat,
  reclaimStalledOutbound,
  recordHeartbeat,
  sweepSlaBreaches,
  sweepSlaWarnings,
  type FollowupJob,
  type OutboundJob,
  type TriageJob,
  type WritebackJob,
} from "@hd/core";
import os from "node:os";
import {
  runAllFollowups,
  runFollowups,
  runPipeline,
  writeBackResolution,
} from "@hd/agent-helpdesk";
import { pollMaildir } from "./intake/maildir.js";

const POLL_INTERVAL_MS = 5_000;
const FOLLOWUP_INTERVAL_MS = 15 * 60_000;
const EXPIRY_INTERVAL_MS = 60_000;
const OUTBOUND_INTERVAL_MS = 30_000;
/** How long a claimed message may sit in `sending` before it is assumed lost. */
const OUTBOUND_STALL_MINUTES = 5;
/**
 * How often to look for SLA clocks running out.
 *
 * Five minutes is a compromise with one hard constraint: it has to be short
 * enough that a P1's warning — three minutes of a fifteen-minute target — is
 * not delivered after the breach. Each warning is sent once per ticket per
 * clock, so a short interval costs queries rather than emails.
 */
const SLA_WARNING_INTERVAL_MS = 5 * 60_000;
/**
 * How often to record SLA breaches nobody has written to the ticket since.
 *
 * Every write that sees a breach records it, so this only covers the tickets
 * nobody is touching. A minute means the record is never more than a minute
 * behind the console, and the sweep reads two partial indexes that contain
 * only clocks still running.
 */
const SLA_BREACH_INTERVAL_MS = 60_000;
/**
 * How often to say "still here".
 *
 * Well under the 90 seconds the health check treats as stale, so one missed
 * beat — a long sweep, a slow query — is not an alert. The point of the
 * interval is that silence means something: a worker cannot report its own
 * death, so the only evidence of a crash is a timestamp that stops moving.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Stable per process role rather than per process.
 *
 * A restart updates the row instead of leaving a dead one behind, which matters
 * because the health check reads the freshest heartbeat: a table full of
 * abandoned rows from previous boots would always contain a recent one.
 * `WORKER_ID` distinguishes replicas in a deployment that runs several.
 */
const WORKER_ID = process.env.WORKER_ID ?? "worker";

/**
 * Sent with every beat, because the row outlives the process: without it a
 * restart kept the first boot's time, and the System page showed a worker
 * started this morning as running since last week.
 */
const STARTED_AT = new Date();

/**
 * Retire approvals and configuration proposals whose window has closed.
 *
 * Both are also checked at the point of use, so this sweep is not what makes
 * expiry safe — a worker that is down cannot let a stale approval through. What
 * it does is make the queue honest and, more importantly, tell somebody: an
 * approval that lapses in silence is indistinguishable from one that was
 * quietly denied, and the person who asked for it is still waiting.
 */
async function sweepExpiries(): Promise<void> {
  const lapsed = await expireApprovals();
  for (const row of lapsed) {
    const tenant = agentContext(row.business_id, { requestId: `expiry:${row.id}` });
    await appendEvent(tenant, {
      ticket_id: row.ticket_id,
      actor: "system",
      kind: "note",
      payload: {
        stage: "approval_expired",
        action_request_id: row.id,
        tool: row.tool_name,
        note: "Nobody decided this in time, so it will not run. Raise it again if it is still wanted.",
      },
    });
  }
  if (lapsed.length > 0) {
    console.log(`[expiry] ${lapsed.length} approval(s) expired`);
  }

  const proposals = await expireConfigRequests();
  if (proposals > 0) {
    console.log(`[expiry] ${proposals} configuration proposal(s) expired`);
  }
}

let sweeping = false;

/**
 * The outbound mail sweep.
 *
 * The queue of record is `outbound_messages`, not Redis. The BullMQ job is a
 * doorbell that makes delivery prompt; this is what makes it certain. Anything
 * queued and due is picked up here whether or not its job survived, so a Redis
 * restart delays a reply by one interval instead of losing it — and a message
 * claimed by a worker that died is returned to the queue rather than sitting in
 * `sending` forever, which is the one status no timer ever revisits.
 *
 * Delivering directly rather than re-enqueueing is safe with several workers
 * running: the claim is a single atomic statement, so two sweeps racing on the
 * same row produce one delivery and one no-op.
 */
async function sweepOutbound(): Promise<void> {
  // A sweep that sends fifty messages over a slow SMTP link can outlast its own
  // interval. Overlapping sweeps would be safe — the claim is atomic — but they
  // would also be pointless work and a second queue of connections to the same
  // provider, which is the thing concurrency 1 exists to avoid.
  if (sweeping) return;
  sweeping = true;
  try {
    await runOutboundSweep();
  } finally {
    sweeping = false;
  }
}

async function runOutboundSweep(): Promise<void> {
  const reclaimed = await reclaimStalledOutbound(OUTBOUND_STALL_MINUTES);
  if (reclaimed.length > 0) {
    console.warn(
      `[outbound] reclaimed ${reclaimed.length} message(s) left in flight by a stopped worker`,
    );
  }

  const due = await dueOutbound(50);
  if (due.length === 0) return;

  const results = await deliverDue(due);
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`[outbound] swept ${results.length}: ${JSON.stringify(counts)}`);
}

async function heartbeat(): Promise<void> {
  await recordHeartbeat({
    id: WORKER_ID,
    kind: "worker",
    hostname: os.hostname(),
    pid: process.pid,
    started_at: STARTED_AT,
    version: process.env.npm_package_version ?? null,
    detail: {
      mode: env.AGENT_MODE,
      outbound_transport: env.OUTBOUND_EMAIL_PROVIDER,
      queues: Object.values(QUEUE_NAMES),
      sweeps: ["expiry", "outbound", "sla_warning", "sla_breach", "followup"],
    },
  });
}

async function main(): Promise<void> {
  console.log(`[worker] starting in ${env.AGENT_MODE} mode`);
  if (env.AGENT_MODE === "shadow") {
    console.log("[worker] shadow mode: the agent will classify and draft, and contact nobody");
  }

  const triageWorker = new Worker<TriageJob>(
    QUEUE_NAMES.triage,
    async (job) => {
      const result = await runPipeline(job.data.ticketId);
      if (!result.ok) {
        // The ticket is already parked with a human; do not retry a decision
        // the model has already declined to make.
        console.warn(`[triage] ${job.data.ticketId}: ${result.error}`);
        return result;
      }
      console.log(
        `[triage] ${job.data.ticketId} -> ${result.triage?.priority} ${result.triage?.category} ` +
          `(${result.triage?.confidence.toFixed(2)}) rule=${result.decision?.rule} ` +
          `path=${result.decision?.path}`,
      );
      return result;
    },
    consumerOptions(4),
  );

  const followupWorker = new Worker<FollowupJob>(
    QUEUE_NAMES.followup,
    async (job) => {
      const summary = await runFollowups(job.data.businessId);
      console.log(`[followup] ${JSON.stringify(summary)}`);
      return summary;
    },
    consumerOptions(1),
  );

  const writebackWorker = new Worker<WritebackJob>(
    QUEUE_NAMES.writeback,
    async (job) => writeBackResolution(null, job.data.ticketId),
    consumerOptions(2),
  );

  /**
   * Outbound mail.
   *
   * Concurrency 1 on purpose. The scarce resource is a mail provider's
   * willingness to accept traffic from us, and the fastest way to get a sending
   * domain rate-limited — or blacklisted — is to open eight connections the
   * moment a backlog appears. Retries and their backoff live on the row, so a
   * slow drain is a delay and never a loss.
   */
  const outboundWorker = new Worker<OutboundJob>(
    QUEUE_NAMES.outbound,
    async (job) => {
      const result = await deliverOutbound(job.data.messageId);
      if (result.status === "sent") {
        console.log(
          `[outbound] ${result.messageId} sent via ${result.provider} on attempt ${result.attempts}`,
        );
      } else if (result.status !== "skipped") {
        console.warn(
          `[outbound] ${result.messageId} ${result.status}` +
            (result.error ? `: ${result.error}` : ""),
        );
      }
      return result;
    },
    consumerOptions(1),
  );

  for (const w of [triageWorker, followupWorker, writebackWorker, outboundWorker]) {
    w.on("failed", (job, err) => {
      console.error(`[${w.name}] job ${job?.id} failed:`, err.message);
    });
  }

  // Dev intake poller. Production uses the inbound webhook in apps/web.
  const businesses = await listBusinesses();
  const primary = businesses[0];
  let pollTimer: NodeJS.Timeout | null = null;

  // Not tied to a tenant: expiry is a clock, and both sweeps act on every
  // tenant at once. Started before the maildir check so a deployment with no
  // seeded business still expires what it has.
  const expiryTimer: NodeJS.Timeout = setInterval(() => {
    sweepExpiries().catch((err) => console.error("[expiry] sweep failed", err));
  }, EXPIRY_INTERVAL_MS);

  // Also not tied to a tenant, and deliberately started before the maildir
  // check: a deployment with no seeded business can still have mail to retry.
  console.log(`[worker] outbound transport: ${env.OUTBOUND_EMAIL_PROVIDER}`);
  if (env.OUTBOUND_EMAIL_PROVIDER === "spool") {
    console.log(
      `[worker] spooling mail to ${env.OUTBOUND_SPOOL_DIR}; nothing is sent to a requester`,
    );
  }
  const outboundTimer: NodeJS.Timeout = setInterval(() => {
    sweepOutbound().catch((err) => console.error("[outbound] sweep failed", err));
  }, OUTBOUND_INTERVAL_MS);

  // Before anything else, so a worker that dies during startup has still said
  // it was here — the health page can then show a heartbeat that stopped rather
  // than one that never existed, which are different problems.
  await heartbeat().catch((err) => console.error("[heartbeat] failed", err));
  const heartbeatTimer: NodeJS.Timeout = setInterval(() => {
    heartbeat().catch((err) => console.error("[heartbeat] failed", err));
  }, HEARTBEAT_INTERVAL_MS);

  // A clock cannot tell anybody it is running out, so something has to look.
  // Across every tenant, like the expiry sweep: an SLA is a promise the
  // deployment made, not a per-tenant job somebody has to remember to start.
  const slaTimer: NodeJS.Timeout = setInterval(() => {
    sweepSlaWarnings()
      .then((summary) => {
        if (summary.sent > 0 || summary.nobody > 0) {
          console.log(`[sla] ${JSON.stringify(summary)}`);
        }
      })
      .catch((err) => console.error("[sla] warning sweep failed", err));
  }, SLA_WARNING_INTERVAL_MS);

  // A breach is history once it happens, and a clock can breach on a ticket
  // nobody is working. Across every tenant, like the warning sweep.
  const breachTimer: NodeJS.Timeout = setInterval(() => {
    sweepSlaBreaches()
      .then((summary) => {
        if (summary.recorded > 0 || summary.failed > 0) {
          console.log(`[sla] breaches ${JSON.stringify(summary)}`);
        }
      })
      .catch((err) => console.error("[sla] breach sweep failed", err));
  }, SLA_BREACH_INTERVAL_MS);

  // Every tenant, like the other sweeps. This used to run for `primary` only,
  // so a second tenant's resolved tickets were never closed or written back.
  const followupTimer: NodeJS.Timeout = setInterval(() => {
    runAllFollowups()
      .then((summary) => {
        if (summary.checked > 0) console.log(`[followup] ${JSON.stringify(summary)}`);
      })
      .catch((err) => console.error("[followup] failed", err));
  }, FOLLOWUP_INTERVAL_MS);

  if (primary) {
    console.log(`[worker] watching ${env.INTAKE_MAILDIR} for ${primary.name}`);
    pollTimer = setInterval(() => {
      pollMaildir(primary.id).catch((err) => console.error("[intake] poll failed", err));
    }, POLL_INTERVAL_MS);
  } else {
    console.warn("[worker] no businesses found. Run: npm run db:seed");
  }

  const shutdown = async (signal: string) => {
    console.log(`\n[worker] ${signal}, shutting down`);
    if (pollTimer) clearInterval(pollTimer);
    clearInterval(followupTimer);
    clearInterval(expiryTimer);
    clearInterval(outboundTimer);
    clearInterval(slaTimer);
    clearInterval(breachTimer);
    clearInterval(heartbeatTimer);
    // A deliberate shutdown removes the row rather than leaving one that ages
    // into an alert. A crash leaves it, which is the whole point.
    await clearHeartbeat(WORKER_ID).catch(() => {});
    await Promise.all([
      triageWorker.close(),
      followupWorker.close(),
      writebackWorker.close(),
      outboundWorker.close(),
    ]);
    await closeQueues();
    await closePool();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
