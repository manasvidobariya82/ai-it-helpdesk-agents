import { describe, expect, it } from "vitest";
import {
  BusinessSettings,
  NOTIFICATIONS,
  NotificationKind,
  classifyField,
  directionOf,
  formatInZone,
  humanMinutes,
  portalToken,
  renderNotification,
  subjectTag,
  unsubscribeToken,
  verifyPortalToken,
  verifyUnsubscribeToken,
  type NotificationPayload,
} from "@hd/core";

/**
 * Notifications, the parts that are judgements rather than plumbing.
 *
 * Three things are worth testing without a database, and they are the three
 * that would be expensive to get wrong: what the messages say, whether the
 * unsubscribe link can be tampered with, and which of these settings the
 * configuration gate treats as a safety control.
 */

const TICKET = {
  id: "1a2b3c4d-1111-2222-3333-444455556666",
  subject: "VPN keeps dropping",
  priority: "P2",
  category: "network_connectivity",
  status: "triaged",
  requester_email: "alice@example.test",
};

const TAG = subjectTag(TICKET.id);

// ---------------------------------------------------------------------------

describe("the catalogue", () => {
  it("covers every kind, with an audience and a setting", () => {
    // A kind with no entry would throw at send time, which is the worst place
    // to find out. This is the check that makes the enum and the table agree.
    for (const kind of NotificationKind.options) {
      const spec = NOTIFICATIONS[kind];
      expect(spec, kind).toBeDefined();
      expect(["staff", "requester"]).toContain(spec.audience);
      expect(BusinessSettings.parse({}).notifications).toHaveProperty(spec.setting);
      // The footer says "Stop <label> emails", so a missing label would print
      // "Stop undefined emails" at the bottom of a real message.
      expect(spec.label, kind).toBeTruthy();
    }
  });

  it("sends exactly one kind to people outside the company", () => {
    // Everything else is internal. If this count changes, somebody has added a
    // message a requester will read, and the copy deserves a second look.
    const external = NotificationKind.options.filter(
      (k) => NOTIFICATIONS[k].audience === "requester",
    );
    expect(external).toEqual(["resolution"]);
  });
});

