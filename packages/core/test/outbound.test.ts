import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyPostmarkError,
  classifySmtpError,
  looksLikeMailerReport,
  parseDeliveryStatus,
  PermanentDeliveryError,
  renderReply,
  replyIdempotencyKey,
  replySubject,
  retryDelayMs,
  spoolTransport,
  toRfc822,
  TransientDeliveryError,
} from "@hd/core";

/**
 * Outbound mail, the parts that are decisions rather than plumbing.
 *
 * Everything tested here is pure and runs with no database, no Redis and no
 * mail server, which is deliberate: the interesting content of a mail transport
 * is not "does the socket open", it is the two judgements that decide what
 * happens to a message — is this failure worth retrying, and is this inbound
 * document really a bounce. Both are one-line mistakes away from either
 * discarding mail that would have gone through or letting a stranger suppress
 * an address.
 */

const TICKET = "1a2b3c4d-1111-2222-3333-444455556666";

function render(over: Partial<Parameters<typeof renderReply>[0]> = {}) {
  return renderReply({
    ticketId: TICKET,
    subject: "VPN keeps dropping",
    body: "Try reconnecting.\n\n— IT Support",
    toEmail: "Alice@Example.com",
    toName: "Alice Smith",
    intakeAddress: "support@acme.test",
    fallbackFrom: "helpdesk@localhost",
    fromName: "IT Support",
    messageIdDomain: "acme.test",
    ...over,
  });
}

// ---------------------------------------------------------------------------

describe("the subject line", () => {
  it("carries the ticket tag, which is the fallback threading key", () => {
    expect(replySubject("VPN keeps dropping", TICKET)).toBe(
      "Re: VPN keeps dropping [NG-1a2b3c4d]",
    );
  });

  it("does not accumulate on a reply to a reply", () => {
    // The failure this prevents is visible and embarrassing: `Re: Re: Re: Fwd:
    // printer [NG-1a2b3c4d] [NG-1a2b3c4d] [NG-1a2b3c4d]`.
    const once = replySubject("printer broken", TICKET);
    const twice = replySubject(once, TICKET);
    const thrice = replySubject(twice, TICKET);
    expect(thrice).toBe("Re: printer broken [NG-1a2b3c4d]");
    expect(thrice.match(/\[NG-/g)).toHaveLength(1);
    expect(thrice.match(/Re:/g)).toHaveLength(1);
  });

  it("strips a forward marker too", () => {
    expect(replySubject("Fwd: laptop is slow", TICKET)).toBe(
      "Re: laptop is slow [NG-1a2b3c4d]",
    );
  });

  it("never produces an empty subject", () => {
    expect(replySubject("   ", TICKET)).toBe("Re: (no subject) [NG-1a2b3c4d]");
  });
});

describe("the idempotency key", () => {
  it("is the same for the same words on the same ticket", () => {
    // This is what makes a double-clicked Send button one email.
    expect(replyIdempotencyKey("reply", TICKET, "hello")).toBe(
      replyIdempotencyKey("reply", TICKET, "hello"),
    );
  });

  it("differs by body and by ticket", () => {
    expect(replyIdempotencyKey("reply", TICKET, "hello")).not.toBe(
      replyIdempotencyKey("reply", TICKET, "hello."),
    );
    expect(replyIdempotencyKey("reply", TICKET, "hello")).not.toBe(
      replyIdempotencyKey("reply", "other-ticket", "hello"),
    );
  });
});

describe("rendering a reply", () => {
  it("sends from the address the tenant receives on", () => {
    // Not cosmetic: a reply to a no-reply sender is a support request nobody
    // reads, and threading only closes the loop if the answer to our answer
    // arrives back in the same tenant's intake.
    const draft = render();
    expect(draft.fromEmail).toBe("support@acme.test");
    expect(draft.replyTo).toBe("support@acme.test");
  });

  it("falls back to the deployment address when the tenant has none", () => {
    expect(render({ intakeAddress: null }).fromEmail).toBe("helpdesk@localhost");
  });

  it("normalizes the recipient", () => {
    expect(render().toEmail).toBe("alice@example.com");
  });

  it("replies to the newest message on the thread", () => {
    const draft = render({
      threadMessageIds: ["<first@mail.test>", "second@mail.test"],
    });
    expect(draft.inReplyTo).toBe("second@mail.test");
    expect(draft.references).toEqual(["first@mail.test", "second@mail.test"]);
  });

  it("caps References, so a long thread cannot grow a header until a server refuses it", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `m${i}@mail.test`);
    const draft = render({ threadMessageIds: ids });
    expect(draft.references).toHaveLength(10);
    expect(draft.references.at(-1)).toBe("m29@mail.test");
  });

  it("mints a unique Message-ID on our own domain", () => {
    const a = render();
    const b = render();
    expect(a.messageId).not.toBe(b.messageId);
    expect(a.messageId.endsWith("@acme.test")).toBe(true);
  });

  it("does not touch the body", () => {
    // The body is what a human reviewed. Appending a signature here would make
    // the thing reviewed and the thing sent two different texts.
    const body = "line one\n\nline two";
    expect(render({ body }).body).toBe(body);
  });
});

