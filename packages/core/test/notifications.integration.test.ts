import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Notifications against a real Postgres.
 *
 * `notifications.test.ts` covers the templates and the token with no database.
 * This covers the four questions between "something happened" and "a message is
 * queued", every one of which is a query: does this tenant send this kind, has
 * this person opted out, has it already been sent, and who counts as the queue.
 *
 * It also pins down two decisions that would be easy to break by accident. A
 * manager can cause a notification without holding `action:execute`, and a
 * requester's message must never contain a console link.
 */

const spoolDir = path.join(os.tmpdir(), `hd-notify-int-${Date.now()}`);
process.env.OUTBOUND_EMAIL_PROVIDER = "spool";
process.env.OUTBOUND_SPOOL_DIR = spoolDir;
process.env.APP_BASE_URL = "https://console.test";

const core = await import("../src/index.js");

let available = true;
let businessId = "";
let system: import("../src/index.js").TenantContext;
/** A manager: may assign tickets, holds no `action:execute`. */
let manager: import("../src/index.js").TenantContext;
let staffId = "";
let staffEmail = "";
let oncallEmail = "";
let requesterEmail = "";
let managerEmail = "";
let ticketId = "";

async function makeTicket(subject: string): Promise<string> {
  const result = await core.intakeMessage(system, {
    source: "email",
    source_message_id: `notify-${crypto.randomUUID()}@example.test`,
    requester_email: requesterEmail,
    requester_name: "Test Person",
    subject,
    body: "Something is broken.",
    attachments: [],
    received_at: new Date(),
    meta: {},
  });
  return result.ticket.id;
}

beforeAll(async () => {
  try {
    await core.query("select 1");
  } catch {
    available = false;
    return;
  }

  const stamp = Date.now();
  const row = await core.queryOne<{ id: string }>(
    `insert into businesses (name, type, settings, intake_address)
     values ($1, 'it_services', '{}'::jsonb, $2) returning id`,
    [`notify-${stamp}`, `support-${stamp}@acme.test`],
  );
  businessId = row!.id;
  system = core.systemContext(businessId, { requestId: "notify-test" });

  staffEmail = `desk-${stamp}@acme.test`;
  const staff = await core.upsertStaff({
    business_id: businessId,
    email: staffEmail,
    full_name: "Desk Person",
  });
  staffId = staff.id;

  oncallEmail = `oncall-${stamp}@acme.test`;
  await core.query(
    `insert into staff (business_id, email, full_name, queue) values ($1,$2,$3,'oncall')`,
    [businessId, oncallEmail, "On Call"],
  );

  managerEmail = `manager-${stamp}@acme.test`;
  const managerId = await core.createUserUnaudited({
    email: managerEmail,
    fullName: "Queue Manager",
    password: "correct horse battery staple",
  });
  await core.addMembershipUnaudited(managerId, businessId, "manager");
  manager = core.humanContext({
    businessId,
    actorId: managerId,
    actorEmail: managerEmail,
    role: "manager",
  });

  requesterEmail = `person-${stamp}@example.test`;
  ticketId = await makeTicket("VPN keeps dropping");
}, 60_000);

beforeEach(async () => {
  if (!available) return;
  // Each test starts from the default policy and an empty opt-out list.
  await core.updateSettingsUnaudited(businessId, core.BusinessSettings.parse({}));
  await core.query(`delete from notification_optouts where business_id = $1`, [
    businessId,
  ]);
});

afterAll(async () => {
  if (businessId) await core.purgeBusinessUnaudited(businessId);
  await core.closeQueues().catch(() => {});
  await core.closePool().catch(() => {});
  await fs.rm(spoolDir, { recursive: true, force: true }).catch(() => {});
});

function guard(): boolean {
  if (!available) {
    console.warn("[notify] no database reachable; skipping. npm run db:up && npm run db:migrate");
  }
  return !available;
}

/** The messages queued for one address, newest first. */
async function messagesTo(email: string) {
  return core.query<{
    id: string;
    kind: string;
    subject: string;
    body: string;
    ticket_id: string | null;
    in_reply_to: string | null;
  }>(
    `select id, kind, subject, body, ticket_id, in_reply_to
       from outbound_messages
      where business_id = $1 and to_email = lower($2)
      order by created_at desc`,
    [businessId, email],
  );
}

// ---------------------------------------------------------------------------

