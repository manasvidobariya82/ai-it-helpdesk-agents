import { describe, expect, it } from "vitest";
import { redactForModel, redactPayload, scrubSecrets } from "../src/redact.js";

describe("secret scrubbing", () => {
  it("masks a password stated in prose but keeps the sentence readable", () => {
    const r = scrubSecrets("I tried again, my password is Hunter2!Summer and it failed.");
    expect(r.text).toContain("password: [redacted:secret]");
    expect(r.text).not.toContain("Hunter2!Summer");
    expect(r.redacted).toBe(true);
  });

  it("masks the common label variants", () => {
    for (const line of [
      "pwd: correcthorse",
      "passcode = 884219",
      "My passphrase is opensesame",
      "otp is 449182",
    ]) {
      expect(scrubSecrets(line).text).toContain("[redacted:secret]");
    }
  });

  it("masks provider API keys and bearer tokens", () => {
    const r = scrubSecrets(
      "Deploy failed. Key sk-abcdefghijklmnopqrstuvwxyz123 and AKIAIOSFODNN7EXAMPLE are in the config.",
    );
    expect(r.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123");
    expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("masks a private key block whole", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----";
    expect(scrubSecrets(`Here it is:\n${key}`).text).toContain("[redacted:private-key]");
  });

  it("leaves ordinary tickets alone", () => {
    const text = "Outlook keeps asking me to sign in again after the update.";
    const r = scrubSecrets(text);
    expect(r.text).toBe(text);
    expect(r.redacted).toBe(false);
  });
});

describe("PII redaction for model calls", () => {
  it("redacts email addresses", () => {
    const r = redactForModel("Forward it to priya.shah@northgate.example please");
    expect(r.text).toContain("[redacted:email]");
    expect(r.hits.find((h) => h.kind === "email")?.count).toBe(1);
  });

  it("redacts a card number that passes Luhn", () => {
    const r = redactForModel("card 4111 1111 1111 1111 was declined");
    expect(r.text).toContain("[redacted:card]");
  });

  it("leaves a number that fails Luhn alone", () => {
    const r = redactForModel("order 1234 5678 9012 3456 is stuck");
    expect(r.text).toContain("1234 5678 9012 3456");
  });

  it("redacts phone numbers", () => {
    const r = redactForModel("Call me on +44 7700 900123 if that fails");
    expect(r.text).toContain("[redacted:phone]");
  });

  /**
   * The point of these: a redactor that eats the substance of an IT ticket has
   * made the model call useless. These are all things that look like PII to a
   * naive regex and are the actual content of a helpdesk request.
   */
  it("keeps the things an IT ticket is made of", () => {
    const text = [
      "Asset NG-LT-0114 on 192.168.1.42 (MAC 3C-A0-67-12-8B-9F)",
      "throws error 0x8007000E after KB5034123,",
      "Windows 11 23H2, build 22631.3155, since 2026-09-11.",
    ].join(" ");
    const r = redactForModel(text);
    expect(r.text).toContain("NG-LT-0114");
    expect(r.text).toContain("192.168.1.42");
    expect(r.text).toContain("0x8007000E");
    expect(r.text).toContain("KB5034123");
    expect(r.text).toContain("22631.3155");
  });

  it("applies secret rules before PII rules", () => {
    const r = redactForModel("my password is 447700900123");
    expect(r.text).toContain("[redacted:secret]");
    expect(r.text).not.toContain("[redacted:phone]");
  });
});

describe("payload redaction", () => {
  it("walks nested structures", () => {
    const out = redactPayload({
      body: "mail me at a.b@c.example",
      nested: { list: ["also d@e.example", 42], flag: true },
    });
    expect(JSON.stringify(out)).not.toContain("a.b@c.example");
    expect(JSON.stringify(out)).not.toContain("d@e.example");
    expect(out.nested.list[1]).toBe(42);
    expect(out.nested.flag).toBe(true);
  });
});
