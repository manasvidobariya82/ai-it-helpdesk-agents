import { queryOne } from "./db.js";
import { env } from "./env.js";
import { queueDepths } from "./queue.js";
import { connection } from "./queue.js";
import { latestHeartbeat } from "./repos/heartbeats.js";

/**
 * Is this deployment working?
 *
 * The question a health check has to answer is narrower than it looks. Not "is
 * everything fine" — nothing can know that — but "would a request that arrived
 * now be handled, and if not, which dependency is the reason". Everything below
 * is shaped by three rules learned from health checks that were worse than
 * nothing:
 *
 * **A check that cannot fail is decoration.** Every one of these touches the
 * thing it claims to check: a real query, a real Redis round trip, a real
 * heartbeat row with a real age. `status: "ok"` from a function that only reads
 * configuration is a lie with a green tick on it.
 *
 * **Silence is not health.** The worker has no way to report its own death, so
 * liveness is the *age* of a heartbeat rather than a status somebody wrote. A
 * process that crashed four hours ago and one that is idle look identical from
 * the outside, and only the timestamp separates them.
 *
 * **An unauthenticated endpoint may not explain itself.** `checkHealth` gathers
 * detail — error text, queue depths, versions — because the console needs it.
 * `publicHealth` strips all of it, because `/healthz` is reachable by anybody
 * and a stack trace in a health response is reconnaissance. The distinction is
 * in this file rather than in the route, so a second route cannot get it wrong.
 */

export type CheckStatus = "ok" | "degraded" | "down";

export interface HealthCheck {
  name: string;
  status: CheckStatus;
  /** Round-trip time where the check made a call; null where it did not. */
  latencyMs: number | null;
  /** For the console only. Never served unauthenticated. */
  detail?: string;
  /** Structured extras for the console, same rule. */
  data?: Record<string, unknown>;
}

export interface HealthReport {
  status: CheckStatus;
  checks: HealthCheck[];
  at: string;
  /** Seconds this process has been up. */
  uptimeSeconds: number;
}

/**
 * The migration this build expects the database to be at.
 *
 * Bumped with every migration, and `packages/core/test/health.test.ts` fails
 * the build when it does not match the highest-numbered file in
 * `db/migrations` — so the constant cannot rot quietly.
 *
 * It earns its place by catching the specific outage where the code is deployed
 * and the migration is not. Every symptom of that is a confusing error
 * somewhere else: a missing column in a query nobody changed, a tool that
 * throws on a table that does not exist yet.
 */
export const EXPECTED_MIGRATION = "0020_conversation_legacy.sql";

/** Dependencies whose failure means requests cannot be served at all. */
const FATAL = new Set(["database"]);

const startedAt = Date.now();

export async function checkHealth(): Promise<HealthReport> {
  const checks = [
    await checkDatabase(),
    await checkMigrations(),
    await checkRedis(),
    await checkQueues(),
    await checkWorker(),
    checkOutbound(),
    checkModel(),
  ];

  return {
    status: overallStatus(checks),
    checks,
    at: new Date().toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  };
}

/**
 * The worst thing that matters.
 *
 * A fatal dependency being down makes the whole report down. Anything else
 * being down is a degradation: the agent cannot work without Redis, but the
 * console can still show a queue and a person can still answer a ticket, and
 * reporting that as a total outage would train whoever is on call to ignore it.
 */
export function overallStatus(checks: HealthCheck[]): CheckStatus {
  if (checks.some((c) => c.status === "down" && FATAL.has(c.name))) return "down";
  if (checks.some((c) => c.status !== "ok")) return "degraded";
  return "ok";
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: unknown }> {
  const started = Date.now();
  try {
    const value = await fn();
    return { ms: Date.now() - started, value };
  } catch (error) {
    return { ms: Date.now() - started, error };
  }
}

/**
 * A dependency that hangs is down, not slow. A health check must answer.
 *
 * The timer is cleared once the race is decided. It used to be left running,
 * so every check that answered in time still held a pending timer for the full
 * timeout — five per `/healthz` hit, for a monitor that polls every few
 * seconds.
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not answer in ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const DB_TIMEOUT_MS = 2_000;
const REDIS_TIMEOUT_MS = 2_000;
/** Above this, the database is answering but something is wrong. */
const DB_SLOW_MS = 500;

