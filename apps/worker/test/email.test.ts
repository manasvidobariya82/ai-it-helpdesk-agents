import { describe, expect, it } from "vitest";
import { normalizeEml, stripQuotedHistory } from "../src/intake/email.js";


function eml(headers: string, body: string): string {
  return `${headers.trim()}\nContent-Type: text/plain; charset=utf-8\n\n${body}`;
}

describe("stripQuotedHistory", () => {
  it("cuts at the Outlook original-message marker", () => {
    const out = stripQuotedHistory(
      "It is still broken.\n\n-----Original Message-----\nFrom: IT\nHave you tried",
    );
    expect(out).toBe("It is still broken.");
  });

  it("cuts at a Gmail-style attribution line", () => {
    const out = stripQuotedHistory(
      "Yes that fixed it, thanks.\n\nOn Mon, 1 Sep 2026 at 09:00, IT Support wrote:\n> Try restarting",
    );
    expect(out).toBe("Yes that fixed it, thanks.");
  });

  it("drops quote-prefixed lines that survive the cut", () => {
    expect(stripQuotedHistory("New text\n> old text\nmore new")).toBe("New text\nmore new");
  });

  it("leaves an unquoted message alone", () => {
    expect(stripQuotedHistory("Just one line.")).toBe("Just one line.");
  });
});

describe("normalizeEml", () => {
  it("extracts sender, subject and body", async () => {
    const msg = await normalizeEml(
      eml(
        `From: Priya Shah <Priya.Shah@Northgate.example>
To: helpdesk@northgate.example
Subject: Password expired
Message-ID: <abc-123@northgate.example>`,
        "I cannot sign in this morning.",
      ),
      {},
    );

    expect(msg).not.toBeNull();
    expect(msg!.requester_email).toBe("priya.shah@northgate.example");
    expect(msg!.requester_name).toBe("Priya Shah");
    expect(msg!.subject).toBe("Password expired");
    expect(msg!.body).toBe("I cannot sign in this morning.");
    expect(msg!.source_message_id).toContain("abc-123");
  });

  it("drops out-of-office replies before they become tickets", async () => {
    const msg = await normalizeEml(
      eml(
        `From: tom@northgate.example
Subject: Automatic reply: your ticket
Auto-Submitted: auto-replied
Message-ID: <ooo-1@northgate.example>`,
        "I am away until Thursday.",
      ),
      {},
    );
    expect(msg).toBeNull();
  });

  it("drops bulk mail", async () => {
    const msg = await normalizeEml(
      eml(
        `From: newsletter@vendor.example
Subject: September product update
Precedence: bulk
Message-ID: <bulk-1@vendor.example>`,
        "Read about our new features.",
      ),
      {},
    );
    expect(msg).toBeNull();
  });

  it("synthesises a stable id when the message has no Message-ID", async () => {
    const raw = eml(`From: dan@northgate.example\nSubject: laptop slow`, "its slow again");
    const a = await normalizeEml(raw, {});
    const b = await normalizeEml(raw, {});
    expect(a!.source_message_id).toBe(b!.source_message_id);
    expect(a!.source_message_id).toMatch(/^sha256:/);
  });

  it("keeps an empty body from producing an empty ticket", async () => {
    const msg = await normalizeEml(
      eml(`From: dan@northgate.example\nSubject: (no text)\nMessage-ID: <e1@x.example>`, ""),
      {},
    );
    expect(msg!.body).toBe("(empty message)");
  });
});