describe("assignment notifications", () => {
  it("tells the person, and lets a manager cause it without action:execute", async () => {
    if (guard()) return expect(available).toBe(false);

    // The permission story: assigning needs `ticket:assign`, which a manager
    // has, and queueing mail needs `action:execute`, which a manager does not.
    // The notification is a consequence of an authorized action rather than a
    // second privileged action by that person, so it is queued as the system.
    expect(core.can(manager, "ticket:assign")).toBe(true);
    expect(core.can(manager, "action:execute")).toBe(false);

    const ticket = await makeTicket("printer offline");
    const summary = await core.notifyAssignment(manager, {
      ticketIds: [ticket],
      staffId,
    });

    expect(summary.results.map((r) => r.sent)).toEqual([true]);
    const [message] = await messagesTo(staffEmail);
    expect(message?.kind).toBe("notify:assignment");
    expect(message?.ticket_id).toBe(ticket);
    expect(message?.subject).toContain("Assigned to you");
    expect(message?.body).toContain(`https://console.test/tickets/${ticket}`);
    // Every staff notification carries both links: "stop these" and "stop
    // everything" are different intentions.
    expect(message?.body).toContain("https://console.test/unsubscribe/");
    expect(message?.body).toContain("Stop all notifications:");
  }, 60_000);

  it("sends one covering note for a bulk assignment", async () => {
    if (guard()) return expect(available).toBe(false);

    const ids = [
      await makeTicket("bulk one"),
      await makeTicket("bulk two"),
      await makeTicket("bulk three"),
      await makeTicket("bulk four"),
      await makeTicket("bulk five"),
    ];
    const before = (await messagesTo(staffEmail)).length;
    const summary = await core.notifyAssignment(manager, { ticketIds: ids, staffId });

    expect(summary.results).toHaveLength(1);
    const after = await messagesTo(staffEmail);
    expect(after.length).toBe(before + 1);
    expect(after[0]!.subject).toBe("5 tickets assigned to you");
    // The digest is about the batch, so it hangs off no single ticket.
    expect(after[0]!.ticket_id).toBeNull();
  }, 60_000);

  it("does not send twice for the same assignment", async () => {
    if (guard()) return expect(available).toBe(false);

    const ticket = await makeTicket("double clicked");
    await core.notifyAssignment(manager, { ticketIds: [ticket], staffId });
    const again = await core.notifyAssignment(manager, {
      ticketIds: [ticket],
      staffId,
    });
    expect(again.results[0]!.sent).toBe(false);
    expect(again.results[0]!.skipped).toBe("duplicate");
  }, 60_000);

  it("says nothing when a ticket is unassigned", async () => {
    if (guard()) return expect(available).toBe(false);
    const summary = await core.notifyAssignment(manager, {
      ticketIds: [ticketId],
      staffId: null,
    });
    expect(summary.results).toEqual([]);
  }, 60_000);
});