async function checkDatabase(): Promise<HealthCheck> {
  const result = await timed(() =>
    withTimeout(
      queryOne<{ now: Date; connections: number }>(
        `select now() as now,
                (select count(*)::int from pg_stat_activity
                  where datname = current_database()) as connections`,
      ),
      DB_TIMEOUT_MS,
      "database",
    ),
  );

  if (result.error) {
    return {
      name: "database",
      status: "down",
      latencyMs: result.ms,
      detail: message(result.error),
    };
  }
  return {
    name: "database",
    status: result.ms > DB_SLOW_MS ? "degraded" : "ok",
    latencyMs: result.ms,
    data: { connections: result.value?.connections ?? null },
    detail: result.ms > DB_SLOW_MS ? `a simple query took ${result.ms}ms` : undefined,
  };
}

/**
 * Is the schema the one this build was written against?
 *
 * Reported as degraded rather than down when the database is behind. The
 * deployment usually still works — most requests touch tables that have existed
 * for versions — and turning a rolling deploy into a hard outage for the thirty
 * seconds between the code and the migration would be its own incident.
 */
async function checkMigrations(): Promise<HealthCheck> {
  const result = await timed(() =>
    withTimeout(
      queryOne<{ latest: string | null; applied: number }>(
        `select max(filename) as latest, count(*)::int as applied from schema_migrations`,
      ),
      DB_TIMEOUT_MS,
      "migrations",
    ),
  );

  if (result.error) {
    return {
      name: "migrations",
      status: "down",
      latencyMs: result.ms,
      detail: message(result.error),
    };
  }

  const latest = result.value?.latest ?? null;
  const matches = latest === EXPECTED_MIGRATION;
  return {
    name: "migrations",
    status: matches ? "ok" : "degraded",
    latencyMs: result.ms,
    data: { latest, expected: EXPECTED_MIGRATION, applied: result.value?.applied ?? 0 },
    detail: matches
      ? undefined
      : latest === null
        ? "no migrations applied; run npm run db:migrate"
        : `database is at ${latest}, this build expects ${EXPECTED_MIGRATION}`,
  };
}

async function checkRedis(): Promise<HealthCheck> {
  const result = await timed(() =>
    withTimeout(connection().ping(), REDIS_TIMEOUT_MS, "redis"),
  );
  if (result.error) {
    // Not fatal: intake still writes the ticket and records that it could not
    // be queued, which is the degraded state the rest of the system expects.
    return {
      name: "redis",
      status: "down",
      latencyMs: result.ms,
      detail: message(result.error),
    };
  }
  return { name: "redis", status: "ok", latencyMs: result.ms };
}

/** Beyond this many waiting jobs, something upstream is faster than the worker. */
const QUEUE_BACKLOG = 100;

async function checkQueues(): Promise<HealthCheck> {
  const result = await timed(() =>
    withTimeout(queueDepths(), REDIS_TIMEOUT_MS, "queues"),
  );
  if (result.error || !result.value) {
    return {
      name: "queues",
      status: "down",
      latencyMs: result.ms,
      detail: message(result.error),
    };
  }

  const depths = result.value;
  const waiting = depths.reduce((n, q) => n + q.waiting, 0);
  const failed = depths.reduce((n, q) => n + q.failed, 0);
  // Failures are retained on purpose, so their presence is not an outage — but
  // a dead-letter pile nobody has looked at is exactly what a health page is
  // for.
  const status: CheckStatus = waiting > QUEUE_BACKLOG || failed > 0 ? "degraded" : "ok";

  return {
    name: "queues",
    status,
    latencyMs: result.ms,
    data: { waiting, failed, queues: depths },
    detail:
      status === "ok"
        ? undefined
        : `${waiting} waiting, ${failed} failed across ${depths.length} queues`,
  };
}

