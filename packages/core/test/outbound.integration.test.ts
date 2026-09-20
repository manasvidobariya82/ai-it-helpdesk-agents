import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The delivery lifecycle against a real Postgres.
 *
 * `outbound.test.ts` covers the judgements — retry or give up, bounce or
 * ordinary mail — with no database. This covers the part those cannot: the
 * statements themselves, and the order they happen in. Claiming a message,
 * deferring it, exhausting its attempts, matching a bounce that arrives an hour
 * later by a different route and putting the ticket back in front of a person
 * are all SQL, and the bugs in them are parameter types, enum casts and status
 * predicates that no unit test can see.
 *
 * Skips itself rather than failing when no database is reachable, like the
 * other integration suites here:
 *
 *   npm run db:up && npm run db:migrate
 */

// Set before core loads: `env` is parsed once, at import. A temporary spool
// directory keeps the test from writing into the repository's dev outbox.
const spoolDir = path.join(os.tmpdir(), `hd-outbound-int-${Date.now()}`);
process.env.OUTBOUND_EMAIL_PROVIDER = "spool";
process.env.OUTBOUND_SPOOL_DIR = spoolDir;
// The kill-switch test needs a deployment that would otherwise send.
process.env.AGENT_MODE = "auto";

const core = await import("../src/index.js");

let available = true;
let businessId = "";
let tenant: import("../src/index.js").TenantContext;
let ticketId = "";
let requesterEmail = "";

beforeAll(async () => {
  try {
    await core.query("select 1");
  } catch {
    available = false;
    return;
  }

  const row = await core.queryOne<{ id: string }>(
    `insert into businesses (name, type, settings, intake_address)
     values ($1, 'it_services', '{}'::jsonb, $2) returning id`,
    [`outbound-${Date.now()}`, `support-${Date.now()}@acme.test`],
  );
  businessId = row!.id;
  tenant = core.systemContext(businessId, { requestId: "outbound-test" });

  requesterEmail = `person-${Date.now()}@example.test`;
  const result = await core.intakeMessage(tenant, {
    source: "email",
    source_message_id: `inbound-${crypto.randomUUID()}@example.test`,
    requester_email: requesterEmail,
    requester_name: "Test Person",
    subject: "VPN keeps dropping",
    body: "It disconnects every ten minutes.",
    attachments: [],
    received_at: new Date(),
    meta: {},
  });
  ticketId = result.ticket.id;
}, 60_000);

afterAll(async () => {
  if (businessId) await core.purgeBusinessUnaudited(businessId);
  await core.closeQueues().catch(() => {});
  await core.closePool().catch(() => {});
  await fs.rm(spoolDir, { recursive: true, force: true }).catch(() => {});
});

function guard(): boolean {
  if (!available) {
    console.warn("[outbound] no database reachable; skipping. npm run db:up && npm run db:migrate");
  }
  return !available;
}

async function queueReply(body: string, over: { to?: string } = {}) {
  const business = await core.currentBusiness(tenant);
  const draft = core.renderReply({
    ticketId,
    subject: "VPN keeps dropping",
    body,
    toEmail: over.to ?? requesterEmail,
    toName: "Test Person",
    intakeAddress: business.intake_address,
    fallbackFrom: "helpdesk@localhost",
    fromName: "IT Support",
    messageIdDomain: "acme.test",
    threadMessageIds: await core.threadMessageIds(tenant, ticketId),
  });

  const { message } = await core.queueOutbound(tenant, {
    ticket_id: ticketId,
    to_email: draft.toEmail,
    to_name: draft.toName,
    from_email: draft.fromEmail,
    from_name: draft.fromName,
    reply_to: draft.replyTo,
    subject: draft.subject,
    body: draft.body,
    message_id: draft.messageId,
    in_reply_to: draft.inReplyTo,
    references: draft.references,
    idempotency_key: core.replyIdempotencyKey("reply", ticketId, body),
  });
  return message;
}