describe("the message on the wire", () => {
  it("declares itself automated, so two helpdesks do not talk all night", () => {
    const raw = toRfc822(render());
    expect(raw).toContain("Auto-Submitted: auto-generated");
    expect(raw).toContain("X-Auto-Response-Suppress: All");
  });

  it("uses CRLF and separates headers from the body with a blank line", () => {
    const raw = toRfc822(render());
    const [head, ...rest] = raw.split("\r\n\r\n");
    expect(head).toContain("Message-ID: <");
    expect(rest.join("\r\n\r\n")).toContain("Try reconnecting.");
    expect(raw.includes("\n\n")).toBe(false);
  });

  it("brackets the threading headers", () => {
    const raw = toRfc822(
      render({ threadMessageIds: ["a@mail.test", "b@mail.test"] }),
    );
    expect(raw).toContain("In-Reply-To: <b@mail.test>");
    expect(raw).toContain("References: <a@mail.test> <b@mail.test>");
  });

  it("encodes a non-ASCII subject rather than hoping", () => {
    const raw = toRfc822(render({ subject: "Drucker funktioniert nicht – zurück" }));
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
  });

  it("quotes a display name containing a comma", () => {
    const raw = toRfc822(render({ toName: "Smith, Alice" }));
    expect(raw).toContain('To: "Smith, Alice" <alice@example.com>');
  });
});

describe("the spool transport", () => {
  it("writes a real message and reports where it went", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-spool-"));
    const outcome = await spoolTransport(dir).send(render());

    expect(outcome.providerMessageId).toMatch(/^spool:/);
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);

    const written = await fs.readFile(path.join(dir, files[0]!), "utf8");
    expect(written).toContain("From: IT Support <support@acme.test>");
    expect(written).toContain("Try reconnecting.");
  });
});

// ---------------------------------------------------------------------------

describe("classifying an SMTP failure", () => {
  it("treats 5xx as the far side saying stop", () => {
    const err = classifySmtpError({ message: "mailbox unavailable", responseCode: 550 });
    expect(err).toBeInstanceOf(PermanentDeliveryError);
    // 550 is a statement about the mailbox, not about this message, so the
    // address goes on the suppression list.
    expect((err as PermanentDeliveryError).suppress).toBe("hard_bounce");
  });

  it("does not suppress an address over a message-specific refusal", () => {
    const err = classifySmtpError({ message: "message too large", responseCode: 552 });
    expect(err).toBeInstanceOf(PermanentDeliveryError);
    expect((err as PermanentDeliveryError).suppress).toBeNull();
  });

  it("treats 4xx as come back later", () => {
    expect(
      classifySmtpError({ message: "greylisted, try again", responseCode: 421 }),
    ).toBeInstanceOf(TransientDeliveryError);
  });

  it("stops on bad credentials instead of burning the attempt budget", () => {
    expect(classifySmtpError({ message: "535 nope", code: "EAUTH" })).toBeInstanceOf(
      PermanentDeliveryError,
    );
  });

  it("is transient for anything it does not recognise", () => {
    // The safe direction to be wrong in is the one that tries again. Giving up
    // on mail that would have gone through is the expensive mistake.
    expect(classifySmtpError(new Error("socket hang up"))).toBeInstanceOf(
      TransientDeliveryError,
    );
    expect(classifySmtpError(undefined)).toBeInstanceOf(TransientDeliveryError);
  });
});

