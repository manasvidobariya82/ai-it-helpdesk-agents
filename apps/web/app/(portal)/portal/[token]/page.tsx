import { notFound } from "next/navigation";
import {
  getRequesterUnscoped,
  portalContext,
  slaStatus,
  threadFor,
  ticketsForRequester,
  type TenantContext,
  type ThreadEntry,
  type Ticket,
} from "@hd/core";
import { fmtDate } from "../../../../lib/tenant";
import { verifyPortalToken } from "../../../../lib/portal";

export const dynamic = "force-dynamic";

/**
 * The requester's own view of their own tickets.
 *
 * Deliberately narrow: status, and the replies they were already sent. It does
 * not show triage confidence, the decision rule, retrieval hits, cost, or
 * anything else the agent thought. That is operator information — a requester
 * reading "confidence 0.62, escalated on no_kb_support" learns nothing good.
 */
export default async function PortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ new?: string }>;
}) {
  const { token } = await params;
  const { new: newTicketId } = await searchParams;

  const requesterId = verifyPortalToken(token);
  if (!requesterId) notFound();

  // The link is a capability, not a login, so the tenant is derived from the
  // requester the signature names — never from the URL. `portalContext` grants
  // two permissions and nothing else, and every query below is additionally
  // filtered to this one requester.
  const requester = await getRequesterUnscoped(requesterId);
  if (!requester) notFound();
  const ctx = portalContext(requester.business_id);

  const tickets = await ticketsForRequester(ctx, requesterId, 25);
  const open = tickets.filter((t) => !["closed"].includes(t.status));
  const past = tickets.filter((t) => t.status === "closed");

  return (
    <div className="portal">
      <h1>Your IT tickets</h1>
      <p className="sub" style={{ marginTop: 0 }}>
        {requester.full_name ?? requester.email}
      </p>

      {newTicketId ? (
        <div className="alert warn">
          Ticket received. We will email you at {requester.email} as it progresses.
        </div>
      ) : null}

      <div style={{ margin: "16px 0" }}>
        <a className="btn" href="/portal/new">
          Raise another ticket
        </a>
      </div>

      {tickets.length === 0 ? (
        <div className="portal-card sub">You have not raised any tickets.</div>
      ) : null}

      {open.map((t) => (
        <TicketCard key={t.id} ctx={ctx} ticket={t} />
      ))}

      {past.length > 0 ? (
        <>
          <h2 style={{ marginTop: 26 }}>Closed</h2>
          {past.map((t) => (
            <TicketCard key={t.id} ctx={ctx} ticket={t} />
          ))}
        </>
      ) : null}
    </div>
  );
}

async function TicketCard({
  ctx,
  ticket,
}: {
  ctx: TenantContext;
  ticket: Ticket;
}) {
  const sla = slaStatus(ticket);

  // The conversation, as the requester may see it: what they wrote and what we
  // sent them. The portal's context cannot read internal messages, so notes
  // and drafts that were never sent are left out by the repository, not by
  // this page (C5 in docs/conversation.md).
  const messages = await threadFor(ctx, ticket.id);

  return (
    <div className="portal-card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{ticket.subject}</strong>
        <span className="chip">{statusLabel(ticket.status)}</span>
      </div>

      <div className="sub" style={{ marginTop: 4 }}>
        Raised {fmtDate(ticket.created_at)}
        {ticket.first_response_at
          ? ` · first replied ${fmtDate(ticket.first_response_at)}`
          : sla.firstResponse === "breached"
            ? " · our reply is overdue, sorry"
            : ""}
      </div>

      {messages.length > 0 ? (
        <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
          {messages.map((m) => (
            <Message key={m.id} message={m} />
          ))}
        </div>
      ) : (
        <div className="sub" style={{ marginTop: 10 }}>
          No updates yet.
        </div>
      )}
    </div>
  );
}

function Message({ message }: { message: ThreadEntry }) {
  return (
    <div>
      <div className="sub">
        {message.from === "requester" ? "You" : "IT Support"} · {fmtDate(message.at)}
      </div>
      <div className="body-text" style={{ fontSize: 13 }}>
        {message.body}
      </div>
      {message.attachments.length ? (
        <div className="sub">
          Attached: {message.attachments.map((a) => a.filename).join(", ")}
        </div>
      ) : null}
    </div>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "new":
    case "triaged":
      return "With our team";
    case "awaiting_user":
      return "Waiting for your reply";
    case "awaiting_approval":
      return "Waiting for approval";
    case "in_progress":
      return "Being worked on";
    case "resolved":
      return "Resolved";
    case "closed":
      return "Closed";
    case "reopened":
      return "Reopened";
    default:
      return status;
  }
}