describe("consent", () => {
  it("stops one kind when somebody unsubscribes from it", async () => {
    if (guard()) return expect(available).toBe(false);

    const token = core.unsubscribeToken({
      businessId,
      email: staffEmail,
      kind: "assignment",
    });
    const claim = core.verifyUnsubscribeToken(token)!;
    expect(await core.optOut(system, { email: claim.email, kind: "assignment" })).toBe(
      true,
    );

    const ticket = await makeTicket("after unsubscribing");
    const summary = await core.notifyAssignment(manager, {
      ticketIds: [ticket],
      staffId,
    });
    expect(summary.results[0]!.skipped).toBe("opted_out");

    // And clicking the link a second time is not an error.
    expect(await core.optOut(system, { email: claim.email, kind: "assignment" })).toBe(
      false,
    );
  }, 60_000);

  it("stops everything when somebody unsubscribes from all", async () => {
    if (guard()) return expect(available).toBe(false);

    await core.optOut(system, { email: oncallEmail, kind: "all" });
    const ticket = await makeTicket("escalate after opting out of all");
    const summary = await core.notifyEscalation(system, {
      ticketId: ticket,
      queue: "oncall",
      reason: "no runbook support",
      summary: "The agent could not answer this.",
      suggestedFix: null,
    });
    expect(summary.results[0]!.skipped).toBe("opted_out");
  }, 60_000);

  /**
   * The link in the mail, used the way a recipient would use it.
   *
   * Everything else here calls `optOut` directly. This one takes the URL out of
   * a message that was actually queued, pulls the token off the end of it, and
   * verifies that — which is the only way to catch a footer that renders a
   * link nobody can use.
   */
  it("hands out a working link, and the link stops the mail", async () => {
    if (guard()) return expect(available).toBe(false);

    const ticket = await makeTicket("unsubscribe round trip");
    await core.notifyAssignment(manager, { ticketIds: [ticket], staffId });
    const [message] = await messagesTo(staffEmail);

    const url = /https:\/\/console\.test\/unsubscribe\/(\S+)/.exec(message!.body);
    expect(url, "the footer should carry an unsubscribe URL").not.toBeNull();

    const claim = core.verifyUnsubscribeToken(url![1]!);
    expect(claim).toEqual({
      businessId,
      email: staffEmail.toLowerCase(),
      kind: "assignment",
    });

    // What the route does with it.
    const ctx = core.systemContext(claim!.businessId, { requestId: "unsubscribe" });
    expect(
      await core.optOut(ctx, {
        email: claim!.email,
        kind: "assignment",
        source: "self",
      }),
    ).toBe(true);

    const next = await core.notifyAssignment(manager, {
      ticketIds: [await makeTicket("after the link was used")],
      staffId,
    });
    expect(next.results[0]!.skipped).toBe("opted_out");
  }, 60_000);

  it("records the opt-out in the audit log, and who did it", async () => {
    if (guard()) return expect(available).toBe(false);

    await core.optOut(system, {
      email: staffEmail,
      kind: "sla_warning",
      source: "self",
    });
    const rows = await core.query<{ action: string; new_value: unknown }>(
      `select action, new_value from audit_events
        where business_id = $1 and action = 'notification.optout'
        order by id desc limit 1`,
      [businessId],
    );
    expect(rows[0]?.action).toBe("notification.optout");
    expect(rows[0]?.new_value).toMatchObject({ kind: "sla_warning", source: "self" });

    // Putting somebody back on the list is a different decision, needs
    // `config:update`, and is audited with a reason.
    await expect(
      core.optIn(manager, staffEmail, "sla_warning", "they asked"),
    ).rejects.toThrow(core.AuthorizationError);
    expect(await core.optIn(system, staffEmail, "sla_warning", "they asked")).toBe(true);
  }, 60_000);
});

describe("tenant policy", () => {
  it("skips a kind the tenant has switched off", async () => {
    if (guard()) return expect(available).toBe(false);

    await core.updateSettingsUnaudited(
      businessId,
      core.BusinessSettings.parse({ notifications: { assignment: false } }),
    );
    const ticket = await makeTicket("assignment off");
    const summary = await core.notifyAssignment(manager, {
      ticketIds: [ticket],
      staffId,
    });
    expect(summary.results[0]!.skipped).toBe("kind_disabled");
  }, 60_000);

  it("skips everything when the master switch is off", async () => {
    if (guard()) return expect(available).toBe(false);

    await core.updateSettingsUnaudited(
      businessId,
      core.BusinessSettings.parse({ notifications: { enabled: false } }),
    );
    const ticket = await makeTicket("all notifications off");
    const summary = await core.notifyEscalation(system, {
      ticketId: ticket,
      queue: "oncall",
      reason: "no runbook support",
      summary: "The agent could not answer this.",
      suggestedFix: null,
    });
    expect(summary.results[0]!.skipped).toBe("tenant_disabled");
  }, 60_000);
});