describe("classifying a Postmark failure", () => {
  it("suppresses on an inactive recipient", () => {
    const err = classifyPostmarkError(422, {
      ErrorCode: 406,
      Message: "You tried to send to a recipient that has been marked as inactive.",
    });
    expect(err).toBeInstanceOf(PermanentDeliveryError);
    expect((err as PermanentDeliveryError).suppress).toBe("hard_bounce");
  });

  it("retries a rate limit and a server error", () => {
    expect(classifyPostmarkError(429, null)).toBeInstanceOf(TransientDeliveryError);
    expect(classifyPostmarkError(503, null)).toBeInstanceOf(TransientDeliveryError);
  });

  it("waits out a paused server rather than dead-lettering every reply", () => {
    expect(
      classifyPostmarkError(422, { ErrorCode: 405, Message: "Sending is paused" }),
    ).toBeInstanceOf(TransientDeliveryError);
  });

  it("stops on a rejected token and on an invalid address", () => {
    expect(classifyPostmarkError(401, null)).toBeInstanceOf(PermanentDeliveryError);
    expect(
      classifyPostmarkError(422, { ErrorCode: 300, Message: "Invalid email" }),
    ).toBeInstanceOf(PermanentDeliveryError);
  });
});

describe("the retry schedule", () => {
  it("grows, and stays inside the cap", () => {
    const mid = (n: number) => retryDelayMs(n, () => 0.5);
    expect(mid(1)).toBeLessThan(mid(2));
    expect(mid(2)).toBeLessThan(mid(3));
    expect(retryDelayMs(20, () => 1)).toBeLessThanOrEqual(6 * 3600_000);
  });

  it("jitters, because an outage releases every message at once", () => {
    // Without jitter every deferred message comes back at the same instant and
    // knocks the provider over again the moment it recovers.
    const low = retryDelayMs(3, () => 0);
    const high = retryDelayMs(3, () => 1);
    expect(low).toBeLessThan(high);
    // Never effectively immediate.
    expect(low).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

const HARD_BOUNCE = [
  "From: Mail Delivery Subsystem <MAILER-DAEMON@mx.example.com>",
  "Subject: Undeliverable: Re: VPN keeps dropping [NG-1a2b3c4d]",
  "Message-ID: <dsn-99@mx.example.com>",
  'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/plain",
  "",
  "Your message could not be delivered.",
  "",
  "--b1",
  "Content-Type: message/delivery-status",
  "",
  "Reporting-MTA: dns; mx.example.com",
  "Final-Recipient: rfc822; alice@example.com",
  "Action: failed",
  "Status: 5.1.1",
  "Diagnostic-Code: smtp; 550 5.1.1 <alice@example.com>: Recipient address",
  " rejected: User unknown in local recipient table",
  "",
  "--b1",
  "Content-Type: message/rfc822",
  "",
  "Message-ID: <ours-1234@acme.test>",
  "Subject: Re: VPN keeps dropping [NG-1a2b3c4d]",
  "",
  "--b1--",
].join("\r\n");

describe("reading a bounce", () => {
  it("names the address, the status and which of our messages it was about", () => {
    const parsed = parseDeliveryStatus(HARD_BOUNCE)!;
    expect(parsed.kind).toBe("hard");
    expect(parsed.recipient).toBe("alice@example.com");
    expect(parsed.status).toBe("5.1.1");
    // The DSN's own Message-ID appears first in the file; the one we want is
    // the original, attached below. Reading the wrong one matches nothing.
    expect(parsed.originalMessageId).toBe("ours-1234@acme.test");
  });

  it("unfolds the diagnostic, so the reason is not cut in half", () => {
    const parsed = parseDeliveryStatus(HARD_BOUNCE)!;
    expect(parsed.diagnostic).toContain("User unknown in local recipient table");
  });

  it("treats a delay notice as soft, because the mail is still in flight", () => {
    const delayed = HARD_BOUNCE.replace("Action: failed", "Action: delayed").replace(
      "Status: 5.1.1",
      "Status: 4.4.7",
    );
    const parsed = parseDeliveryStatus(delayed)!;
    expect(parsed.kind).toBe("soft");
  });

  it("reads a spam complaint as a complaint", () => {
    const arf = [
      "From: staff@mailprovider.test",
      "Subject: Abuse report",
      'Content-Type: multipart/report; report-type=feedback-report; boundary="c"',
      "",
      "--c",
      "Content-Type: message/feedback-report",
      "",
      "Feedback-Type: abuse",
      "User-Agent: SomeGenerator/1.0",
      "Original-Rcpt-To: bob@example.com",
      "",
      "--c",
      "Content-Type: message/rfc822",
      "",
      "Message-ID: <ours-5678@acme.test>",
      "",
      "--c--",
    ].join("\r\n");

    const parsed = parseDeliveryStatus(arf)!;
    expect(parsed.kind).toBe("complaint");
    expect(parsed.recipient).toBe("bob@example.com");
    expect(parsed.originalMessageId).toBe("ours-5678@acme.test");
  });

  it("says nothing about ordinary mail", () => {
    expect(
      parseDeliveryStatus("From: alice@example.com\r\nSubject: help\r\n\r\nMy VPN is down."),
    ).toBeNull();
  });

  /**
   * The one that matters for authorization rather than for parsing.
   *
   * A requester can type DSN fields into a support request. If that were enough
   * to be read as a bounce, anybody who can open a ticket could suppress
   * anybody else's address by describing a failure that never happened.
   */
  it("refuses to believe a requester who describes a bounce", () => {
    const pasted = [
      "From: mallory@example.com",
      "Subject: my mail is not arriving",
      "",
      "I keep seeing this:",
      "Final-Recipient: rfc822; ceo@example.com",
      "Action: failed",
      "Status: 5.1.1",
    ].join("\r\n");

    expect(parseDeliveryStatus(pasted, { from: "mallory@example.com", subject: "my mail is not arriving" })).toBeNull();
  });

  it("believes the same fields when the envelope is a mail server's", () => {
    const fromDaemon = [
      "Final-Recipient: rfc822; ceo@example.com",
      "Action: failed",
      "Status: 5.1.1",
    ].join("\r\n");

    const parsed = parseDeliveryStatus(fromDaemon, {
      from: "MAILER-DAEMON@mx.example.com",
      subject: "Undeliverable: quarterly report",
    });
    expect(parsed?.kind).toBe("hard");
    expect(parsed?.recipient).toBe("ceo@example.com");
  });

  it("recognises the envelopes mail servers actually use", () => {
    expect(looksLikeMailerReport({ from: "mailer-daemon@x.test" })).toBe(true);
    expect(looksLikeMailerReport({ from: "postmaster@x.test" })).toBe(true);
    expect(looksLikeMailerReport({ from: "<>" })).toBe(true);
    expect(looksLikeMailerReport({ subject: "Returned mail: see transcript" })).toBe(true);
    expect(looksLikeMailerReport({ from: "alice@example.com", subject: "vpn down" })).toBe(
      false,
    );
  });
});
