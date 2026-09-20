import { can, expiredApprovals, pendingApprovals } from "@hd/core";
import { getTool, listTools } from "@hd/tools";
import { currentTenant, fmtAgo, fmtDelta } from "../../../lib/tenant";
import { approveAction, rejectAction } from "./actions";

export const dynamic = "force-dynamic";

/** Inside an hour, so the countdown is worth colouring. */
function expiringSoon(at: Date | null): boolean {
  if (!at) return true;
  return new Date(at).getTime() - Date.now() < 60 * 60 * 1000;
}

const TIER_NOTE: Record<string, string> = {
  read: "Reads only. Never queued for approval.",
  internal: "Writes only to our own ticket record. Never queued - escalation must always be possible.",
  safe_write: "Reversible. Can be whitelisted per tenant for unattended use.",
  sensitive: "Reversible but consequential. Always a human.",
  destructive: "Irreversible or security-affecting. No setting can automate it.",
};

export default async function ApprovalsPage() {
  const tenant = await currentTenant("/approvals");
  const { ctx } = tenant;

  const [pending, lapsed] = await Promise.all([
    pendingApprovals(ctx),
    expiredApprovals(ctx, 10),
  ]);
  // Approving is a permission, not a page. A viewer who reaches this URL sees
  // the queue and no buttons, and the server action refuses them anyway.
  const mayApprove = can(ctx, "action:approve");
  const tools = listTools("helpdesk");
  const whitelist = new Set(tenant.settings.auto_action_whitelist);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <div className="sub">
            {pending.length === 0
              ? "Nothing waiting"
              : `${pending.length} action${pending.length === 1 ? "" : "s"} waiting on a human`}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Queue</h2>
        </div>
        {pending.length === 0 ? (
          <div className="empty">
            No pending actions. The agent queues anything above the safe tier here
            instead of running it.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Ticket</th>
                <th>Tier</th>
                <th>Why</th>
                <th>Age</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pending.map((a) => {
                const tool = getTool(a.tool_name);
                return (
                  <tr key={a.id}>
                    <td>
                      <div className="subject">
                        {tool ? tool.summarize(a.args) : a.tool_name}
                      </div>
                      <div className="path">{a.tool_name}</div>
                    </td>
                    <td>
                      <a href={`/tickets/${a.ticket_id}`}>{a.subject}</a>
                    </td>
                    <td>
                      <span
                        className={`chip ${a.risk_tier === "destructive" ? "p1" : a.risk_tier === "sensitive" ? "p2" : "p3"}`}
                      >
                        {a.risk_tier}
                      </span>
                    </td>
                    <td className="sub">{a.rationale}</td>
                    <td className="sub">
                      {fmtAgo(a.created_at)}
                      {/* The deadline matters more than the age: it is the
                          thing that decides whether this can still run. */}
                      <div className={expiringSoon(a.expires_at) ? "sla sla-due_soon" : ""}>
                        expires{" "}
                        {fmtDelta(
                          a.expires_at
                            ? Math.round(
                                (new Date(a.expires_at).getTime() - Date.now()) / 60000,
                              )
                            : null,
                        )}
                      </div>
                    </td>
                    <td>
                      {mayApprove ? (
                        <div className="row">
                          <form
                            action={async (formData: FormData) => {
                              "use server";
                              await approveAction(a.id, String(formData.get("reason") ?? ""));
                            }}
                          >
                            <input
                              type="text"
                              name="reason"
                              placeholder="Why (optional)"
                              style={{ width: 140 }}
                            />
                            <button className="primary" type="submit">
                              Approve
                            </button>
                          </form>
                          <form
                            action={async (formData: FormData) => {
                              "use server";
                              await rejectAction(a.id, String(formData.get("reason") ?? ""));
                            }}
                          >
                            <button className="danger" type="submit">
                              Reject
                            </button>
                          </form>
                        </div>
                      ) : (
                        <span className="sub" title="Requires action:approve">
                          read only
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Tool permissions</h2>
          <span className="sub">
            Whitelist is explicit. Anything not listed needs a human, by default.
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Tier</th>
              <th>Unattended?</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => {
              const unattended =
                t.riskTier === "read" || t.riskTier === "internal"
                  ? "always"
                  : t.riskTier === "safe_write"
                    ? whitelist.has(t.name)
                      ? "yes, whitelisted"
                      : "no"
                    : "never";
              return (
                <tr key={t.name}>
                  <td>
                    <span className="path">{t.name}</span>
                  </td>
                  <td>
                    <span
                      className={`chip ${t.riskTier === "destructive" ? "p1" : t.riskTier === "sensitive" ? "p2" : t.riskTier === "safe_write" ? "p3" : "p4"}`}
                    >
                      {t.riskTier}
                    </span>
                  </td>
                  <td className={unattended === "never" ? "sub" : ""}>{unattended}</td>
                  <td className="sub">
                    {t.description}
                    <br />
                    <em>{TIER_NOTE[t.riskTier]}</em>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/*
        Lapsed requests, shown rather than swept out of sight. An approval that
        expires in silence is indistinguishable from one that was quietly
        denied, and somebody is still waiting on the action it was about.
      */}
      {lapsed.length > 0 ? (
        <div className="panel">
          <div className="panel-head">
            <h2>Expired</h2>
            <span className="sub">
              Nobody decided these in time, so they will not run. Raise them
              again if they are still wanted — an expired approval cannot be
              revived.
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Action</th>
                <th>Why it was asked for</th>
                <th>Asked</th>
              </tr>
            </thead>
            <tbody>
              {lapsed.map((a) => (
                <tr key={a.id}>
                  <td>
                    <a href={`/tickets/${a.ticket_id}`}>{a.subject}</a>
                  </td>
                  <td>
                    <code>{a.tool_name}</code>
                  </td>
                  <td className="sub">{a.rationale}</td>
                  <td className="sub">{fmtAgo(a.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