describe("what the messages say", () => {
  it("puts the ticket tag and the point in the subject", () => {
    const rendered = renderNotification({
      kind: "assignment",
      tickets: [TICKET],
      assignedBy: "raj@northgate.example",
      ticketUrl: (id) => `https://console.test/tickets/${id}`,
      queueUrl: "https://console.test/",
    });
    expect(rendered.subject).toBe(`${TAG} Assigned to you: VPN keeps dropping`);
    expect(rendered.body).toContain("raj@northgate.example assigned this ticket to you");
    // A job is not a person, and "system assigned this to you" reads like a bug
    // report about the system.
    expect(
      renderNotification({
        kind: "assignment",
        tickets: [TICKET],
        assignedBy: null,
        ticketUrl: (id) => `https://console.test/tickets/${id}`,
        queueUrl: "https://console.test/",
      }).body,
    ).toContain("This ticket has been assigned to you.");
    expect(rendered.body).toContain("P2");
    expect(rendered.body).toContain("https://console.test/tickets/");
  });

  it("collapses a bulk assignment into one covering note", () => {
    const tickets = Array.from({ length: 12 }, (_, i) => ({
      ...TICKET,
      id: `${i}`.padStart(8, "0") + "-1111-2222-3333-444455556666",
      subject: `ticket ${i}`,
    }));
    const rendered = renderNotification({
      kind: "assignment",
      tickets,
      assignedBy: "a manager",
      ticketUrl: (id) => `https://console.test/tickets/${id}`,
      queueUrl: "https://console.test/",
    });

    expect(rendered.subject).toBe("12 tickets assigned to you");
    // Ten listed, the rest counted: a covering note, not a wall.
    expect(rendered.body).toContain("ticket 9");
    expect(rendered.body).toContain("… and 2 more.");
  });

  it("says when the SLA clock actually stops", () => {
    const rendered = renderNotification({
      kind: "sla_warning",
      ticket: TICKET,
      clock: "first_response",
      dueAt: new Date("2026-09-17T09:00:00Z"),
      minutesLeft: 48,
      timezone: "Europe/London",
      ticketUrl: "https://console.test/tickets/x",
    });
    expect(rendered.subject).toContain("First response due in 48 minutes");
    // The sentence that stops somebody opening the ticket and assuming the
    // clock stopped with it.
    expect(rendered.body).toContain(
      "The clock stops when the requester hears from us",
    );
  });

  it("labels a suggested fix as unverified", () => {
    const rendered = renderNotification({
      kind: "escalation",
      ticket: TICKET,
      queue: "oncall",
      reason: "no runbook support",
      summary: "Certificate expired on the VPN gateway.",
      suggestedFix: "Reissue the client certificate.",
      ticketUrl: "https://console.test/tickets/x",
    });
    expect(rendered.subject).toBe(`${TAG} Escalated to oncall: VPN keeps dropping`);
    // The agent did not do this and did not check it. A suggestion that reads
    // like an instruction is how somebody runs it without thinking.
    expect(rendered.body).toContain("unverified — the agent did not do this");
  });

  it("tells an approver what expires and what happens if it does", () => {
    const rendered = renderNotification({
      kind: "approval",
      ticket: TICKET,
      tool: "identity.reset_password",
      summary: "Reset password for alice@example.test, notify via manager",
      rationale: "Standard password reset with a forced change at next sign-in.",
      riskTier: "sensitive",
      expiresAt: new Date("2026-09-18T09:00:00Z"),
      timezone: "Europe/London",
      approvalsUrl: "https://console.test/approvals",
    });
    expect(rendered.subject).toContain("Approval needed:");
    expect(rendered.body).toContain("identity.reset_password (sensitive)");
    expect(rendered.body).toContain("Expires:");
    expect(rendered.body).toContain("If it expires it has to be raised again");
  });

  it("gives the requester a way back in and no console link", () => {
    const rendered = renderNotification({
      kind: "resolution",
      ticket: TICKET,
      resolvedBy: "Sam Okafor",
      signature: "— IT Support",
      portalUrl: "https://console.test/portal/abc.def",
    });
    expect(rendered.body).toContain("resolved by Sam Okafor");
    // The escape hatch. A resolution notice without one is a system telling
    // somebody they are finished.
    expect(rendered.body).toContain("reply to this email and the ticket reopens");
    expect(rendered.body).toContain("— IT Support");
    // A requester cannot open a console URL, and being sent one is worse than
    // being sent nothing.
    expect(rendered.body).not.toContain("/tickets/");
  });

  it("rounds the time left to something a person would say", () => {
    expect(humanMinutes(1)).toBe("1 minute");
    expect(humanMinutes(48)).toBe("48 minutes");
    expect(humanMinutes(120)).toBe("2 hours");
    expect(humanMinutes(2880)).toBe("2 days");
    expect(humanMinutes(-5)).toBe("0 minutes");
  });

  it("prints the deadline in the tenant's own timezone", () => {
    const at = new Date("2026-09-17T09:00:00Z");
    expect(formatInZone(at, "Europe/London")).toContain("10:00");
    expect(formatInZone(at, "Asia/Kolkata")).toContain("14:30");
    // A broken timezone in settings must not stop the mail.
    expect(formatInZone(at, "Not/AZone")).toContain("2026-09-17 09:00 UTC");
  });
});

// ---------------------------------------------------------------------------