describe("escalation", () => {
  it("writes to the queue the agent handed it to", async () => {
    if (guard()) return expect(available).toBe(false);

    const ticket = await makeTicket("escalate to oncall");
    const summary = await core.notifyEscalation(system, {
      ticketId: ticket,
      queue: "oncall",
      reason: "security sensitive",
      summary: "Possible phishing; the agent never answers these.",
      suggestedFix: null,
    });
    expect(summary.results.map((r) => r.sent)).toEqual([true]);

    const [message] = await messagesTo(oncallEmail);
    expect(message?.kind).toBe("notify:escalation");
    expect(message?.subject).toContain("Escalated to oncall");
    expect(message?.body).toContain("security sensitive");
  }, 60_000);

  it("falls back to the ops address, and records when there is nobody", async () => {
    if (guard()) return expect(available).toBe(false);

    const ticket = await makeTicket("escalate to an empty queue");
    const noBody = await core.notifyEscalation(system, {
      ticketId: ticket,
      queue: "queue-with-nobody-in-it",
      reason: "nobody home",
      summary: "No staff on that queue.",
      suggestedFix: null,
    });
    expect(noBody.nobody).toBe(true);
    // An escalation that reached nobody is worth recording: the agent has
    // stopped working on the ticket by then.
    const events = await core.eventsFor(system, ticket);
    expect(
      events.some(
        (e) => e.payload.stage === "notification" && e.payload.skipped === "nobody to notify",
      ),
    ).toBe(true);

    const ops = `ops-${Date.now()}@acme.test`;
    await core.updateSettingsUnaudited(
      businessId,
      core.BusinessSettings.parse({ notifications: { ops_address: ops } }),
    );
    const withOps = await core.notifyEscalation(system, {
      ticketId: await makeTicket("escalate with ops fallback"),
      queue: "queue-with-nobody-in-it",
      reason: "nobody home",
      summary: "No staff on that queue.",
      suggestedFix: null,
    });
    expect(withOps.results.map((r) => r.sent)).toEqual([true]);
    expect((await messagesTo(ops)).length).toBe(1);
  }, 60_000);
});

describe("approval", () => {
  it("emails whoever could decide it, once per request", async () => {
    if (guard()) return expect(available).toBe(false);

    const ticket = await makeTicket("password reset needs approval");
    const request = await core.requestApproval(system, {
      ticket_id: ticket,
      tool_name: "identity.reset_password",
      args: { email: requesterEmail },
      risk_tier: "sensitive",
      rationale: "Standard reset with a forced change at next sign-in.",
    });

    const input = {
      approvalId: request.id,
      ticketId: ticket,
      tool: "identity.reset_password",
      summary: `Reset password for ${requesterEmail}`,
      rationale: request.rationale,
      riskTier: request.risk_tier,
      expiresAt: request.expires_at,
    };
    const first = await core.notifyApprovalRequest(system, input);
    expect(first.results.map((r) => r.sent)).toEqual([true]);

    const [message] = await messagesTo(managerEmail);
    expect(message?.kind).toBe("notify:approval");
    expect(message?.body).toContain("identity.reset_password (sensitive)");
    expect(message?.body).toContain("https://console.test/approvals");

    // The pipeline can run again; the approver should not hear about it twice.
    const second = await core.notifyApprovalRequest(system, input);
    expect(second.results[0]!.skipped).toBe("duplicate");
  }, 60_000);
});

describe("resolution", () => {
  it("threads onto the requester's conversation and shows them no console", async () => {
    if (guard()) return expect(available).toBe(false);

    const ticket = await makeTicket("laptop fixed at the desk");
    const summary = await core.notifyResolution(system, { ticketId: ticket });
    expect(summary.results.map((r) => r.sent)).toEqual([true]);

    const [message] = await messagesTo(requesterEmail);
    expect(message?.kind).toBe("notify:resolution");
    // Threaded onto the message they sent in, so it lands in the same
    // conversation rather than starting a new one.
    expect(message?.in_reply_to).not.toBeNull();
    expect(message?.subject).toContain(`[NG-${ticket.slice(0, 8)}]`);
    expect(message?.body).toContain("reply to this email and the ticket reopens");
    // The one assertion that protects the requester from operator detail.
    expect(message?.body).not.toContain("console.test/tickets");
    expect(message?.body).not.toContain("unsubscribe");
  }, 60_000);

  it("stays quiet when the requester has just had a reply", async () => {
    if (guard()) return expect(available).toBe(false);

    const ticket = await makeTicket("resolved right after a reply");
    await core.queueOutbound(system, {
      ticket_id: ticket,
      kind: "reply",
      to_email: requesterEmail,
      from_email: "support@acme.test",
      subject: "Re: resolved right after a reply",
      body: "That should be fixed now — let me know if not.",
      message_id: `reply-${crypto.randomUUID()}@acme.test`,
      idempotency_key: `reply-${crypto.randomUUID()}`,
    });

    // "That should be fixed now, let me know" followed immediately by "your
    // ticket has been resolved" is the most irritating pair of emails this
    // system could send.
    const summary = await core.notifyResolution(system, { ticketId: ticket });
    expect(summary.results).toEqual([]);
  }, 60_000);
});

