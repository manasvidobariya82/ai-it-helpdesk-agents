import {
  can,
  checkHealth,
  env,
  listHeartbeats,
  recentApiRequests,
  type CheckStatus,
  type HealthCheck,
} from "@hd/core";
import { currentTenant, fmtAgo, fmtDate } from "../../../lib/tenant";

export const dynamic = "force-dynamic";

/**
 * The operator's page.
 *
 * `/healthz` answers a monitor in two words. This answers the person the
 * monitor woke up, and the difference is detail: which check failed, what it
 * said, how stale the worker's heartbeat is, what the worker thinks it is
 * running. None of that is served unauthenticated — `publicHealth` strips it —
 * so this page is where it lives.
 *
 * It exists because everything built in the last two blocks has an operational
 * surface that nobody could see: three sweeps, a delivery queue with a
 * dead-letter list, and a worker whose silence was indistinguishable from
 * health.
 */

const CHIP: Record<CheckStatus, string> = {
  ok: "pass",
  degraded: "p2",
  down: "fail",
};

const WHAT: Record<string, string> = {
  database: "Postgres. Nothing works without it, so this is the only check that can make the whole report `down`.",
  migrations: "Whether the schema is the one this build expects. Behind is degraded, not down: most requests touch tables that have existed for versions.",
  redis: "The queue's transport. Down means intake still writes tickets and records that it could not queue them.",
  queues: "Depths across the three queues. Failed jobs are retained on purpose, so a non-zero count is a prompt rather than an outage.",
  worker: "The age of the worker's last heartbeat. A crashed worker and an idle one look identical from outside; only the timestamp separates them.",
  outbound_mail: "Which mail transport is configured. `spool` and `none` are deliberate states and read as degraded because nothing reaches a requester.",
  model: "Whether model credentials are present. Without them tickets arrive, deduplicate and park for a human.",
};

function Check({ check }: { check: HealthCheck }) {
  return (
    <tr>
      <td>
        <span className="path">{check.name}</span>
      </td>
      <td>
        <span className={`chip ${CHIP[check.status]}`}>{check.status}</span>
      </td>
      <td className="sub">
        {check.latencyMs === null ? "—" : `${check.latencyMs} ms`}
      </td>
      <td className="sub">
        {check.detail ?? "—"}
        {check.data ? (
          <div className="path" style={{ marginTop: 2 }}>
            {JSON.stringify(check.data)}
          </div>
        ) : null}
      </td>
      <td className="sub">{WHAT[check.name] ?? ""}</td>
    </tr>
  );
}

