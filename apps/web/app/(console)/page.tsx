import {
  can,
  listStaff,
  listTickets,
  policyFor,
  queueDepths,
  slaStatus,
  type TicketStatus,
} from "@hd/core";
import { currentTenant, fmtDelta } from "../../lib/tenant";
import { QueueTable, type QueueRow } from "./queue-table";

export const dynamic = "force-dynamic";

const OPEN: TicketStatus[] = [
  "new",
  "triaged",
  "awaiting_user",
  "awaiting_approval",
  "in_progress",
  "reopened",
];

const FILTERS: { key: string; label: string; status?: TicketStatus[] }[] = [
  { key: "open", label: "Open", status: OPEN },
  { key: "needs_human", label: "Needs a human", status: ["triaged", "awaiting_approval"] },
  { key: "waiting", label: "Waiting on user", status: ["awaiting_user"] },
  { key: "resolved", label: "Resolved", status: ["resolved", "closed"] },
  { key: "all", label: "All" },
];

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ f?: string; q?: string }>;
}) {
  const { f, q } = await searchParams;
  // Redirects to sign-in when there is no session; the tenant is the session's,
  // never a query parameter's.
  const tenant = await currentTenant("/");
  const { ctx } = tenant;

  const filter = FILTERS.find((x) => x.key === f) ?? FILTERS[0]!;
  const [tickets, staff] = await Promise.all([
    listTickets(ctx, {
      status: filter.status,
      search: q,
      limit: 100,
    }),
    listStaff(ctx),
  ]);

  const rows: QueueRow[] = tickets.map((t) => {
    const sla = slaStatus(t);
    // The first-response clock is the one that matters while a ticket is open;
    // once it is answered, the resolution clock takes over.
    const state = t.first_response_at ? sla.resolution : sla.firstResponse;
    return {
      ...t,
      threshold: policyFor(tenant.settings, t.category ?? "other").confidence_threshold,
      sla_state: state,
      sla_label:
        state === "none"
          ? "—"
          : state === "met"
            ? "met"
            : // A stopped clock shows that it is stopped rather than a
              // countdown that is not counting down.
              state === "paused"
              ? "paused"
              : fmtDelta(sla.minutesToNearest),
      cost_usd: null,
    };
  });

  let depths: Awaited<ReturnType<typeof queueDepths>> = [];
  try {
    depths = await queueDepths();
  } catch {
    // Redis down: the queue widget disappears, the ticket list does not.
  }
  const inFlight = depths.reduce((n, d) => n + d.waiting + d.active, 0);
  const failed = depths.reduce((n, d) => n + d.failed, 0);
  const breached = rows.filter((r) => r.sla_state === "breached").length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Queue</h1>
          <div className="sub">
            {rows.length} ticket{rows.length === 1 ? "" : "s"}
            {breached > 0 ? ` · ${breached} past SLA` : ""}
            {inFlight > 0 ? ` · ${inFlight} in flight` : ""}
            {failed > 0 ? ` · ${failed} failed job${failed === 1 ? "" : "s"}` : ""}
          </div>
        </div>
        <form className="row" action="/">
          <input type="hidden" name="f" value={filter.key} />
          <input
            type="text"
            name="q"
            placeholder="Search subject or body"
            defaultValue={q ?? ""}
          />
          <button type="submit">Search</button>
        </form>
      </div>

      <div className="filters">
        {FILTERS.map((x) => (
          <a
            key={x.key}
            href={`/?f=${x.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
            className={x.key === filter.key ? "active" : ""}
          >
            {x.label}
          </a>
        ))}
      </div>

      <QueueTable
        rows={rows}
        staff={staff}
        canAssign={can(ctx, "ticket:assign")}
        canUpdate={can(ctx, "ticket:update")}
      />
    </>
  );
}
