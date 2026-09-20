import { query, queryOne } from "../db.js";

/**
 * Process liveness.
 *
 * Deployment-wide, and therefore the one part of the data layer with no tenant
 * context: "is the worker running" is not a question about a tenant, and making
 * it one would mean a health check had to pick a business to ask about.
 *
 * The shape is a heartbeat rather than a status, because a process cannot be
 * relied on to report its own death. Nothing writes "stopped"; the row simply
 * stops being updated, and the reader decides how much staleness is a problem.
 * That is the difference between a monitor that notices a crash and one that
 * only notices a graceful shutdown.
 */

export interface Heartbeat {
  id: string;
  kind: string;
  hostname: string | null;
  pid: number | null;
  version: string | null;
  started_at: Date;
  last_seen_at: Date;
  detail: Record<string, unknown>;
}

export interface HeartbeatInput {
  /** Stable per process role, so a restart updates rather than accumulates. */
  id: string;
  kind: "worker" | "web" | "cron";
  hostname?: string | null;
  pid?: number | null;
  /**
   * When this process started. The row is per role, so it outlives the process
   * that wrote it; without this a restart keeps the first boot's time. Omitted,
   * a new row gets now() and an existing one keeps what it had.
   */
  started_at?: Date | null;
  version?: string | null;
  detail?: Record<string, unknown>;
}

export async function recordHeartbeat(input: HeartbeatInput): Promise<void> {
  await query(
    `insert into worker_heartbeats
       (id, kind, hostname, pid, version, detail, started_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, coalesce($7::timestamptz, now()))
     on conflict (id) do update
       set last_seen_at = now(),
           kind = excluded.kind,
           hostname = excluded.hostname,
           pid = excluded.pid,
           version = excluded.version,
           detail = excluded.detail,
           started_at = coalesce($7::timestamptz, worker_heartbeats.started_at)`,
    [
      input.id,
      input.kind,
      input.hostname ?? null,
      input.pid ?? null,
      input.version ?? null,
      JSON.stringify(input.detail ?? {}),
      input.started_at ?? null,
    ],
  );
}

export async function listHeartbeats(): Promise<Heartbeat[]> {
  return query<Heartbeat>(
    `select * from worker_heartbeats order by kind, id`,
  );
}

/**
 * The freshest heartbeat of one kind, and how stale it is.
 *
 * Returns seconds rather than a verdict: how long is too long is a policy
 * question, and it belongs with the other policy in `health.ts` rather than in
 * a query.
 */
export async function latestHeartbeat(
  kind: string,
): Promise<{ id: string; seconds_ago: number; detail: Record<string, unknown> } | null> {
  return queryOne<{ id: string; seconds_ago: number; detail: Record<string, unknown> }>(
    `select id,
            extract(epoch from (now() - last_seen_at))::int as seconds_ago,
            detail
       from worker_heartbeats
      where kind = $1
      order by last_seen_at desc
      limit 1`,
    [kind],
  );
}

/** Drop a heartbeat row, for a process shutting down deliberately. */
export async function clearHeartbeat(id: string): Promise<void> {
  await query(`delete from worker_heartbeats where id = $1`, [id]);
}
