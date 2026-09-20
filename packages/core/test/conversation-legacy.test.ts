import { describe, expect, it } from "vitest";
import {
  legacyEventKey,
  legacyReferences,
  legacyThread,
  openingKey,
  planLegacyThread,
  type KnownIds,
  type LegacyEvent,
  type LegacyTicket,
} from "../src/conversation-legacy.js";

/**
 * What a ticket's history from before the conversation becomes in it (D4 and
 * C13 in docs/conversation.md). No database: `planLegacyThread` is pure, and
 * every rule about what the record means is decided here.
 *
 * The rule under test: a copy says what the record says and nothing more.
 * Where the record does not name an author the tenant can vouch for, the copy
 * is the system's.
 */

const TICKET = "11111111-1111-4111-8111-111111111111";
const REQUESTER = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";
const PERSON = "44444444-4444-4444-8444-444444444444";
const OUTSIDER = "55555555-5555-4555-8555-555555555555";
const OUTBOUND = "66666666-6666-4666-8666-666666666666";
const FOREIGN_OUTBOUND = "77777777-7777-4777-8777-777777777777";

const known: KnownIds = {
  requesters: new Set([REQUESTER]),
  staff: new Set([PERSON]),
  outbound: new Set([OUTBOUND]),
};

const ticket = (over: Partial<LegacyTicket> = {}): LegacyTicket => ({
  id: TICKET,
  source: "email",
  source_message_id: "first@mail.test",
  requester_id: REQUESTER,
  body: "The VPN drops every ten minutes.",
  attachments: [{ filename: "log.txt", content_type: "text/plain", size_bytes: 120, storage_key: null }],
  secrets_scrubbed: false,
  created_at: "2026-09-10 09:00:00.123456+00",
  ...over,
});

let nextId = 100;
const event = (over: Partial<LegacyEvent> & Pick<LegacyEvent, "kind">): LegacyEvent => ({
  id: nextId++,
  actor: "agent",
  payload: {},
  model: null,
  created_at: "2026-09-10 10:00:00.5+00",
  ...over,
});

describe("the opening message", () => {
  it("C13 is the ticket row, in the requester's words, keyed as intake keys it", () => {
    const plan = planLegacyThread(ticket(), [], known);
    expect(plan.problem).toBeNull();
    expect(plan.messages).toHaveLength(1);
    expect(plan.messages[0]).toMatchObject({
      idempotencyKey: openingKey(TICKET),
      kind: "message",
      visibility: "public",
      author: { kind: "requester", requesterId: REQUESTER, userId: null },
      channel: "email",
      body: "The VPN drops every ten minutes.",
      sourceMessageId: "first@mail.test",
      occurredAt: "2026-09-10 09:00:00.123456+00",
      legacy: { from: "ticket", event_id: null, actor: null, inbound: true },
    });
    expect(plan.messages[0]!.attachments).toEqual([
      { filename: "log.txt", contentType: "text/plain", sizeBytes: 120, storageKey: null },
    ]);
  });

  it("C13 is the system's, on the requester's side, when the requester is not this tenant's", () => {
    const plan = planLegacyThread(ticket({ requester_id: STRANGER }), [], known);
    expect(plan.messages[0]).toMatchObject({
      author: { kind: "system", requesterId: null },
      // Only a requester's message has a channel id of its own (0019).
      sourceMessageId: null,
      legacy: { inbound: true },
    });
  });

  it("C11 C13 is scrubbed again, and says so", () => {
    const plan = planLegacyThread(ticket({ body: "my password is hunter22" }), [], known);
    expect(plan.messages[0]!.body).not.toContain("hunter22");
    expect(plan.messages[0]!.secretsScrubbed).toBe(true);
  });

  it("C13 refuses a ticket whose source is not a channel, rather than guess one", () => {
    const plan = planLegacyThread(ticket({ source: "fax" }), [], known);
    expect(plan.messages).toEqual([]);
    expect(plan.problem).toMatch(/not a channel/);
  });
});