describe("the unsubscribe link", () => {
  const claim = {
    businessId: "b0000000-1111-2222-3333-444455556666",
    email: "Raj.Patel@Northgate.example",
    kind: "assignment",
  };

  it("round-trips, lowercasing the address", () => {
    const parsed = verifyUnsubscribeToken(unsubscribeToken(claim));
    expect(parsed).toEqual({
      businessId: claim.businessId,
      email: "raj.patel@northgate.example",
      kind: "assignment",
    });
  });

  it("refuses a token whose payload was edited", () => {
    const token = unsubscribeToken(claim);
    const [encoded, kind, business, mac] = token.split(".");

    // Somebody else's address, our signature.
    const otherEmail = Buffer.from("ceo@northgate.example").toString("base64url");
    expect(verifyUnsubscribeToken(`${otherEmail}.${kind}.${business}.${mac}`)).toBeNull();

    // A different kind — "stop everything" instead of "stop assignment mail".
    expect(verifyUnsubscribeToken(`${encoded}.all.${business}.${mac}`)).toBeNull();

    // Another tenant. This is the one that matters: the address in the token is
    // not a secret, and without the tenant in the signature a recipient could
    // opt somebody out of a business they were never written to.
    expect(
      verifyUnsubscribeToken(
        `${encoded}.${kind}.99999999-1111-2222-3333-444455556666.${mac}`,
      ),
    ).toBeNull();

    expect(verifyUnsubscribeToken("nonsense")).toBeNull();
    expect(verifyUnsubscribeToken("")).toBeNull();
  });

  /**
   * Domain separation, which is the reason both link types can share a secret.
   *
   * Without the purpose in the signed string, an unsubscribe link — which is
   * printed at the bottom of every notification and forwarded around freely —
   * would verify as a portal token, and a portal token is read access to
   * somebody's ticket history.
   */
  it("is not a portal link, and a portal link is not one of these", () => {
    const requesterId = "c0000000-1111-2222-3333-444455556666";
    expect(verifyUnsubscribeToken(portalToken(requesterId))).toBeNull();
    expect(verifyPortalToken(unsubscribeToken(claim))).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("which notification settings are safety controls", () => {
  it("defaults every notification on", () => {
    // The opposite of how autonomy defaults, and deliberately: an unsent
    // notification is a person not finding out.
    const n = BusinessSettings.parse({}).notifications;
    expect(n.enabled).toBe(true);
    expect(n.assignment).toBe(true);
    expect(n.sla_warning).toBe(true);
    expect(n.escalation).toBe(true);
    expect(n.approval).toBe(true);
    expect(n.resolution).toBe(true);
    expect(n.sla_warning_at_percent).toBe(20);
    expect(n.ops_address).toBeNull();
  });

  it("treats the master switch and the approval notice as critical", () => {
    // Both reduce human visibility of what the agent is doing, which is this
    // codebase's definition of a change that needs the extra gate.
    expect(classifyField("notifications.enabled")).toBe("critical");
    expect(classifyField("notifications.approval")).toBe("critical");
  });

  it("treats the rest as ordinary preferences", () => {
    // Somebody deciding they do not want assignment mail is not a safety
    // decision, and gating it behind security:update would be theatre.
    expect(classifyField("notifications.assignment")).toBe("normal");
    expect(classifyField("notifications.resolution")).toBe("normal");
    expect(classifyField("notifications.sla_warning_at_percent")).toBe("normal");
    expect(classifyField("notifications.ops_address")).toBe("normal");
  });

  it("reads silencing a critical notice as widening", () => {
    expect(directionOf("notifications.enabled", true, false)).toBe("widening");
    expect(directionOf("notifications.enabled", false, true)).toBe("narrowing");
    expect(directionOf("notifications.approval", true, false)).toBe("widening");
    // The generic leaf `enabled` must not become a safety keyword for every
    // future setting that happens to use the word.
    expect(directionOf("something_else.enabled", true, false)).toBe("lateral");
  });

  it("does not gate the ordinary toggles in either direction", () => {
    expect(directionOf("notifications.assignment", true, false)).toBe("lateral");
    expect(directionOf("notifications.sla_warning_at_percent", 20, 40)).toBe("lateral");
  });
});

// ---------------------------------------------------------------------------

describe("the payload type", () => {
  it("cannot be built for a kind the catalogue does not know", () => {
    // A compile-time guarantee, asserted here so the intent is written down:
    // `renderNotification` switches exhaustively over the union, so adding a
    // kind without a template fails the build rather than sending an empty
    // email.
    const payload: NotificationPayload = {
      kind: "resolution",
      ticket: TICKET,
      resolvedBy: null,
      signature: "— IT",
      portalUrl: null,
    };
    expect(renderNotification(payload).body).toContain("has been resolved");
  });
});
