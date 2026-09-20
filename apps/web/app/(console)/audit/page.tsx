import { classifyField, countAudit, listAudit } from "@hd/core";
import { currentTenant, fmtDate } from "../../../lib/tenant";

export const dynamic = "force-dynamic";

/**
 * The audit trail.
 *
 * `ticket_events` answers "why did the agent close this ticket". It cannot
 * answer "who widened a category's autonomy on Friday afternoon", because that
 * change belongs to no ticket. This does.
 *
 * Gated on `audit:read`, which an agent account does not hold: the log records
 * who did what, and browsing it is not part of working a queue. Every filter
 * narrows — none of them can widen past the tenant, which comes from the
 * session and is not in this form.
 */

const VIEWS: { key: string; label: string; actions?: string[] }[] = [
  { key: "", label: "Everything" },
  {
    key: "config",
    label: "Configuration",
    actions: [
      "config.update",
      "config.autonomy_change",
      "config.rollback",
      "config.change_proposed",
      "config.change_approved",
      "config.change_rejected",
    ],
  },
  { key: "autonomy", label: "Autonomy only", actions: ["config.autonomy_change"] },
  { key: "approvals", label: "Approvals", actions: ["approval.decide"] },
  {
    key: "secrets",
    label: "Credentials",
    actions: ["credentials.read", "credentials.update"],
  },
  {
    key: "access",
    label: "Access",
    actions: ["user.invite", "user.role_change", "user.deactivate"],
  },
  {
    key: "refusals",
    label: "Refusals",
    actions: ["authz.denied", "auth.sign_in_failed"],
  },
];

/** Refusals and secret-adjacent reads are the rows worth noticing. */
const NOTABLE = new Set([
  "authz.denied",
  "auth.sign_in_failed",
  "config.autonomy_change",
  "config.rollback",
  "credentials.read",
  "credentials.update",
]);

const PAGE_SIZE = 100;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    q?: string;
    field?: string;
    actor?: string;
    version?: string;
    since?: string;
    page?: string;
  }>;
}) {
  const sp = await searchParams;
  const tenant = await currentTenant("/audit");

  const view = VIEWS.find((v) => v.key === (sp.view ?? "")) ?? VIEWS[0]!;
  const pageNum = Math.max(1, Number(sp.page ?? "1") || 1);
  const since = sp.since ? new Date(sp.since) : undefined;

  const filters = {
    ...(view.actions ? { actions: view.actions } : {}),
    ...(sp.q ? { search: sp.q } : {}),
    ...(sp.field ? { fieldPrefix: sp.field } : {}),
    ...(sp.actor ? { actorEmail: sp.actor } : {}),
    ...(sp.version ? { configVersion: Number(sp.version) } : {}),
    ...(since && !Number.isNaN(since.getTime()) ? { since } : {}),
  };

  const [rows, total] = await Promise.all([
    listAudit(tenant.ctx, {
      ...filters,
      limit: PAGE_SIZE,
      offset: (pageNum - 1) * PAGE_SIZE,
    }),
    countAudit(tenant.ctx, filters),
  ]);

  const qs = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged = {
      view: sp.view,
      q: sp.q,
      field: sp.field,
      actor: sp.actor,
      version: sp.version,
      since: sp.since,
      ...patch,
    };
    for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
    const s = params.toString();
    return s ? `/audit?${s}` : "/audit";
  };

  const filtered =
    Boolean(sp.q || sp.field || sp.actor || sp.version || sp.since) ||
    Boolean(view.actions);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <div className="sub">
            {total} event{total === 1 ? "" : "s"}
            {filtered ? " matching" : ""} in {tenant.business.name}. Append-only:
            the database refuses updates and deletes on this table.
          </div>
        </div>
      </div>

      <div className="filters">
        {VIEWS.map((v) => (
          <a
            key={v.key || "all"}
            href={qs({ view: v.key || undefined, page: undefined })}
            className={(sp.view ?? "") === v.key ? "active" : ""}
          >
            {v.label}
          </a>
        ))}
      </div>

      <form className="audit-filters" action="/audit">
        <input type="hidden" name="view" value={sp.view ?? ""} />
        <label>
          Search
          <input
            type="text"
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="reason, field, actor, action"
          />
        </label>
        <label>
          Setting
          <input
            type="text"
            name="field"
            defaultValue={sp.field ?? ""}
            placeholder="category_policies.vpn"
          />
        </label>
        <label>
          Actor
          <input
            type="email"
            name="actor"
            defaultValue={sp.actor ?? ""}
            placeholder="admin@example.com"
          />
        </label>
        <label>
          Version
          <input
            type="number"
            name="version"
            defaultValue={sp.version ?? ""}
            placeholder="17"
            min="1"
          />
        </label>
        <label>
          Since
          <input type="date" name="since" defaultValue={sp.since ?? ""} />
        </label>
        <button type="submit">Filter</button>
        {filtered ? <a href={qs({ view: sp.view })}>Clear</a> : null}
      </form>

      <div className="panel">
        {rows.length === 0 ? (
          <div className="empty">
            Nothing recorded for this filter. Change a setting or approve an
            action and it will appear here.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Setting / resource</th>
                <th>Change</th>
                <th>Reason</th>
                <th>v</th>
                <th>Where from</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const meta = (r.metadata ?? null) as {
                  risk?: string;
                  direction?: string;
                  impact?: string;
                } | null;
                return (
                  <tr key={r.id}>
                    <td className="sub" style={{ whiteSpace: "nowrap" }}>
                      {fmtDate(r.created_at)}
                    </td>
                    <td>
                      {r.actor_email ?? <span className="sub">{r.actor_type}</span>}
                      <div className="sub">{r.actor_role ?? r.actor_type}</div>
                    </td>
                    <td>
                      <code
                        className={NOTABLE.has(r.action) ? "audit-notable" : undefined}
                      >
                        {r.action}
                      </code>
                      {meta?.direction === "widening" ? (
                        <div>
                          <span className="chip p1">widening</span>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {r.field ? (
                        <>
                          <a href={qs({ field: r.field, page: undefined })}>
                            <code>{r.field}</code>
                          </a>
                          {classifyField(r.field) === "critical" ? (
                            <span className="chip p2"> critical</span>
                          ) : null}
                        </>
                      ) : (
                        <>
                          {r.resource_type}
                          {r.resource_id ? (
                            <div className="sub">
                              <code>{r.resource_id}</code>
                            </div>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td className="audit-change">
                      {r.old_value === null && r.new_value === null ? (
                        <span className="sub">—</span>
                      ) : (
                        <>
                          <code>{JSON.stringify(r.old_value)}</code>
                          {" → "}
                          <code>{JSON.stringify(r.new_value)}</code>
                        </>
                      )}
                      {meta?.impact ? (
                        <div className="sub">{meta.impact}</div>
                      ) : null}
                    </td>
                    <td className="sub">{r.reason ?? "—"}</td>
                    <td className="sub">
                      {r.config_version ? (
                        <a href={qs({ version: String(r.config_version), page: undefined })}>
                          v{r.config_version}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="sub">
                      {r.ip ?? "—"}
                      {r.request_id ? (
                        <div title="Request id — ties one click's rows together">
                          <code>{r.request_id.slice(0, 8)}</code>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="row">
        {pageNum > 1 ? (
          <a href={qs({ page: String(pageNum - 1) })}>← Newer</a>
        ) : null}
        {pageNum * PAGE_SIZE < total ? (
          <a href={qs({ page: String(pageNum + 1) })}>Older →</a>
        ) : null}
      </div>
    </>
  );
}
