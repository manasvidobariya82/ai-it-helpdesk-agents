import {
  can,
  deadLetters,
  deliveryStats,
  env,
  listOutbound,
  listSuppressions,
  type OutboundMessage,
  type OutboundStatus,
} from "@hd/core";
import { currentTenant, fmtAgo, fmtDate } from "../../../lib/tenant";
import { cancelDelivery, liftSuppression, retryDelivery } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Outbound mail.
 *
 * The page exists because a dead-letter queue nobody looks at is decoration.
 * Everything the delivery loop does to a message — every attempt, deferral,
 * bounce and suppression — is recorded, and this is where a human reads it and
 * does something about it.
 *
 * The distinction the copy works hardest to keep is between *sent* and
 * *delivered*. `sent` means our provider accepted the message. It does not mean
 * a person received it, and a bounce arriving an hour later is the normal way
 * to find that out.
 */

const STATUS_CHIP: Record<OutboundStatus, string> = {
  queued: "p3",
  sending: "p3",
  sent: "pass",
  failed: "fail",
  bounced: "fail",
  suppressed: "p2",
  cancelled: "unmeasured",
};

const STATUS_NOTE: Record<OutboundStatus, string> = {
  queued: "waiting for a worker",
  sending: "in flight",
  sent: "the provider accepted it",
  failed: "gave up; nothing will retry this",
  bounced: "came back from the receiving side",
  suppressed: "never attempted: the address is suppressed",
  cancelled: "deliberately not sent",
};

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string | number;
  note: string;
}) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="note">{note}</div>
    </div>
  );
}

function Recipient({ message }: { message: OutboundMessage }) {
  return (
    <>
      <div className="subject">{message.subject}</div>
      <div className="path">
        {message.to_email}
        {message.ticket_id ? (
          <>
            {" · "}
            <a href={`/tickets/${message.ticket_id}`}>ticket</a>
          </>
        ) : null}
      </div>
    </>
  );
}