describe("replies", () => {
  it("C13 copies the requester's reply with the channel and the requester the event recorded", () => {
    const e = event({
      kind: "reply",
      actor: "user",
      payload: {
        body: "Still dropping.",
        inbound: true,
        source: "email",
        source_message_id: "second@mail.test",
        requester_id: REQUESTER,
      },
    });
    const [, copy] = planLegacyThread(ticket(), [e], known).messages;
    expect(copy).toMatchObject({
      idempotencyKey: legacyEventKey(e.id),
      visibility: "public",
      author: { kind: "requester", requesterId: REQUESTER },
      channel: "email",
      sourceMessageId: "second@mail.test",
      occurredAt: e.created_at,
      legacy: { from: "reply", event_id: e.id, actor: "user", inbound: true },
    });
  });

  it("C13 refuses an inbound reply that does not say how it arrived", () => {
    const e = event({ kind: "reply", actor: "user", payload: { body: "Hello?", inbound: true } });
    const plan = planLegacyThread(ticket(), [e], known);
    expect(plan.messages).toEqual([]);
    expect(plan.problem).toMatch(/does not record a channel/);
  });

  it("C13 names a person only when the actor is a member of this tenant", () => {
    const mine = event({ kind: "reply", actor: `human:${PERSON}`, payload: { body: "Try this." } });
    const theirs = event({ kind: "reply", actor: `human:${OUTSIDER}`, payload: { body: "Or this." } });
    const constant = event({ kind: "reply", actor: "human:console", payload: { body: "Or that." } });
    const [, a, b, c] = planLegacyThread(ticket(), [mine, theirs, constant], known).messages;
    expect(a!.author).toEqual({ kind: "staff", userId: PERSON, requesterId: null });
    expect(b!.author.kind).toBe("system");
    expect(c!.author.kind).toBe("system");
    for (const m of [a!, b!, c!]) {
      expect(m).toMatchObject({ visibility: "public", channel: "email", legacy: { inbound: false } });
    }
  });

  it("C6 C13 copies the agent's reply as the system's, because the event named no model", () => {
    const e = event({
      kind: "reply",
      actor: "agent",
      model: null,
      payload: { body: "Reset it at the portal.", outbound_id: OUTBOUND },
    });
    const [, copy] = planLegacyThread(ticket(), [e], known).messages;
    expect(copy).toMatchObject({ author: { kind: "system" }, aiModel: null, outboundId: OUTBOUND });
  });

  it("C3 C13 links a delivery only when the row is this tenant's", () => {
    const e = event({ kind: "reply", actor: "agent", payload: { body: "x", outbound_id: FOREIGN_OUTBOUND } });
    const [, copy] = planLegacyThread(ticket(), [e], known).messages;
    expect(copy!.outboundId).toBeNull();
  });

  it("C8 C13 copies one message for a send recorded twice", () => {
    const first = event({ kind: "reply", payload: { body: "Same words.", outbound_id: OUTBOUND } });
    const retry = event({
      kind: "reply",
      payload: { body: "Same words.", outbound_id: OUTBOUND, duplicate: true },
    });
    const plan = planLegacyThread(ticket(), [first, retry], known);
    expect(plan.messages).toHaveLength(2);
    expect(plan.skipped).toEqual([{ event_id: retry.id, reason: "same_delivery" }]);
  });
});

describe("drafts", () => {
  it("C6 C13 copies the agent's draft with the model the event recorded, and no prompt or config", () => {
    const sources = [{ title: "VPN runbook", url: null, score: 0.8 }];
    const e = event({
      kind: "draft",
      actor: "agent",
      model: "claude-sonnet-5",
      payload: { body: "Reinstall the client.", kind: "reply", sources },
    });
    const [, copy] = planLegacyThread(ticket(), [e], known).messages;
    expect(copy).toMatchObject({
      kind: "draft",
      visibility: "internal",
      channel: "internal",
      author: { kind: "ai" },
      aiModel: "claude-sonnet-5",
      aiSources: sources,
      legacy: { from: "draft", event_id: e.id, inbound: false },
    });
  });

  it("C6 C13 copies a draft with no recorded model as the system's, with no provenance", () => {
    const e = event({ kind: "draft", actor: "agent", model: null, payload: { body: "We are on it." } });
    const [, copy] = planLegacyThread(ticket(), [e], known).messages;
    expect(copy).toMatchObject({ author: { kind: "system" }, aiModel: null, aiSources: null });
  });
});

describe("what is not copied", () => {
  it("C13 leaves out merge copies, events without words, and everything that is not a reply or a draft", () => {
    const merged = event({ kind: "reply", payload: { body: "Copied by a merge.", merged_from: "x" } });
    const empty = event({ kind: "reply", payload: {} });
    const note = event({ kind: "note", payload: { body: "not a message" } });
    const plan = planLegacyThread(ticket(), [merged, empty, note], known);
    expect(plan.messages.map((m) => m.legacy.from)).toEqual(["ticket"]);
    expect(plan.skipped).toEqual([
      { event_id: merged.id, reason: "merged_copy" },
      { event_id: empty.id, reason: "no_body" },
    ]);
  });
});

describe("legacyReferences", () => {
  it("C3 collects only well-formed ids for the caller to check against the tenant", () => {
    const refs = legacyReferences(ticket(), [
      event({ kind: "reply", actor: `human:${PERSON}`, payload: { requester_id: STRANGER, outbound_id: OUTBOUND } }),
      event({ kind: "reply", actor: "human:console", payload: { requester_id: "not-a-uuid" } }),
    ]);
    expect(refs.requesters.sort()).toEqual([REQUESTER, STRANGER].sort());
    expect(refs.users).toEqual([PERSON]);
    expect(refs.outbound).toEqual([OUTBOUND]);
  });
});

describe("legacyThread", () => {
  it("reads the thread the portal showed from the event log: replies with words, by side", () => {
    const entries = legacyThread([
      { id: 1, kind: "reply", payload: { body: "Hi", inbound: true }, created_at: new Date(1) },
      { id: 2, kind: "draft", payload: { body: "never sent" }, created_at: new Date(2) },
      { id: 3, kind: "reply", payload: { body: "Hello" }, created_at: new Date(3) },
    ]);
    expect(entries.map((e) => [e.event_id, e.from, e.body])).toEqual([
      [1, "requester", "Hi"],
      [3, "desk", "Hello"],
    ]);
  });
});