/** A heartbeat older than this means nobody is consuming the queues. */
const HEARTBEAT_STALE_SECONDS = 90;
const HEARTBEAT_DEAD_SECONDS = 300;

/**
 * How much staleness is a problem.
 *
 * Separated from the check so it can be tested without a database and without a
 * worker: the verdict is arithmetic on an age, and a test that has to arrange
 * for no worker to be running in order to observe `down` is a test that passes
 * or fails depending on what else the developer has open.
 *
 * The numbers are against a 20-second beat, so one missed write is not an alert
 * and four are.
 */
export function workerStatus(secondsAgo: number): CheckStatus {
  if (secondsAgo > HEARTBEAT_DEAD_SECONDS) return "down";
  if (secondsAgo > HEARTBEAT_STALE_SECONDS) return "degraded";
  return "ok";
}

async function checkWorker(): Promise<HealthCheck> {
  const result = await timed(() =>
    withTimeout(latestHeartbeat("worker"), DB_TIMEOUT_MS, "worker heartbeat"),
  );
  if (result.error) {
    return {
      name: "worker",
      status: "down",
      latencyMs: result.ms,
      detail: message(result.error),
    };
  }

  const beat = result.value ?? null;
  if (!beat) {
    return {
      name: "worker",
      status: "down",
      latencyMs: result.ms,
      detail: "no worker has ever reported in; start it with npm run dev:worker",
    };
  }

  const age = beat.seconds_ago;
  const status = workerStatus(age);

  return {
    name: "worker",
    status,
    latencyMs: result.ms,
    data: { id: beat.id, secondsAgo: age, detail: beat.detail },
    detail:
      status === "ok"
        ? undefined
        : `last heartbeat ${age}s ago from ${beat.id}; triage, delivery and the sweeps are not running`,
  };
}

/**
 * Configuration checks, which is why they take no time and cannot be "down".
 *
 * A deployment with no mail transport and no model key is not broken — both are
 * deliberate states, and the shadow-mode default is one of them. Saying so on
 * the health page is still worth it: "nothing has been sent all week" has two
 * explanations, and this is the one nobody thinks of.
 */
function checkOutbound(): HealthCheck {
  const provider = env.OUTBOUND_EMAIL_PROVIDER;
  const real = provider === "smtp" || provider === "postmark";
  return {
    name: "outbound_mail",
    status: real ? "ok" : "degraded",
    latencyMs: null,
    data: { provider },
    detail: real
      ? undefined
      : provider === "spool"
        ? "spooling to a folder; nothing reaches a requester"
        : "no transport configured; replies are recorded and cancelled",
  };
}

function checkModel(): HealthCheck {
  const configured = Boolean(env.ANTHROPIC_API_KEY);
  return {
    name: "model",
    status: configured ? "ok" : "degraded",
    latencyMs: null,
    data: { mode: env.AGENT_MODE, triage_model: env.TRIAGE_MODEL },
    detail: configured
      ? undefined
      : "no model credentials; tickets arrive and park for a human",
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface PublicHealth {
  status: CheckStatus;
  checks: { name: string; status: CheckStatus }[];
  at: string;
}

/**
 * The projection served without a session.
 *
 * Names and statuses, nothing else. A monitor needs to know that `database` is
 * down; it does not need the connection string in the error, the queue depths,
 * the model in use, or how many connections the database has. Every one of
 * those is a small gift to somebody enumerating the deployment, and none of
 * them changes what the monitor does.
 */
export function publicHealth(report: HealthReport): PublicHealth {
  return {
    status: report.status,
    checks: report.checks.map((c) => ({ name: c.name, status: c.status })),
    at: report.at,
  };
}

/**
 * Readiness: should this process receive traffic?
 *
 * Narrower than health on purpose. A deployment with no model key and no mail
 * transport is perfectly able to serve the console, so it is ready. One that
 * cannot reach its database is not, whatever else is true — and a load balancer
 * that keeps sending requests to it turns one broken instance into an outage.
 */
export function isReady(report: HealthReport): boolean {
  return !report.checks.some((c) => FATAL.has(c.name) && c.status === "down");
}
