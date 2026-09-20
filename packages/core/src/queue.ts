import { Queue, type JobsOptions, type WorkerOptions } from "bullmq";
import IORedis from "ioredis";
import { DEFAULT_QUEUE_PREFIX, env } from "./env.js";

/**
 * Job queue.
 *
 * Model calls are slow and tickets arrive in bursts, so nothing in the agent
 * path runs inside a web request. Both the dashboard and the worker enqueue
 * through this module; only the worker consumes.
 */
let connectionRef: IORedis | null = null;

export function connection(): IORedis {
  if (!connectionRef) {
    connectionRef = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null, // required by BullMQ workers
      enableReadyCheck: false,
    });
    connectionRef.on("error", (err) => console.error("[queue] redis error", err.message));
  }
  return connectionRef;
}

export const QUEUE_NAMES = {
  triage: "hd.triage",
  followup: "hd.followup",
  writeback: "hd.writeback",
  outbound: "hd.outbound",
} as const;

export interface TriageJob {
  ticketId: string;
}
export interface FollowupJob {
  businessId: string;
}
export interface WritebackJob {
  ticketId: string;
}
export interface OutboundJob {
  messageId: string;
}

const defaults: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  // Kept only briefly: a completed job whose id still exists silently swallows
  // a re-add, and re-triaging a ticket must always work.
  removeOnComplete: { age: 600, count: 1_000 },
  // Keep failures around. A dead-letter queue nobody looks at is decoration;
  // the dashboard reads this one.
  removeOnFail: { age: 30 * 24 * 3600 },
};

const queueCache = new Map<string, Queue>();

function queue<T>(name: string): Queue<T> {
  let q = queueCache.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: connection(),
      prefix: env.QUEUE_PREFIX,
      defaultJobOptions: defaults,
    });
    queueCache.set(name, q);
  }
  return q as Queue<T>;
}

/**
 * Options for a worker consuming one of these queues. A worker built without
 * the prefix reads a different namespace from the one jobs are written to, and
 * sits idle without an error.
 */
export function consumerOptions(concurrency: number): WorkerOptions {
  return { connection: connection(), prefix: env.QUEUE_PREFIX, concurrency };
}

/**
 * How long an enqueue may block before the caller gives up.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on its connection, which makes
 * ioredis retry a command forever. That is right for a worker — it should
 * reconnect and carry on — and wrong for anything inside a request: intake's
 * own comment promises that losing the job is recoverable and losing the ticket
 * is not, and an enqueue that never returns means the ticket is lost too.
 *
 * So the producer side gets a deadline. With Redis down, intake now writes the
 * ticket, fails to queue it, records that in the event log and returns, which
 * is the degraded state the rest of the system already expects.
 */
const ENQUEUE_TIMEOUT_MS = 5_000;

export class QueueUnavailableError extends Error {
  constructor(operation: string) {
    super(`${operation} timed out after ${ENQUEUE_TIMEOUT_MS}ms. Is Redis reachable?`);
    this.name = "QueueUnavailableError";
  }
}

async function withDeadline<T>(operation: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new QueueUnavailableError(operation)), ENQUEUE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const triageQueue = () => queue<TriageJob>(QUEUE_NAMES.triage);
export const followupQueue = () => queue<FollowupJob>(QUEUE_NAMES.followup);
export const writebackQueue = () => queue<WritebackJob>(QUEUE_NAMES.writeback);
export const outboundQueue = () => queue<OutboundJob>(QUEUE_NAMES.outbound);

/**
 * Job id is derived from the ticket id, so a double-delivered webhook enqueues
 * once. `force` opts out for a deliberate re-run from the console.
 *
 * Note the separator: BullMQ rejects a custom job id containing a colon.
 */
export async function enqueueTriage(
  ticketId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const jobId = opts.force ? `triage-${ticketId}-${Date.now()}` : `triage-${ticketId}`;
  await withDeadline(
    "enqueueTriage",
    triageQueue().add("triage", { ticketId }, { jobId }),
  );
}

export async function enqueueWriteback(ticketId: string): Promise<void> {
  await withDeadline(
    "enqueueWriteback",
    writebackQueue().add("writeback", { ticketId }, { jobId: `wb-${ticketId}` }),
  );
}

/**
 * Wake a worker for one outbound message.
 *
 * Note what this job is not: it is not the message. The row in
 * `outbound_messages` is the message, and it carries its own status, attempt
 * count and retry clock. This is a doorbell, and the sweep in the worker rings
 * it again for anything that is due and unattended — so a lost job delays a
 * mail by a sweep interval instead of losing it, and a Redis outage during
 * `send_reply` is not a silently dropped reply.
 *
 * `attempts` is in the job id so a retry is a new job rather than a
 * deduplicated no-op against the completed first one.
 */
export async function enqueueOutbound(
  messageId: string,
  opts: { delayMs?: number; attempt?: number } = {},
): Promise<void> {
  const attempt = opts.attempt ?? 0;
  const jobId = attempt > 0 ? `ob-${messageId}-${attempt}` : `ob-${messageId}`;
  await withDeadline(
    "enqueueOutbound",
    outboundQueue().add(
      "deliver",
      { messageId },
      { jobId, delay: opts.delayMs && opts.delayMs > 0 ? opts.delayMs : undefined },
    ),
  );
}

/**
 * Delete every job in every queue under this process's prefix.
 *
 * For the namespaces nothing consumes — a test run's, a benchmark's — which
 * would otherwise keep every job they were ever given. Refuses the default
 * prefix: that is the worker's, and emptying it loses real triage work.
 */
export async function obliterateQueues(): Promise<void> {
  if (env.QUEUE_PREFIX === DEFAULT_QUEUE_PREFIX) {
    throw new Error(
      `refusing to obliterate the "${DEFAULT_QUEUE_PREFIX}" queues: they are the worker's`,
    );
  }
  for (const name of Object.values(QUEUE_NAMES)) {
    await withDeadline("obliterateQueues", queue(name).obliterate({ force: true }));
  }
}

export async function closeQueues(): Promise<void> {
  for (const q of queueCache.values()) await q.close();
  queueCache.clear();
  if (connectionRef) {
    connectionRef.disconnect();
    connectionRef = null;
  }
}

export interface QueueDepth {
  name: string;
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
}

export async function queueDepths(): Promise<QueueDepth[]> {
  const out: QueueDepth[] = [];
  for (const name of Object.values(QUEUE_NAMES)) {
    const q = queue(name);
    const counts = await q.getJobCounts("waiting", "active", "failed", "delayed");
    out.push({
      name,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    });
  }
  return out;
}