describe("outbound delivery against a real database", () => {
  it("queues, delivers, and threads what it sent", async () => {
    if (guard()) return expect(available).toBe(false);

    const message = await queueReply("Reconnect and try again. #1");
    expect(message.status).toBe("queued");
    // Sends from the address the tenant receives on, so a reply to the reply
    // comes back into this tenant's intake.
    expect(message.from_email).toContain("@acme.test");
    expect(message.in_reply_to).not.toBeNull();

    const result = await core.deliverOutbound(message.id);
    expect(result.status).toBe("sent");

    const after = await core.getOutbound(tenant, message.id);
    expect(after?.status).toBe("sent");
    expect(after?.provider).toBe("spool");
    expect(after?.attempts).toBe(1);
    expect(after?.sent_at).not.toBeNull();

    // A real message reached a real destination, which in development is a file.
    const files = await fs.readdir(spoolDir);
    expect(files.length).toBeGreaterThan(0);

    // And the id it sent under is now part of the thread.
    expect(await core.threadMessageIds(tenant, ticketId)).toContain(
      message.message_id,
    );

    // Delivering the same message again does nothing: it is no longer claimable.
    const second = await core.deliverOutbound(message.id);
    expect(second.status).toBe("skipped");
  }, 60_000);

  it("defers a transient failure and gives up after the last attempt", async () => {
    if (guard()) return expect(available).toBe(false);

    const message = await queueReply("Reconnect and try again. #2");

    // Two attempts' worth of budget, so the second failure is the last one.
    await core.query(
      `update outbound_messages set max_attempts = 2 where id = $1`,
      [message.id],
    );

    const first = await core.claimOutbound(message.id);
    expect(first?.attempts).toBe(1);
    await core.deferOutbound(tenant, message.id, {
      error: "421 service unavailable",
      code: "421",
      delayMs: 60_000,
      provider: "smtp",
    });

    const deferred = await core.getOutbound(tenant, message.id);
    // Back in the queue rather than in a status of its own: a message waiting
    // to be retried is a message waiting to be sent.
    expect(deferred?.status).toBe("queued");
    expect(deferred?.attempts).toBe(1);
    expect(new Date(deferred!.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    // Not due yet, so nothing claims it. This is what stops a retry storm.
    expect(await core.claimOutbound(message.id)).toBeNull();
    const notDue = await core.dueOutbound(200);
    expect(notDue.map((r) => r.id)).not.toContain(message.id);

    // Due now.
    await core.query(
      `update outbound_messages set next_attempt_at = now() - interval '1 minute' where id = $1`,
      [message.id],
    );
    expect((await core.dueOutbound(200)).map((r) => r.id)).toContain(message.id);

    const second = await core.claimOutbound(message.id);
    expect(second?.attempts).toBe(2);
    await core.failOutbound(tenant, message.id, {
      error: "421 service unavailable",
      code: "421",
      provider: "smtp",
      permanent: false,
    });

    const dead = await core.getOutbound(tenant, message.id);
    expect(dead?.status).toBe("failed");
    expect(dead?.failed_at).not.toBeNull();
    expect((await core.deadLetters(tenant)).map((m) => m.id)).toContain(message.id);

    const history = (await core.outboundHistory(tenant, message.id)).map((e) => e.kind);
    expect(history).toEqual(["queued", "deferred", "failed"]);
  }, 60_000);

  it("returns a message a stopped worker left in flight", async () => {
    if (guard()) return expect(available).toBe(false);

    const message = await queueReply("Reconnect and try again. #3");
    await core.claimOutbound(message.id);
    // As if the process died mid-attempt: claimed, and nobody left to report.
    await core.query(
      `update outbound_messages set updated_at = now() - interval '30 minutes' where id = $1`,
      [message.id],
    );

    const reclaimed = await core.reclaimStalledOutbound(5);
    expect(reclaimed.map((r) => r.id)).toContain(message.id);

    const after = await core.getOutbound(tenant, message.id);
    expect(after?.status).toBe("queued");
    // The attempt is not forgotten: we do not know whether the provider took it.
    expect(after?.attempts).toBe(1);
    expect(
      (await core.outboundHistory(tenant, message.id)).map((e) => e.kind),
    ).toContain("reclaimed");

    await core.cancelOutbound(tenant, message.id, "tidying up the fixture");
  }, 60_000);

  /**
   * The whole point of the block, end to end.
   *
   * A reply resolves a ticket, the bounce arrives afterwards by a completely
   * different route, and the system has to notice that the resolution was
   * fiction: suppress the address, say so on the ticket, and put it back in
   * front of a person.
   */
  it("reconciles a bounce that arrives after the ticket was resolved", async () => {
    if (guard()) return expect(available).toBe(false);

    const message = await queueReply("Reconnect and try again. #4");
    await core.deliverOutbound(message.id);
    await core.setStatus(tenant, ticketId, "resolved");

    const dsn = [
      "From: Mail Delivery Subsystem <MAILER-DAEMON@mx.example.test>",
      "Subject: Undeliverable: Re: VPN keeps dropping",
      "Message-ID: <the-dsn-itself@mx.example.test>",
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b"',
      "",
      "--b",
      "Content-Type: message/delivery-status",
      "",
      `Final-Recipient: rfc822; ${requesterEmail}`,
      "Action: failed",
      "Status: 5.1.1",
      "Diagnostic-Code: smtp; 550 5.1.1 User unknown",
      "",
      "--b",
      "Content-Type: message/rfc822",
      "",
      `Message-ID: <${message.message_id}>`,
      "",
      "--b--",
    ].join("\r\n");

    const parsed = core.parseDeliveryStatus(dsn);
    expect(parsed?.originalMessageId).toBe(message.message_id);

    const outcome = await core.applyBounce(tenant, parsed!);
    expect(outcome.applied).toBe("bounced");
    expect(outcome.matched?.id).toBe(message.id);
    expect(outcome.suppressed).toBe(true);

    const bounced = await core.getOutbound(tenant, message.id);
    expect(bounced?.status).toBe("bounced");
    expect(bounced?.bounce_kind).toBe("hard");

    // The address is stopped, and the ticket is no longer pretending.
    expect(await core.isSuppressed(tenant, requesterEmail)).toBe(true);
    const ticket = await core.getTicket(tenant, ticketId);
    expect(ticket?.status).toBe("triaged");

    const events = await core.eventsFor(tenant, ticketId);
    const failure = events.find(
      (e) => e.kind === "error" && e.payload.stage === "delivery",
    );
    expect(failure).toBeDefined();
    expect(String(failure?.payload.summary)).toContain("bounced");

    // A retry is refused while the address is suppressed: lifting that is a
    // separate, audited decision, and doing it implicitly is how a complaint
    // becomes a second complaint.
    await expect(core.retryOutbound(tenant, message.id)).rejects.toThrow(
      /suppression list/,
    );

    // A new reply to the same person is recorded and never attempted.
    const blocked = await queueReply("Are you still seeing this?");
    expect(blocked.status).toBe("suppressed");

    expect(await core.unsuppressAddress(tenant, requesterEmail, "confirmed by phone")).toBe(
      true,
    );
    const retried = await core.retryOutbound(tenant, message.id);
    expect(retried?.status).toBe("queued");
    // A fresh budget rather than a reset counter: what has already been tried
    // is part of why somebody is looking at this row.
    expect(retried!.max_attempts).toBeGreaterThan(retried!.attempts);
  }, 60_000);

  /**
   * The kill switch has to reach the queue.
   *
   * Before there was a transport, `AGENT_MODE` was enough on its own: nothing
   * was ever sent, so nothing could be in flight when somebody flipped it. Now
   * a reply can be queued in `auto` and delivered seconds later, and the P4
   * gate — flipping the switch stops outbound contact within one ticket — is
   * only true if a narrowed mode stops the queue too.
   */
  it("does not deliver an agent's reply after the tenant narrows autonomy", async () => {
    if (guard()) return expect(available).toBe(false);

    const message = await queueReply("Reconnect and try again. #5");
    // As the agent would have queued it. `queueReply` runs as the system here,
    // which is deliberately not subject to the switch.
    await core.query(`update outbound_messages set created_by = 'agent' where id = $1`, [
      message.id,
    ]);
    await core.setStatus(tenant, ticketId, "resolved");

    await core.updateSettingsUnaudited(
      businessId,
      core.BusinessSettings.parse({ agent_mode_override: "shadow" }),
    );

    const result = await core.deliverOutbound(message.id);
    expect(result.status).toBe("cancelled");

    const after = await core.getOutbound(tenant, message.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.sent_at).toBeNull();

    // And the ticket does not get to stay resolved on the strength of a reply
    // nobody received.
    const ticket = await core.getTicket(tenant, ticketId);
    expect(ticket?.status).toBe("triaged");

    // A human's reply is not the agent's, and the switch is a statement about
    // the agent, so the same queue still delivers it.
    const humanMessage = await queueReply("Reconnect and try again. #6");
    await core.query(
      `update outbound_messages set created_by = 'human:someone' where id = $1`,
      [humanMessage.id],
    );
    expect((await core.deliverOutbound(humanMessage.id)).status).toBe("sent");

    await core.updateSettingsUnaudited(businessId, core.BusinessSettings.parse({}));
  }, 60_000);

  it("audits the decisions a person made about somebody's mail", async () => {
    if (guard()) return expect(available).toBe(false);

    const rows = await core.query<{ action: string; resource_id: string }>(
      `select action, resource_id from audit_events
        where business_id = $1 and action like 'notification.%'
        order by id`,
      [businessId],
    );
    const actions = rows.map((r) => r.action);
    // Suppressing an address and lifting that suppression both decide whether a
    // person can be contacted at all, which is the kind of thing somebody may
    // have to answer for later.
    expect(actions).toContain("notification.suppress");
    expect(actions).toContain("notification.unsuppress");
    expect(actions).toContain("notification.retry");
  }, 60_000);
});