export default async function MailPage() {
  const tenant = await currentTenant("/mail");
  const { ctx } = tenant;

  const [stats, dead, inFlight, recent, suppressions] = await Promise.all([
    deliveryStats(ctx, 24),
    deadLetters(ctx, 50),
    listOutbound(ctx, { status: ["queued", "sending"], limit: 50 }),
    listOutbound(ctx, { status: ["sent", "cancelled", "suppressed"], limit: 20 }),
    listSuppressions(ctx, 50),
  ]);

  // Acting on mail is `action:execute`, the same permission that lets a person
  // send a draft. A viewer who reaches this URL sees the state and no buttons,
  // and every action re-checks server-side.
  const mayAct = can(ctx, "action:execute");
  const provider = env.OUTBOUND_EMAIL_PROVIDER;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Outbound mail</h1>
          <div className="sub">
            Transport <code>{provider}</code>
            {provider === "spool" ? (
              <>
                {" — messages are rendered and written to "}
                <code>{env.OUTBOUND_SPOOL_DIR}</code>. Nothing reaches a
                requester.
              </>
            ) : provider === "none" ? (
              " — this deployment sends nothing. Replies are recorded and cancelled."
            ) : (
              " — replies are delivered, retried and reconciled against bounces."
            )}
          </div>
        </div>
      </div>

      <div className="stat-grid">
        <Stat
          label="Sent (24h)"
          value={stats.sent}
          note="accepted by the provider, which is not the same as received"
        />
        <Stat label="Waiting" value={stats.queued + stats.sending} note="queued or in flight" />
        <Stat
          label="Dead letters"
          value={stats.failed + stats.bounced}
          note="failed or bounced in the last 24h"
        />
        <Stat
          label="Suppressed addresses"
          value={suppressions.length < 50 ? suppressions.length : "50+"}
          note="hard bounce or complaint; the newest 50 are listed below"
        />
      </div>

      {/*
        Dead letters first. This is the panel that means something is wrong, and
        it is the one with a button on it.
      */}
      <div className="panel">
        <div className="panel-head">
          <h2>Dead letters</h2>
          <span className="sub">
            Messages the system gave up on. A retry gives one a fresh attempt
            budget and is recorded in the audit log.
          </span>
        </div>
        {dead.length === 0 ? (
          <div className="empty">
            Nothing failed. Every message queued in this tenant either went out
            or is still trying.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Message</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>What went wrong</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {dead.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Recipient message={m} />
                  </td>
                  <td>
                    <span className={`chip ${STATUS_CHIP[m.status]}`}>{m.status}</span>
                    {m.bounce_kind ? (
                      <div className="sub">{m.bounce_kind} bounce</div>
                    ) : null}
                  </td>
                  <td className="sub">
                    {m.attempts} / {m.max_attempts}
                  </td>
                  <td className="sub">{m.bounce_detail ?? m.last_error ?? "—"}</td>
                  <td className="sub">{fmtAgo(m.failed_at ?? m.updated_at)}</td>
                  <td>
                    {mayAct ? (
                      <form
                        action={async () => {
                          "use server";
                          await retryDelivery(m.id);
                        }}
                      >
                        <button type="submit">Retry</button>
                      </form>
                    ) : (
                      <span className="sub" title="Requires action:execute">
                        read only
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Waiting</h2>
          <span className="sub">
            The row is the queue of record, so these survive a restart of
            everything else. A retry clock in the future means an attempt failed
            and will be tried again.
          </span>
        </div>
        {inFlight.length === 0 ? (
          <div className="empty">Nothing waiting to go out.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Message</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Next attempt</th>
                <th>Last error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {inFlight.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Recipient message={m} />
                  </td>
                  <td>
                    <span className={`chip ${STATUS_CHIP[m.status]}`}>{m.status}</span>
                  </td>
                  <td className="sub">
                    {m.attempts} / {m.max_attempts}
                  </td>
                  <td className="sub">{fmtDate(m.next_attempt_at)}</td>
                  <td className="sub">{m.last_error ?? "—"}</td>
                  <td>
                    {mayAct ? (
                      <form
                        action={async (formData: FormData) => {
                          "use server";
                          await cancelDelivery(m.id, String(formData.get("reason") ?? ""));
                        }}
                      >
                        <input
                          type="text"
                          name="reason"
                          placeholder="Why (optional)"
                          style={{ width: 130 }}
                        />
                        <button className="danger" type="submit">
                          Cancel
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Suppressed addresses</h2>
          <span className="sub">
            Per tenant, deliberately. A hard bounce or a complaint stops the
            address, and <code>send_reply</code> fails loudly rather than
            spending five retries rediscovering a mailbox that is gone.
          </span>
        </div>
        {suppressions.length === 0 ? (
          <div className="empty">No suppressed addresses.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th>Why</th>
                <th>What the server said</th>
                <th>Since</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {suppressions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="path">{s.email}</span>
                  </td>
                  <td>
                    <span
                      className={`chip ${s.reason === "complaint" ? "fail" : "p2"}`}
                    >
                      {s.reason}
                    </span>
                  </td>
                  <td className="sub">{s.detail ?? "—"}</td>
                  <td className="sub">{fmtAgo(s.created_at)}</td>
                  <td>
                    {mayAct ? (
                      <form
                        action={async (formData: FormData) => {
                          "use server";
                          await liftSuppression(
                            s.email,
                            String(formData.get("reason") ?? ""),
                          );
                        }}
                      >
                        <input
                          type="text"
                          name="reason"
                          placeholder="Why lift it"
                          style={{ width: 150 }}
                          required
                        />
                        <button type="submit">Allow again</button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Recent</h2>
          <span className="sub">
            The last twenty messages that left the queue, whatever happened to
            them.
          </span>
        </div>
        {recent.length === 0 ? (
          <div className="empty">Nothing has been sent from this tenant yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Message</th>
                <th>Status</th>
                <th>Transport</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Recipient message={m} />
                  </td>
                  <td>
                    <span className={`chip ${STATUS_CHIP[m.status]}`}>{m.status}</span>
                    <div className="sub">{STATUS_NOTE[m.status]}</div>
                  </td>
                  <td className="sub">
                    {m.provider ?? "—"}
                    {m.provider_message_id ? (
                      <div className="path">{m.provider_message_id}</div>
                    ) : null}
                  </td>
                  <td className="sub">{fmtAgo(m.sent_at ?? m.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