describe("the SLA warning sweep", () => {
  /**
   * A ticket inside its first-response warning window.
   *
   * `first_response_warn_at` is set explicitly, the way `computeSla` sets it at
   * triage, because the sweep reads that instant rather than recomputing a
   * share of the window in SQL. Twenty minutes before a hundred-minute window
   * closes is the 20% default.
   */
  async function ticketNearingFirstResponse(assign: boolean): Promise<string> {
    const id = await makeTicket("nearly out of time");
    await core.query(
      `update tickets
          set created_at = now() - interval '90 minutes',
              first_response_due_at = now() + interval '10 minutes',
              first_response_warn_at = now() - interval '10 minutes',
              resolution_due_at = now() + interval '20 hours',
              resolution_warn_at = now() + interval '16 hours',
              assigned_to = $2,
              status = 'triaged',
              priority = 'P2'
        where id = $1`,
      [id, assign ? staffId : null],
    );
    return id;
  }

  it("warns the assignee once, however often it runs", async () => {
    if (guard()) return expect(available).toBe(false);

    const ticket = await ticketNearingFirstResponse(true);
    const first = await core.warnNearingSla(system);
    expect(first.checked).toBeGreaterThan(0);
    expect(first.sent).toBeGreaterThan(0);

    const [message] = await messagesTo(staffEmail);
    expect(message?.kind).toBe("notify:sla_warning");
    expect(message?.subject).toContain("First response due in");
    expect(message?.ticket_id).toBe(ticket);

    // The queue is where somebody watches a slipping deadline. The email is
    // there to make them look at it once, not every five minutes.
    const second = await core.warnNearingSla(system);
    expect(second.sent).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
  }, 60_000);

  it("leaves a ticket alone while it is still early in its window", async () => {
    if (guard()) return expect(available).toBe(false);

    const id = await makeTicket("plenty of time left");
    await core.query(
      `update tickets
          set created_at = now() - interval '5 minutes',
              first_response_due_at = now() + interval '4 hours',
              first_response_warn_at = now() + interval '3 hours 12 minutes',
              assigned_to = $2, status = 'triaged', priority = 'P3'
        where id = $1`,
      [id, staffId],
    );
    const due = await core.ticketsNearingSla(system);
    expect(due.map((d) => d.ticket_id)).not.toContain(id);
  }, 60_000);

  it("warns the queue when a ticket has no owner", async () => {
    if (guard()) return expect(available).toBe(false);

    // Unassigned, so the warning goes to whoever watches the default queue
    // rather than to an arbitrary individual who would treat it as somebody
    // else's problem.
    await ticketNearingFirstResponse(false);
    const summary = await core.warnNearingSla(system);
    expect(summary.sent).toBeGreaterThan(0);
    const [message] = await messagesTo(staffEmail);
    expect(message?.kind).toBe("notify:sla_warning");
  }, 60_000);

  it("records that nobody was warned when there is nobody to warn", async () => {
    if (guard()) return expect(available).toBe(false);

    // Unassigned, a default queue with nobody on it, and no ops address. The
    // warning has nowhere to go, and that is worth writing on the ticket: it is
    // the fact somebody will want when the breach is reviewed.
    await core.updateSettingsUnaudited(
      businessId,
      core.BusinessSettings.parse({
        routing: { default_queue: "queue-with-nobody-in-it" },
      }),
    );
    const ticket = await ticketNearingFirstResponse(false);
    const summary = await core.warnNearingSla(system);
    expect(summary.nobody).toBeGreaterThan(0);
    expect(summary.sent).toBe(0);

    const events = await core.eventsFor(system, ticket);
    expect(
      events.some(
        (e) =>
          e.payload.stage === "notification" &&
          e.payload.notification === "sla_warning" &&
          e.payload.skipped === "nobody to notify",
      ),
    ).toBe(true);
  }, 60_000);

  it("does not scan at all when the tenant has switched warnings off", async () => {
    if (guard()) return expect(available).toBe(false);

    await core.updateSettingsUnaudited(
      businessId,
      core.BusinessSettings.parse({ notifications: { sla_warning: false } }),
    );
    await ticketNearingFirstResponse(true);
    const summary = await core.warnNearingSla(system);
    expect(summary).toEqual({ checked: 0, sent: 0, skipped: 0, nobody: 0 });
  }, 60_000);
});