export default async function SystemPage() {
  const tenant = await currentTenant("/system");
  const { ctx } = tenant;

  // Everything on this page is deployment-wide rather than tenant data, and it
  // is exactly what somebody diagnosing an outage needs — so it is gated on
  // `config:read`, the same permission that opens Settings, rather than on
  // `ticket:read` which every agent account holds.
  const mayRead = can(ctx, "config:read");
  if (!mayRead) {
    return (
      <div className="panel">
        <div className="panel-head">
          <h2>Not available</h2>
        </div>
        <div className="panel-body sub">
          System health needs <code>config:read</code>.
        </div>
      </div>
    );
  }

  // The request log is the one tenant-scoped thing on this page, and it needs
  // `security:read` rather than `config:read`: it says which integrations can
  // reach this tenant and what they have been doing.
  const maySeeTraffic = can(ctx, "security:read");
  const [report, heartbeats, traffic] = await Promise.all([
    checkHealth(),
    listHeartbeats(),
    maySeeTraffic ? recentApiRequests(ctx, 25) : Promise.resolve([]),
  ]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>System</h1>
          <div className="sub">
            Overall <span className={`chip ${CHIP[report.status]}`}>{report.status}</span>{" "}
            · this process up {Math.round(report.uptimeSeconds / 60)} min · checked{" "}
            {fmtAgo(report.at)}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Checks</h2>
          <span className="sub">
            Each one touches the thing it claims to check — a real query, a real
            Redis round trip, a real heartbeat age. A check that cannot fail is
            decoration. <code>/healthz</code> serves the same statuses with the
            detail stripped, and 503 when the deployment cannot serve requests.
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Check</th>
              <th>Status</th>
              <th>Latency</th>
              <th>Detail</th>
              <th>What it means</th>
            </tr>
          </thead>
          <tbody>
            {report.checks.map((c) => (
              <Check key={c.name} check={c} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Processes</h2>
          <span className="sub">
            A heartbeat every 20 seconds. Nothing ever writes "stopped" — the row
            simply stops being updated, which is the only way a crash gets
            noticed.
          </span>
        </div>
        {heartbeats.length === 0 ? (
          <div className="empty">
            No process has reported in. Start the worker: <code>npm run dev:worker</code>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Process</th>
                <th>Host</th>
                <th>Started</th>
                <th>Last seen</th>
                <th>Running</th>
              </tr>
            </thead>
            <tbody>
              {heartbeats.map((h) => (
                <tr key={h.id}>
                  <td>
                    <span className="path">{h.id}</span>
                    <div className="sub">{h.kind}</div>
                  </td>
                  <td className="sub">
                    {h.hostname ?? "—"}
                    {h.pid ? ` · pid ${h.pid}` : ""}
                  </td>
                  <td className="sub">{fmtDate(h.started_at)}</td>
                  <td className="sub">{fmtAgo(h.last_seen_at)}</td>
                  <td className="sub">
                    <code>{JSON.stringify(h.detail)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {maySeeTraffic ? (
        <div className="panel">
          <div className="panel-head">
            <h2>API traffic</h2>
            <span className="sub">
              The last 25 requests this tenant&apos;s keys made. The same rows are
              what the per-minute rate limit counts, which is why they are a
              table rather than a counter — a counter enforces the limit and
              remembers nothing. Refusals are logged too: a 401 or a 403 from a
              key is more interesting than a 200, and a log holding only
              successes cannot show somebody probing.
            </span>
          </div>
          {traffic.length === 0 ? (
            <div className="empty">
              Nothing yet. Issue a key in <a href="/settings">Settings</a> and call{" "}
              <code>GET /api/v1/tickets</code>.
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Key</th>
                  <th>Request</th>
                  <th>Status</th>
                  <th>Latency</th>
                </tr>
              </thead>
              <tbody>
                {traffic.map((r) => (
                  <tr key={r.id}>
                    <td className="sub">{fmtAgo(r.created_at)}</td>
                    <td className="sub">{r.key_name ?? "revoked key"}</td>
                    <td>
                      <span className="path">
                        {r.method} {r.path}
                      </span>
                    </td>
                    <td>
                      <span className={`chip ${r.status < 400 ? "pass" : "fail"}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="sub">
                      {r.latency_ms === null ? "—" : `${r.latency_ms} ms`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h2>Endpoints</h2>
        </div>
        <table>
          <thead>
            <tr>
              <th>Path</th>
              <th>Auth</th>
              <th>What it is for</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <span className="path">GET /healthz</span>
              </td>
              <td className="sub">none</td>
              <td className="sub">
                Every check, names and statuses only. 200 while requests can be
                served, 503 when they cannot.
              </td>
            </tr>
            <tr>
              <td>
                <span className="path">GET /readyz</span>
              </td>
              <td className="sub">none</td>
              <td className="sub">
                For a load balancer. Narrower on purpose: a deployment with no
                mail transport is ready, one that cannot reach its database is
                not.
              </td>
            </tr>
            <tr>
              <td>
                <span className="path">GET /api/v1/tickets</span>
              </td>
              <td className="sub">API key</td>
              <td className="sub">
                List and create, with the key's role deciding which. Keys are in{" "}
                <a href="/settings">Settings</a>.
              </td>
            </tr>
            <tr>
              <td>
                <span className="path">POST /api/intake/email</span>
              </td>
              <td className="sub">intake token</td>
              <td className="sub">Inbound mail, per tenant.</td>
            </tr>
            <tr>
              <td>
                <span className="path">POST /api/outbound/events</span>
              </td>
              <td className="sub">intake token</td>
              <td className="sub">Bounces and delivery events from the provider.</td>
            </tr>
          </tbody>
        </table>
        <div className="panel-body sub">
          Deployment mode <code>{env.AGENT_MODE}</code> · transport{" "}
          <code>{env.OUTBOUND_EMAIL_PROVIDER}</code> · base URL{" "}
          <code>{env.APP_BASE_URL}</code>
        </div>
      </div>
    </>
  );
}
