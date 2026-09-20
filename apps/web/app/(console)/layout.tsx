import type { Metadata } from "next";
import { can, env, pendingApprovals } from "@hd/core";
import { currentTenant } from "../../lib/tenant";
import { selectTenantAction, signOutAction } from "../(auth)/actions";
import "../globals.css";

export const metadata: Metadata = {
  title: "Helpdesk agent console",
  description: "Ticket triage, review queue and autonomy controls",
};

export const dynamic = "force-dynamic";

const MODE_COPY: Record<string, string> = {
  shadow:
    "Shadow mode. The agent classifies every ticket and drafts a reply, and sends nothing. Its decisions are recorded against what your team actually does.",
  assist:
    "Assist mode. The agent drafts; a human clicks send. Nothing reaches a requester unreviewed.",
  auto:
    "Auto mode. Categories with autonomy enabled are answered unattended above their confidence threshold. Everything else still comes here.",
};

/**
 * The console shell.
 *
 * Two changes worth naming. `currentTenant()` now redirects to sign-in rather
 * than rendering an empty state, so no console page can render for somebody
 * who is not authenticated — the guard is in the layout and cannot be
 * forgotten on a new page. And the navigation is filtered by permission.
 *
 * Filtering the menu is a convenience, not a control: every page and every
 * action re-checks. A hidden link that is still routable is the most common
 * way an "RBAC" turns out to be a stylesheet.
 */
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const tenant = await currentTenant();
  const { ctx } = tenant;

  let approvals = 0;
  try {
    approvals = (await pendingApprovals(ctx)).length;
  } catch {
    // The badge is decoration; a database hiccup should not blank the console.
  }

  const mode = tenant.mode;
  const overridden = Boolean(tenant.settings.agent_mode_override);
  const user = tenant.session.session.user;

  const nav: { href: string; label: string; show: boolean }[] = [
    { href: "/", label: "Queue", show: can(ctx, "ticket:read") },
    {
      href: "/approvals",
      label: `Approvals${approvals > 0 ? ` (${approvals})` : ""}`,
      show: can(ctx, "ticket:read"),
    },
    { href: "/knowledge", label: "Knowledge base", show: can(ctx, "kb:read") },
    // Delivery state is part of "did the requester actually hear from us",
    // which is a ticket question, so it is visible to anyone who can read
    // tickets. Acting on it needs `action:execute`, checked on the page.
    { href: "/mail", label: "Outbound mail", show: can(ctx, "ticket:read") },
    { href: "/analytics", label: "Analytics", show: can(ctx, "analytics:read") },
    { href: "/audit", label: "Audit log", show: can(ctx, "audit:read") },
    { href: "/settings", label: "Settings", show: can(ctx, "config:read") },
    // Deployment health rather than tenant data, so it sits with configuration
    // rather than with the queue: `config:read` is the permission that already
    // means "you are here to operate this thing".
    { href: "/system", label: "System", show: can(ctx, "config:read") },
  ];

  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
              Helpdesk agent
              <span>{tenant.business.name}</span>
            </div>

            {tenant.switchable.length > 1 ? (
              <form action={selectTenantAction}>
                <select
                  name="business_id"
                  defaultValue={tenant.business.id}
                  style={{ width: "100%" }}
                >
                  {tenant.switchable.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <button type="submit" style={{ marginTop: 6, width: "100%" }}>
                  Switch tenant
                </button>
              </form>
            ) : null}

            <nav className="nav">
              {nav
                .filter((n) => n.show)
                .map((n) => (
                  <a key={n.href} href={n.href}>
                    {n.label}
                  </a>
                ))}
            </nav>

            <div style={{ marginTop: "auto" }} className="sub">
              <div className="whoami">
                <strong>{user.full_name || user.email}</strong>
                <br />
                <code>{ctx.role}</code>
                {ctx.viaSuperAdmin ? (
                  <span className="chip p1" title="Platform administrator in a tenant you are not a member of">
                    {" "}
                    super admin
                  </span>
                ) : null}
                <form action={signOutAction}>
                  <button type="submit" className="link-button">
                    Sign out
                  </button>
                </form>
              </div>
              mode <code>{mode}</code>
              {overridden ? <span className="chip p2"> override</span> : null}
              <br />
              triage <code>{env.TRIAGE_MODEL}</code>
            </div>
          </aside>

          <main className="main">
            {ctx.viaSuperAdmin ? (
              <div className="mode-banner mode-shadow">
                <strong>platform access</strong>
                <span>
                  You are in <strong>{tenant.business.name}</strong> as a platform
                  administrator, not as a member of this tenant. Everything you do
                  here is audited under your own account.
                </span>
              </div>
            ) : null}
            <div className={`mode-banner mode-${mode}`}>
              <strong>{mode}</strong>
              <span>
                {MODE_COPY[mode]}
                {overridden ? (
                  <>
                    {" "}
                    <strong>Tenant override is active</strong>
                    {tenant.settings.agent_mode_override_reason
                      ? `: ${tenant.settings.agent_mode_override_reason}`
                      : "."}{" "}
                    The deployment is running in <code>{env.AGENT_MODE}</code>.
                  </>
                ) : null}
              </span>
            </div>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
