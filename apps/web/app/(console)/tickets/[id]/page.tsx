import { notFound } from "next/navigation";
import {
  can,
  duplicateCandidates,
  eventsFor,
  getRequester,
  getShadow,
  getTicket,
  outboundForTicket,
  policyFor,
  primaryAsset,
  threadFor,
  TicketCategory,
  type OutboundMessage,
  type ThreadEntry,
  type TicketEvent,
} from "@hd/core";
import { currentTenant, fmtDate } from "../../../../lib/tenant";
import { ReviewPanel } from "./review";

export const dynamic = "force-dynamic";

export default async function TicketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tenant = await currentTenant(`/tickets/${id}`);
  const { ctx } = tenant;

  // Scoped by the session's tenant, so a ticket id from another business is a
  // 404 here and not a 403. The difference matters: a 403 confirms the id
  // exists, which turns this page into an enumeration oracle.
  const ticket = await getTicket(ctx, id);
  if (!ticket) notFound();

  const [events, thread, requester, outbound] = await Promise.all([
    eventsFor(ctx, id),
    threadFor(ctx, id),
    ticket.requester_id ? getRequester(ctx, ticket.requester_id) : null,
    outboundForTicket(ctx, id),
  ]);
  const asset = requester ? await primaryAsset(ctx, requester.id) : null;
  const shadow = await getShadow(ctx, id);
  // The latest draft nobody has sent yet. Sending one writes a reply derived
  // from it, which is how it stops being offered.
  const sentFrom = new Set(thread.map((m) => m.derived_from_id).filter(Boolean));
  const draftMessage = [...thread]
    .reverse()
    .find((m) => m.kind === "draft" && !sentFrom.has(m.id));
  const draft = draftMessage
    ? {
        id: draftMessage.id,
        body: draftMessage.body,
        kind:
          typeof draftMessage.metadata.draft_kind === "string"
            ? draftMessage.metadata.draft_kind
            : "reply",
        sources: Array.isArray(draftMessage.ai_sources)
          ? (draftMessage.ai_sources as { title?: unknown; score?: unknown }[]).map((src) => ({
              title: String(src.title ?? "source"),
              score: Number(src.score ?? 0),
            }))
          : [],
      }
    : undefined;

  // Proposed, never applied: same requester, same category, opened close
  // together is a heuristic. Two "printer is broken" tickets an hour apart are
  // often two printers, so a person picks the survivor.
  const duplicates = ticket.merged_into_id
    ? []
    : (await duplicateCandidates(ctx))
        .filter((d) => d.a === ticket.id || d.b === ticket.id)
        .map((d) =>
          d.a === ticket.id
            ? { id: d.b, subject: d.subject_b }
            : { id: d.a, subject: d.subject_a },
        );

  const decisionEvent = [...events]
    .reverse()
    .find((e) => e.kind === "note" && (e.payload as { stage?: string }).stage === "decision");
  const decision = decisionEvent?.payload as Record<string, unknown> | undefined;

  const threshold = policyFor(
    tenant.settings,
    ticket.category ?? "other",
  ).confidence_threshold;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{ticket.subject}</h1>
          <div className="sub">
            <span className={`chip ${(ticket.priority ?? "p4").toLowerCase()}`}>
              {ticket.priority ?? "untriaged"}
            </span>{" "}
            {ticket.category ?? "—"}
            {ticket.subcategory ? ` / ${ticket.subcategory}` : ""} · {ticket.status} ·
            opened {fmtDate(ticket.created_at)}
          </div>
        </div>
        <a className="btn" href="/">
          Back to queue
        </a>
      </div>

      {ticket.merged_into_id ? (
        <div className="alert">
          This ticket was merged into{" "}
          <a href={`/tickets/${ticket.merged_into_id}`}>the surviving ticket</a>. It is
          kept for the audit trail; the agent does not work it and replies on this
          thread land on the survivor.
        </div>
      ) : null}

      {ticket.injection_suspected ? (
        <div className="alert">
          The injection scanner tripped on this message. Treat the text as data, not
          instructions — the agent escalated rather than acting on it.
        </div>
      ) : null}

      {ticket.secrets_scrubbed ? (
        <div className="alert warn">
          Credentials were scrubbed out of this body at intake. Tell the requester to
          change whatever they pasted — it travelled by email in plain text.
        </div>
      ) : null}

      <div className="detail-grid">
        <div>
          <ConversationPanel
            ticketId={ticket.id}
            thread={thread}
            fallbackBody={ticket.body}
            sender={`${requester?.full_name ?? requester?.email ?? "unknown sender"}${requester?.vip ? " · VIP" : ""}`}
            canNote={can(ctx, "ticket:update") && !ticket.merged_into_id}
            canReply={can(ctx, "action:execute") && !ticket.merged_into_id}
          />

          {decision ? (
            <div className="panel">
              <div className="panel-head">
                <h2>Why the agent did that</h2>
                <span className="path">{String(decision.rule ?? "")}</span>
              </div>
              <div className="panel-body">
                <p style={{ margin: "0 0 10px" }}>{String(decision.reason ?? "")}</p>
                <dl className="kv">
                  <dt>Would have</dt>
                  <dd>
                    <code>{String(decision.intended_action ?? "—")}</code> (
                    {String(decision.intended_path ?? "—")})
                  </dd>
                  <dt>Actually did</dt>
                  <dd>
                    <code>{String(decision.effective_action ?? "—")}</code> (
                    {String(decision.effective_path ?? "—")})
                  </dd>
                  <dt>Mode / autonomy</dt>
                  <dd>
                    {String(decision.mode ?? "—")} · {String(decision.autonomy ?? "—")}
                  </dd>
                  <dt>Threshold</dt>
                  <dd>
                    {Number(decision.confidence_threshold ?? threshold).toFixed(2)} for this
                    category
                  </dd>
                  <dt>KB support</dt>
                  <dd>
                    {decision.kb_top_score === null || decision.kb_top_score === undefined
                      ? "no match"
                      : Number(decision.kb_top_score).toFixed(2)}
                  </dd>
                </dl>

                {/*
                  What it would take to reproduce this decision. Prompt and
                  model were already recorded; the configuration version is the
                  third leg, and without it a replay silently uses today's
                  thresholds and produces a decision nobody ever made.
                */}
                <div className="replay-stamp">
                  <span>
                    prompt <code>{String(decision.prompt_version ?? "—")}</code>
                  </span>
                  <span>
                    model <code>{String(decision.model ?? "—")}</code>
                  </span>
                  <span>
                    config{" "}
                    {ticket.config_version ? (
                      <a href={`/audit?version=${ticket.config_version}`}>
                        <code>v{ticket.config_version}</code>
                      </a>
                    ) : (
                      <code>—</code>
                    )}
                  </span>
                </div>
              </div>
            </div>
          ) : null}

          {draft?.body ? (
            <div className="panel">
              <div className="panel-head">
                <h2>
                  {draft.kind === "question"
                    ? "Suggested clarifying question"
                    : "Suggested reply"}
                </h2>
                <span className="sub">
                  {draft.sources?.length
                    ? `${draft.sources.length} source${draft.sources.length === 1 ? "" : "s"}`
                    : "no sources"}
                </span>
              </div>
              <div className="panel-body">
                <ReviewPanel
                  ticketId={ticket.id}
                  draft={draft.body}
                  draftId={draft.id}
                  canSend={can(ctx, "action:execute")}
                  canOverride={can(ctx, "agent:override")}
                />
                {draft.sources?.length ? (
                  <div className="sub" style={{ marginTop: 10 }}>
                    Drawn from:{" "}
                    {draft.sources
                      .map((s) => `${s.title} (${s.score.toFixed(2)})`)
                      .join(", ")}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {/*
            What actually left the building.
            The timeline says the agent replied; this says whether the reply
            reached anybody. They are different facts, and before there was a
            real transport only the first one existed — which is how a ticket
            could read as answered while the requester had heard nothing.
          */}
          {outbound.length > 0 ? (
            <div className="panel">
              <div className="panel-head">
                <h2>Delivery</h2>
                <span className="sub">
                  <code>sent</code> means the provider accepted it, not that a
                  person read it. A bounce arriving later is the normal way to
                  learn otherwise.
                </span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>To</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Detail</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {outbound.map((m) => (
                    <tr key={m.id}>
                      <td className="path">{m.to_email}</td>
                      <td>
                        <span className={`chip ${deliveryChip(m)}`}>{m.status}</span>
                      </td>
                      <td className="sub">
                        {m.attempts} / {m.max_attempts}
                      </td>
                      <td className="sub">
                        {m.bounce_detail ?? m.last_error ?? m.provider ?? "—"}
                      </td>
                      <td className="sub">
                        {fmtDate(m.sent_at ?? m.updated_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="panel-body sub">
                <a href="/mail">Outbound mail</a> has the full delivery history
                and the retry button.
              </div>
            </div>
          ) : null}

          <div className="panel">
            <div className="panel-head">
              <h2>Timeline</h2>
              <span className="sub">{events.length} events, append-only</span>
            </div>
            <div className="timeline">
              {events.length === 0 ? (
                <div className="empty">Nothing recorded yet.</div>
              ) : (
                events.map((e) => <EventRow key={e.id} e={e} />)
              )}
            </div>
          </div>
        </div>

        <aside>
          <div className="panel">
            <div className="panel-head">
              <h2>Requester</h2>
            </div>
            <div className="panel-body">
              <dl className="kv">
                <dt>Name</dt>
                <dd>{requester?.full_name ?? "—"}</dd>
                <dt>Email</dt>
                <dd>{requester?.email ?? "—"}</dd>
                <dt>Department</dt>
                <dd>{requester?.department ?? "—"}</dd>
                <dt>Role</dt>
                <dd>{requester?.role ?? "—"}</dd>
                <dt>VIP</dt>
                <dd>{requester?.vip ? "yes" : "no"}</dd>
                <dt>Device</dt>
                <dd>
                  {asset
                    ? `${asset.kind ?? "device"} ${asset.os ?? ""} (${asset.asset_tag ?? "no tag"})`
                    : "none on record"}
                </dd>
                <dt>Last seen</dt>
                <dd>{fmtDate(asset?.last_seen_at ?? null)}</dd>
              </dl>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Classification</h2>
            </div>
            <div className="panel-body">
              <form
                action={async (formData: FormData) => {
                  "use server";
                  const { overrideTriageFromForm } = await import("./actions");
                  await overrideTriageFromForm(ticket.id, formData);
                }}
              >
                <div className="row" style={{ marginBottom: 8 }}>
                  <select name="category" defaultValue={ticket.category ?? "other"}>
                    {TicketCategory.options.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <select name="priority" defaultValue={ticket.priority ?? "P3"}>
                    {["P1", "P2", "P3", "P4"].map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="row" style={{ marginBottom: 8 }}>
                  <SafetyLabel
                    name="security_sensitive"
                    label="Security-sensitive"
                    agentSaid={shadow?.agent_security_sensitive ?? null}
                    humanSaid={shadow?.human_security_sensitive ?? null}
                  />
                  <SafetyLabel
                    name="destructive"
                    label="Destructive"
                    agentSaid={shadow?.agent_destructive ?? null}
                    humanSaid={shadow?.human_destructive ?? null}
                  />
                </div>
                <button type="submit">Save correction</button>
              </form>
              <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
                Corrections are the calibration data. Every save records the agent&apos;s
                classification against yours. The two safety labels default to
                &ldquo;not labelled&rdquo; on purpose: the evaluation harness reports an
                unlabelled safety slice as unmeasured, and a default of &ldquo;no&rdquo;
                would turn a gate nobody checked into one that reads as passing.
              </p>
            </div>
          </div>

          {duplicates.length ? (
            <div className="panel">
              <div className="panel-head">
                <h2>Possible duplicates</h2>
                <span className="sub">{duplicates.length} open</span>
              </div>
              <div className="panel-body">
                {duplicates.map((d) => (
                  <form
                    key={d.id}
                    style={{ marginBottom: 8 }}
                    action={async () => {
                      "use server";
                      const { mergeInto } = await import("./actions");
                      await mergeInto(ticket.id, d.id);
                    }}
                  >
                    <div className="sub" style={{ marginBottom: 4 }}>
                      <a href={`/tickets/${d.id}`}>{d.subject}</a>
                    </div>
                    <button type="submit">Merge this ticket into it</button>
                  </form>
                ))}
                <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
                  Merging closes this ticket and moves its timeline onto the one you
                  pick. Nothing is deleted.
                </p>
              </div>
            </div>
          ) : null}

          <div className="panel">
            <div className="panel-head">
              <h2>Actions</h2>
            </div>
            <div className="panel-body row">
              <ServerButton
                ticketId={ticket.id}
                action="confirm"
                label="Agent was right"
              />
              <ServerButton ticketId={ticket.id} action="retriage" label="Re-run triage" />
              <ServerButton ticketId={ticket.id} action="resolve" label="Mark resolved" />
              <ServerButton ticketId={ticket.id} action="reopen" label="Reopen" />
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}

/**
 * The ticket's conversation, in order, and the two ways to add to it.
 *
 * It reads `threadFor`, the one reader (docs/conversation.md). Internal notes
 * and drafts show here because this is the desk's view. The portal is handed
 * the public messages only, by the repository rather than by its page.
 */
function ConversationPanel({
  ticketId,
  thread,
  fallbackBody,
  sender,
  canNote,
  canReply,
}: {
  ticketId: string;
  thread: ThreadEntry[];
  fallbackBody: string;
  sender: string;
  canNote: boolean;
  canReply: boolean;
}) {
  // Minted per render, so submitting a form twice is one message (C8).
  const noteNonce = crypto.randomUUID();
  const replyNonce = crypto.randomUUID();

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Conversation</h2>
        <span className="sub">
          {thread.length
            ? `${thread.length} message${thread.length === 1 ? "" : "s"}`
            : `from ${sender}`}
        </span>
      </div>
      {thread.length === 0 ? (
        // A ticket from before the conversation, not copied yet (D4). The
        // backfill copies it, or the next message written to it does.
        <div className="panel-body body-text">{fallbackBody}</div>
      ) : (
        <div className="timeline">
          {thread.map((m) => (
            <ThreadRow key={m.id} m={m} sender={sender} />
          ))}
        </div>
      )}
      {canNote || canReply ? (
        <div className="panel-body">
          {canReply ? (
            <form
              style={{ marginBottom: 12 }}
              action={async (formData: FormData) => {
                "use server";
                const { replyFromForm } = await import("./actions");
                await replyFromForm(ticketId, formData);
              }}
            >
              <input type="hidden" name="nonce" defaultValue={replyNonce} />
              <textarea name="body" placeholder="Reply to the requester" spellCheck={false} />
              <div className="row" style={{ marginTop: 6 }}>
                <button className="primary" type="submit">
                  Send reply
                </button>
                <label className="sub">
                  <input type="checkbox" name="resolve" /> and mark resolved
                </label>
              </div>
            </form>
          ) : null}
          {canNote ? (
            <form
              action={async (formData: FormData) => {
                "use server";
                const { addNote } = await import("./actions");
                await addNote(ticketId, formData);
              }}
            >
              <input type="hidden" name="nonce" defaultValue={noteNonce} />
              <textarea
                name="body"
                placeholder="Internal note. The requester never sees it."
                spellCheck={false}
              />
              <div className="row" style={{ marginTop: 6 }}>
                <button type="submit">Add note</button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ThreadRow({ m, sender }: { m: ThreadEntry; sender: string }) {
  const who =
    m.from === "requester"
      ? sender
      : m.author_kind === "ai"
        ? `agent (${m.ai_model})`
        : m.author_kind === "staff"
          ? "desk"
          : "system";
  return (
    <div className="event">
      <div className="event-meta">
        {fmtDate(m.at)}
        <br />
        {who}
      </div>
      <div>
        {m.kind === "draft" ? <span className="chip p3">draft</span> : null}{" "}
        {m.visibility === "internal" && m.kind !== "draft" ? (
          <span className="chip p2">internal note</span>
        ) : null}{" "}
        {m.derived_from_id ? <span className="sub">sent from a draft</span> : null}
        {m.legacy ? <span className="sub"> · copied from the event log</span> : null}
        <div className="body-text" style={{ marginTop: 3 }}>
          {m.body}
        </div>
        {m.attachments.length ? (
          <div className="sub" style={{ marginTop: 3 }}>
            Attached: {m.attachments.map((a) => a.filename).join(", ")}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ServerButton({
  ticketId,
  action,
  label,
}: {
  ticketId: string;
  action: "confirm" | "retriage" | "resolve" | "reopen";
  label: string;
}) {
  return (
    <form
      action={async () => {
        "use server";
        const a = await import("./actions");
        if (action === "confirm") await a.confirmTriage(ticketId);
        if (action === "retriage") await a.retriage(ticketId);
        if (action === "resolve") await a.changeStatus(ticketId, "resolved");
        if (action === "reopen") await a.changeStatus(ticketId, "reopened");
      }}
    >
      <button type="submit">{label}</button>
    </form>
  );
}

/**
 * A tri-state safety label.
 *
 * The agent's own flag is shown but never pre-selected. Pre-selecting it would
 * collect agreement rather than ground truth, and the one slice where the
 * difference matters most is the one where a wrong label is a missed security
 * ticket.
 */
function SafetyLabel({
  name,
  label,
  agentSaid,
  humanSaid,
}: {
  name: string;
  label: string;
  agentSaid: boolean | null;
  humanSaid: boolean | null;
}) {
  return (
    <label className="sub" style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span>{label}</span>
      <select name={name} defaultValue="">
        <option value="">not labelled</option>
        <option value="yes">yes</option>
        <option value="no">no</option>
      </select>
      <span className="path">
        agent: {agentSaid === null ? "—" : agentSaid ? "yes" : "no"}
        {humanSaid !== null ? ` · recorded: ${humanSaid ? "yes" : "no"}` : ""}
      </span>
    </label>
  );
}

function EventRow({ e }: { e: TicketEvent }) {
  const payload = e.payload as Record<string, unknown>;
  const summary = summarize(e.kind, payload);

  return (
    <div className="event">
      <div className="event-meta">
        {new Date(e.created_at).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}
        <br />
        {e.actor}
        {e.tokens_in ? (
          <>
            <br />
            {e.tokens_in}/{e.tokens_out} tok
          </>
        ) : null}
        {e.cost_usd ? (
          <>
            <br />${Number(e.cost_usd).toFixed(4)}
          </>
        ) : null}
      </div>
      <div>
        <span className={`event-kind ${e.kind}`}>{e.kind}</span>
        {summary ? <div style={{ marginTop: 3 }}>{summary}</div> : null}
        {shouldDump(e.kind, payload) ? (
          <pre>{JSON.stringify(payload, null, 2)}</pre>
        ) : null}
      </div>
    </div>
  );
}

function summarize(kind: string, p: Record<string, unknown>): string | null {
  switch (kind) {
    case "triage":
      if (p.source === "human_override") {
        const to = p.to as { category?: string; priority?: string } | undefined;
        return `Human corrected to ${to?.priority} ${to?.category}`;
      }
      if (p.source === "human_confirm") return "Human confirmed the agent's classification";
      return `${String(p.priority)} ${String(p.category)}/${String(p.subcategory)} at ${Number(
        p.confidence,
      ).toFixed(2)} — ${String(p.reasoning ?? "")}`;
    case "retrieval": {
      const hits = (p.hits as { title: string; score: number }[] | undefined) ?? [];
      return hits.length
        ? `${hits.length} chunks: ${hits.map((h) => `${h.title} (${h.score.toFixed(2)})`).join(", ")}`
        : "no knowledge base matches";
    }
    case "note":
      if (p.stage === "decision") return `${String(p.rule)} — ${String(p.reason)}`;
      if (p.stage === "intake") return `arrived via ${String(p.source)}`;
      if (p.stage === "writeback") return `knowledge base entry written (${String(p.chunks ?? 0)} chunks)`;
      if (p.stage === "merge")
        return p.merged_into
          ? `merged into ${String(p.merged_into).slice(0, 8)}`
          : `absorbed ${String(p.absorbed).slice(0, 8)} (${String(p.events ?? 0)} events)`;
      if (p.stage === "injection_scan")
        return `injection scanner tripped: ${((p.signals as string[]) ?? []).join(", ")}`;
      if (p.stage === "rate_limited")
        return `rate limit reached (${String(p.scope)}: ${String(p.used)}/${String(p.limit)} per hour)`;
      if (p.stage === "assignment")
        return p.assigned_to ? "assigned to a person" : "unassigned (agent owns it)";
      return null;
    case "escalation":
      return String(p.reason ?? "");
    case "reply":
    case "draft":
      // Written before the conversation existed. The conversation shows them now.
      return String(p.body ?? "").slice(0, 400);
    case "message":
      // The words are in the conversation; the log says one was written.
      return `#${String(p.seq)} ${String(p.kind)} (${String(p.visibility)}) by ${String(p.author_kind)}${p.legacy ? ", copied from the event log" : ""}`;
    case "message": {
      // The words are in the conversation, not the event (C7).
      const legacy = p.legacy as { from?: string; event_id?: number | null } | undefined;
      const what = `${String(p.visibility)} ${String(p.kind)} #${String(p.seq)} by ${String(p.author_kind)}`;
      if (!legacy) return what;
      return legacy.event_id
        ? `${what}, copied from event ${String(legacy.event_id)}`
        : `${what}, copied from the ticket`;
    }
    case "status_change":
      return `${String(p.status)}${p.reason ? ` — ${String(p.reason)}` : ""}`;
    case "approval":
      return `requested ${String(p.requested)} (${String(p.risk_tier)})`;
    case "error":
      // Delivery failures write `summary`; everything else writes `error`.
      return `${String(p.stage)}: ${String(p.error ?? p.summary ?? "")}`;
    default:
      return null;
  }
}

function shouldDump(kind: string, p: Record<string, unknown>): boolean {
  if (kind === "note" && p.stage === "decision") return false;
  return kind === "tool_call";
}

/**
 * Delivery status, coloured the way the queue colours priorities.
 *
 * `sent` is green and `queued` is not, because a reply still sitting in the
 * queue has not answered anybody yet.
 */
function deliveryChip(m: OutboundMessage): string {
  switch (m.status) {
    case "sent":
      return "pass";
    case "failed":
    case "bounced":
      return "fail";
    case "suppressed":
      return "p2";
    case "cancelled":
      return "unmeasured";
    default:
      return "p3";
  }
}
