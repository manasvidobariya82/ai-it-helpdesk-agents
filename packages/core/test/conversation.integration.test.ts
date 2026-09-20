import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as core from "../src/index.js";

/**
 * The ticket conversation, through a real database. docs/conversation.md is
 * the specification, and each test carries the ID of the invariant it pins.
 *
 * Several rules are enforced twice: by `appendMessage`, which knows who is
 * asking, and by the database, which does not care. The database half is
 * tested with `rawCopy`, which writes a row the repository never would, so a
 * rule that only held because the repository was polite would fail here.
 *
 * Every ticket here comes through intake, so its conversation opens with the
 * requester's words at seq 1 (`OPENING`), and what a test writes starts at 2.
 *
 * Skips itself when no database is reachable: `npm run db:up && npm run
 * db:migrate`.
 */

/** The requester's opening message, which intake writes to every ticket. */
const OPENING = 1;

let available = true;
const businesses: string[] = [];
const users: string[] = [];

let businessId = "";
let system: core.TenantContext;
let agent: core.TenantContext;
let staff: core.TenantContext;
let viewer: core.TenantContext;
let portal: core.TenantContext;
let staffUserId = "";

/** A second tenant, for the rows that must not cross. */
let other: { businessId: string; system: core.TenantContext; ticketId: string; requesterId: string };

async function makeBusiness(label: string): Promise<string> {
  const row = await core.queryOne<{ id: string }>(
    `insert into businesses (name, type, settings) values ($1, 'it_services', '{}'::jsonb)
     returning id`,
    [`conversation-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`],
  );
  businesses.push(row!.id);
  return row!.id;
}

async function makeUser(business: string, role: core.Role): Promise<core.TenantContext> {
  const email = `conv-${role}-${randomUUID()}@example.test`;
  const id = await core.createUserUnaudited({
    email,
    fullName: `Conversation ${role}`,
    password: "correct horse battery staple",
  });
  users.push(id);
  await core.addMembershipUnaudited(id, business, role);
  return core.humanContext({ businessId: business, actorId: id, actorEmail: email, role });
}

/** A ticket from intake, and the requester who raised it. */
async function ticket(
  ctx: core.TenantContext = system,
  subject = "laptop will not start",
): Promise<{ id: string; requesterId: string }> {
  const intake = await core.intakeMessage(ctx, {
    source: "email",
    source_message_id: `conv-${randomUUID()}@example.test`,
    requester_email: `person-${randomUUID()}@acme.test`,
    requester_name: "Test Person",
    subject,
    body: "It will not turn on.",
    attachments: [],
    received_at: new Date(),
    meta: {},
  });
  return { id: intake.ticket.id, requesterId: intake.ticket.requester_id! };
}

/**
 * A ticket made the way tickets were made before the conversation: the row,
 * and nothing in the conversation. Its opening words are on the row only.
 */
async function bareTicket(ctx: core.TenantContext = system, body = "It will not turn on."): Promise<string> {
  const requester = await core.upsertRequester({
    business_id: ctx.businessId,
    email: `bare-${randomUUID()}@acme.test`,
    full_name: "Bare Person",
  });
  const { ticket } = await core.createTicketFromMessage(
    ctx,
    {
      source: "email",
      source_message_id: `bare-${randomUUID()}@example.test`,
      requester_email: requester.email,
      requester_name: requester.full_name,
      subject: "from before the conversation",
      body,
      attachments: [],
      received_at: new Date(),
      meta: {},
    },
    requester.id,
    null,
  );
  return ticket.id;
}

const key = () => `test:${randomUUID()}`;

/** A public note-free message from the desk, the most ordinary append there is. */
const reply = (body = "Hold the power button for ten seconds.") => ({
  visibility: "public" as const,
  channel: "console" as const,
  body,
  idempotencyKey: key(),
});

const AI = { model: "claude-sonnet-5", promptVersion: "reply-v7", configVersion: 12 };

async function messageRows(ticketId: string) {
  return core.query<{ id: string; seq: number; body: string }>(
    `select m.id, m.seq, m.body
       from conversation_messages m
       join conversations c on c.id = m.conversation_id
      where c.ticket_id = $1
      order by m.seq`,
    [ticketId],
  );
}

const messageEvents = async (ticketId: string) =>
  core.query<{ id: number; payload: Record<string, unknown> }>(
    `select id, payload from ticket_events where ticket_id = $1 and kind = 'message' order by id`,
    [ticketId],
  );

/** Columns `rawCopy` may override, with the type each parameter needs. */
const RAW_TYPES: Record<string, string> = {
  business_id: "uuid",
  conversation_id: "uuid",
  seq: "int",
  kind: "text",
  visibility: "text",
  author_kind: "text",
  author_user_id: "uuid",
  author_requester_id: "uuid",
  idempotency_key: "text",
  derived_from_id: "uuid",
  outbound_id: "uuid",
  ai_model: "text",
  ai_prompt_version: "text",
  about_event_id: "bigint",
};
const RAW_COLUMNS = [
  ...Object.keys(RAW_TYPES),
  "channel",
  "content_type",
  "body",
  "secrets_scrubbed",
  "source_message_id",
  "occurred_at",
  "event_id",
  "ai_config_version",
  "ai_sources",
  "metadata",
  "legacy",
];

/**
 * Insert a copy of an existing message with some columns changed, straight
 * into the table. The repository would never write most of these rows, so
 * this is how a test asks whether the database refuses them on its own.
 */
async function rawCopy(id: string, overrides: Record<string, unknown>): Promise<void> {
  const set: Record<string, unknown> = {
    seq: 100_000 + Math.floor(Math.random() * 100_000),
    idempotency_key: key(),
    ...overrides,
  };
  const params: unknown[] = [id];
  const select = RAW_COLUMNS.map((c) => {
    if (!(c in set)) return c;
    params.push(set[c]);
    return `$${params.length}::${RAW_TYPES[c]}`;
  });
  await core.query(
    `insert into conversation_messages (${RAW_COLUMNS.join(", ")})
     select ${select.join(", ")} from conversation_messages where id = $1`,
    params,
  );
}

async function outboundRow(business: string, ticketId: string | null): Promise<string> {
  const row = await core.queryOne<{ id: string }>(
    `insert into outbound_messages
       (business_id, ticket_id, idempotency_key, to_email, from_email, subject, body, message_id)
     values ($1, $2, $3, 'person@acme.test', 'desk@acme.test', 'Re: laptop', 'body', $4)
     returning id`,
    [business, ticketId, key(), `${randomUUID()}@conv.test`],
  );
  return row!.id;
}

beforeAll(async () => {
  try {
    await core.query("select 1");
  } catch {
    available = false;
    return;
  }

  businessId = await makeBusiness("a");
  system = core.systemContext(businessId, { requestId: "conversation-test" });
  agent = core.agentContext(businessId);
  staff = await makeUser(businessId, "agent");
  staffUserId = staff.actorId!;
  viewer = await makeUser(businessId, "viewer");
  portal = core.portalContext(businessId);

  const otherId = await makeBusiness("b");
  const otherSystem = core.systemContext(otherId);
  const t = await ticket(otherSystem, "the other tenant's ticket");
  other = { businessId: otherId, system: otherSystem, ticketId: t.id, requesterId: t.requesterId };
}, 60_000);

afterAll(async () => {
  for (const id of businesses) await core.purgeBusinessUnaudited(id);
  // After the purge: a user who wrote a message cannot be deleted while the
  // message exists, which is the point of the foreign key.
  if (users.length) await core.query(`delete from users where id = any($1::uuid[])`, [users]);
  await core.closeQueues().catch(() => {});
  await core.closePool().catch(() => {});
});

function guard(): boolean {
  if (!available) console.warn("[conversation] no database reachable; skipping. npm run db:up");
  return !available;
}

// ---------------------------------------------------------------------------

describe("C4 authors come from the context", () => {
  it("C4 writes a person at the desk as staff, named by their session", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    const { message, created } = await core.appendMessage(staff, t.id, reply());
    expect(created).toBe(true);
    expect(message).toMatchObject({
      author_kind: "staff",
      author_user_id: staffUserId,
      author_requester_id: null,
      ai_model: null,
    });
  }, 60_000);

  it("C4 writes the agent as ai, and refuses the agent's words without a model", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    const { message } = await core.appendMessage(agent, t.id, { ...reply(), ai: AI });
    expect(message).toMatchObject({ author_kind: "ai", author_user_id: null, ai_model: AI.model });

    await expect(core.appendMessage(agent, t.id, reply())).rejects.toThrow(/name the model/);
  }, 60_000);

  it("C4 writes intake as system, or as the requester it names", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    const sys = await core.appendMessage(system, t.id, { ...reply(), channel: "internal" });
    expect(sys.message).toMatchObject({ author_kind: "system", author_requester_id: null });

    const req = await core.appendMessage(system, t.id, {
      ...reply("It still will not turn on."),
      channel: "email",
      requesterId: t.requesterId,
    });
    expect(req.message).toMatchObject({
      author_kind: "requester",
      author_requester_id: t.requesterId,
      author_user_id: null,
    });
  }, 60_000);

  it("C4 refuses every forgery", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    const asRequester = { ...reply(), requesterId: t.requesterId };

    // A person cannot put words in the requester's mouth, and neither can the
    // agent.
    await expect(core.appendMessage(staff, t.id, asRequester)).rejects.toThrow(
      core.AuthorizationError,
    );
    await expect(core.appendMessage(agent, t.id, { ...asRequester, ai: AI })).rejects.toThrow(
      core.AuthorizationError,
    );
    // Nobody but the agent carries a model's provenance.
    await expect(core.appendMessage(staff, t.id, { ...reply(), ai: AI })).rejects.toThrow(
      core.AuthorizationError,
    );
    await expect(core.appendMessage(system, t.id, { ...reply(), ai: AI })).rejects.toThrow(
      core.AuthorizationError,
    );
    // The portal writes for a requester and nothing else. Without one it
    // would be writing as the system, which needs `ticket:update`.
    await expect(core.appendMessage(portal, t.id, reply())).rejects.toThrow(
      core.AuthorizationError,
    );
    const viaPortal = await core.appendMessage(portal, t.id, {
      ...asRequester,
      channel: "portal",
    });
    expect(viaPortal.message.author_kind).toBe("requester");

    // A viewer reads and does not write.
    await expect(core.appendMessage(viewer, t.id, reply())).rejects.toThrow(
      core.AuthorizationError,
    );
    expect(await messageRows(t.id)).toHaveLength(OPENING + 1);
  }, 60_000);

  it("C4 C3 refuses a requester from another tenant, in the database", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    await expect(
      core.appendMessage(system, t.id, { ...reply(), channel: "email", requesterId: other.requesterId }),
    ).rejects.toThrow(/foreign key/);
    expect(await messageRows(t.id)).toHaveLength(OPENING);
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("C5 visibility", () => {
  it("C5 shows the portal public messages only, and the desk everything", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    await core.appendMessage(system, t.id, {
      ...reply("It will not turn on."),
      channel: "email",
      requesterId: t.requesterId,
    });
    await core.appendMessage(staff, t.id, {
      ...reply("Probably the battery. Checking stock."),
      visibility: "internal",
      channel: "internal",
    });
    await core.appendMessage(agent, t.id, {
      ...reply("Try holding the power button."),
      kind: "draft",
      visibility: "internal",
      channel: "internal",
      ai: AI,
    });
    await core.appendMessage(staff, t.id, reply("We are sending a replacement."));

    const desk = await core.messagesFor(viewer, t.id);
    expect(desk.map((m) => m.seq)).toEqual([OPENING, 2, 3, 4, 5]);

    const seen = await core.messagesFor(portal, t.id);
    expect(seen.map((m) => m.seq)).toEqual([OPENING, 2, 5]);
    expect(seen.every((m) => m.visibility === "public")).toBe(true);
  }, 60_000);

  it("C5 lets nobody write what they could not read back", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    await expect(
      core.appendMessage(portal, t.id, {
        ...reply(),
        visibility: "internal",
        requesterId: t.requesterId,
      }),
    ).rejects.toThrow(/ticket_internal:read/);
  }, 60_000);

  it("C5 has the database refuse an internal requester message and a public draft", async () => {
    if (guard()) return expect(available).toBe(false);
    // The system holds every permission, so only the database stands between
    // these rows and the table.
    const t = await ticket();
    await expect(
      core.appendMessage(system, t.id, {
        ...reply(),
        visibility: "internal",
        channel: "email",
        requesterId: t.requesterId,
      }),
    ).rejects.toThrow(/conversation_messages_requester_shape/);
    await expect(
      core.appendMessage(agent, t.id, { ...reply(), kind: "draft", ai: AI }),
    ).rejects.toThrow(/conversation_messages_draft_internal/);
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("C6 provenance", () => {
  it("C6 records what the agent wrote with, and a person sending its draft", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    const sources = [{ chunk_id: randomUUID(), doc: "Laptop will not power on" }];
    const draft = await core.appendMessage(agent, t.id, {
      kind: "draft",
      visibility: "internal",
      channel: "internal",
      body: "Hold the power button for ten seconds, then plug it in.",
      idempotencyKey: key(),
      ai: { ...AI, sources },
    });
    expect(draft.message).toMatchObject({
      ai_model: AI.model,
      ai_prompt_version: AI.promptVersion,
      ai_config_version: AI.configVersion,
      ai_sources: sources,
    });

    // A person edits it and sends it. The reply is theirs, and it says where
    // its words came from.
    const sent = await core.appendMessage(staff, t.id, {
      ...reply("Hold the power button for fifteen seconds, then plug it in."),
      derivedFromId: draft.message.id,
    });
    expect(sent.message).toMatchObject({
      author_kind: "staff",
      derived_from_id: draft.message.id,
      ai_model: null,
    });
  }, 60_000);

  it("C6 has the database refuse a message derived from another conversation", async () => {
    if (guard()) return expect(available).toBe(false);
    const first = await ticket();
    const second = await ticket();
    const elsewhere = await core.appendMessage(staff, first.id, reply());
    await expect(
      core.appendMessage(staff, second.id, { ...reply(), derivedFromId: elsewhere.message.id }),
    ).rejects.toThrow(/foreign key/);
  }, 60_000);

  it("C6 has the database refuse provenance on a row the agent did not write", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    const human = await core.appendMessage(staff, t.id, reply());
    const ai = await core.appendMessage(agent, t.id, { ...reply(), ai: AI });

    await expect(rawCopy(human.message.id, { ai_model: "a-model" })).rejects.toThrow(
      /conversation_messages_ai_provenance/,
    );
    await expect(rawCopy(human.message.id, { ai_prompt_version: "v1" })).rejects.toThrow(
      /conversation_messages_provenance_only_ai/,
    );
    await expect(rawCopy(ai.message.id, { ai_model: null })).rejects.toThrow(
      /conversation_messages_ai_provenance/,
    );
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("C3 one tenant, in the database", () => {
  it("C3 refuses a message in another tenant's conversation, requester or outbound row", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    const mine = await core.appendMessage(staff, t.id, reply());

    await expect(rawCopy(mine.message.id, { business_id: other.businessId })).rejects.toThrow(
      /foreign key/,
    );
    await expect(
      rawCopy(mine.message.id, {
        author_kind: "requester",
        author_user_id: null,
        author_requester_id: other.requesterId,
      }),
    ).rejects.toThrow(/foreign key/);

    const foreignOutbound = await outboundRow(other.businessId, other.ticketId);
    await expect(rawCopy(mine.message.id, { outbound_id: foreignOutbound })).rejects.toThrow(
      /foreign key/,
    );
  }, 60_000);

  it("C3 links a reply to its own tenant's delivery row", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    const outbound = await outboundRow(businessId, t.id);
    const { message } = await core.appendMessage(agent, t.id, {
      ...reply(),
      channel: "email",
      outboundId: outbound,
      ai: AI,
    });
    expect(message.outbound_id).toBe(outbound);

    // Only a public message from the desk goes out.
    await expect(
      core.appendMessage(staff, t.id, {
        ...reply(),
        visibility: "internal",
        channel: "internal",
        outboundId: outbound,
      }),
    ).rejects.toThrow(/conversation_messages_outbound_shape/);
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("C2 order", () => {
  it("C2 gives twenty concurrent appends the next twenty numbers", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => core.appendMessage(staff, t.id, reply(`message ${i}`))),
    );
    expect(results.map((r) => r.message.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => OPENING + i + 1),
    );
    const conversation = await core.conversationFor(viewer, t.id);
    expect(conversation!.last_seq).toBe(OPENING + 20);
  }, 60_000);

  it("C2 leaves no gap behind a failed append", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    await core.appendMessage(staff, t.id, reply());
    await expect(
      core.appendMessage(agent, t.id, { ...reply(), kind: "draft", ai: AI }),
    ).rejects.toThrow();
    const next = await core.appendMessage(staff, t.id, reply());
    expect(next.message.seq).toBe(OPENING + 2);
  }, 60_000);

  it("C2 orders by seq, not by when the channel says it happened", async () => {
    if (guard()) return expect(available).toBe(false);
    // An email dated yesterday that arrives after today's reply is still the
    // later message. Its Date header is kept, and decides nothing.
    const t = await ticket();
    await core.appendMessage(staff, t.id, reply("first"));
    const late = await core.appendMessage(system, t.id, {
      ...reply("second, dated yesterday"),
      channel: "email",
      requesterId: t.requesterId,
      occurredAt: new Date(Date.now() - 24 * 3_600_000),
    });
    expect(late.message.seq).toBe(OPENING + 2);
    expect((await core.messagesFor(viewer, t.id)).map((m) => m.body)).toEqual([
      "It will not turn on.",
      "first",
      "second, dated yesterday",
    ]);
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("C7 the audit log", () => {
  it("C7 writes one message event per append, pointing at the message", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    const { message } = await core.appendMessage(staff, t.id, {
      ...reply(),
      attachments: [{ filename: "photo.jpg" }],
    });

    const events = await messageEvents(t.id);
    expect(events).toHaveLength(OPENING + 1);
    const mine = events.at(-1)!;
    expect(message.event_id).toBe(mine.id);
    expect(mine.payload).toMatchObject({
      stage: "conversation",
      message_id: message.id,
      conversation_id: message.conversation_id,
      seq: OPENING + 1,
      kind: "message",
      visibility: "public",
      author_kind: "staff",
      attachments: 1,
    });
    // The words are stored once, in the message.
    expect(mine.payload).not.toHaveProperty("body");
  }, 60_000);

  it("C7 writes neither when the event cannot be written", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    const name = `conv_fail_${t.id.replace(/-/g, "")}`;
    await core.query(
      `create function ${name}() returns trigger language plpgsql as $$
       begin
         if new.ticket_id = '${t.id}' and new.kind = 'message' then
           raise exception 'injected message event failure';
         end if;
         return new;
       end $$`,
    );
    await core.query(
      `create trigger ${name} before insert on ticket_events for each row execute function ${name}()`,
    );
    try {
      await expect(core.appendMessage(staff, t.id, reply())).rejects.toThrow(
        /injected message event failure/,
      );
    } finally {
      await core.query(`drop trigger if exists ${name} on ticket_events`);
      await core.query(`drop function if exists ${name}()`);
    }
    expect(await messageRows(t.id)).toHaveLength(OPENING);
    expect((await core.conversationFor(viewer, t.id))!.last_seq).toBe(OPENING);

    // With the log writable again, the next message takes the next number.
    const { message } = await core.appendMessage(staff, t.id, reply());
    expect(message.seq).toBe(OPENING + 1);
  }, 60_000);

  it("C7 shows an audit event only when it belongs to the ticket", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    const ownEvent = await core.queryOne<{ id: number }>(
      `select id from ticket_events where ticket_id = $1 order by id limit 1`,
      [t.id],
    );
    const shown = await core.appendMessage(system, t.id, {
      kind: "event",
      visibility: "public",
      channel: "internal",
      body: "Your request was received.",
      idempotencyKey: key(),
      aboutEventId: ownEvent!.id,
    });
    expect(shown.message.about_event_id).toBe(ownEvent!.id);

    const foreignEvent = await core.queryOne<{ id: number }>(
      `select id from ticket_events where ticket_id = $1 order by id limit 1`,
      [other.ticketId],
    );
    await expect(
      core.appendMessage(system, t.id, {
        kind: "event",
        visibility: "public",
        channel: "internal",
        body: "Not ours.",
        idempotencyKey: key(),
        aboutEventId: foreignEvent!.id,
      }),
    ).rejects.toThrow(core.NotFoundError);
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("C8 idempotency", () => {
  it("C8 returns the original for a retry and writes nothing", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    const input = { ...reply(), attachments: [{ filename: "log.txt", sizeBytes: 120 }] };
    const first = await core.appendMessage(staff, t.id, input);
    const again = await core.appendMessage(staff, t.id, input);

    expect(again.created).toBe(false);
    expect(again.message.id).toBe(first.message.id);
    expect(again.message.attachments.map((a) => a.filename)).toEqual(["log.txt"]);
    expect(await messageRows(t.id)).toHaveLength(OPENING + 1);
    expect(await messageEvents(t.id)).toHaveLength(OPENING + 1);
  }, 60_000);

  it("C8 writes one message for concurrent retries", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    const input = reply();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => core.appendMessage(staff, t.id, input)),
    );
    expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await messageRows(t.id)).toHaveLength(OPENING + 1);
  }, 60_000);

  it("C8 refuses a key reused for a different message", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    const u = await ticket();
    const input = reply();
    await core.appendMessage(staff, t.id, input);

    await expect(
      core.appendMessage(staff, t.id, { ...input, body: "different words" }),
    ).rejects.toThrow(core.IdempotencyConflictError);
    await expect(core.appendMessage(staff, u.id, input)).rejects.toThrow(
      core.IdempotencyConflictError,
    );
    // Written by the agent instead of the person is a different message too.
    await expect(core.appendMessage(agent, t.id, { ...input, ai: AI })).rejects.toThrow(
      core.IdempotencyConflictError,
    );
    expect(await messageRows(u.id)).toHaveLength(OPENING);
  }, 60_000);

  it("C8 keeps each tenant's keys to itself", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    const input = reply();
    await core.appendMessage(staff, t.id, input);
    const theirs = await core.appendMessage(other.system, other.ticketId, input);
    expect(theirs.created).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("C9 attachments", () => {
  it("C9 stores attachments with their message and reads them back with it", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    await core.appendMessage(system, t.id, {
      ...reply("Photo of the screen attached."),
      channel: "email",
      requesterId: t.requesterId,
      attachments: [
        { filename: "screen.jpg", contentType: "image/jpeg", sizeBytes: 48_213 },
        { filename: "dxdiag.txt", contentType: "text/plain", sizeBytes: 9_102 },
      ],
    });
    await core.appendMessage(staff, t.id, {
      ...reply("Serial number is on the invoice."),
      visibility: "internal",
      channel: "internal",
      attachments: [{ filename: "invoice.pdf", contentType: "application/pdf" }],
    });

    // In the order they were attached. They share a timestamp and have random
    // ids, so this held only by luck until `position` was stored.
    const desk = (await core.messagesFor(viewer, t.id)).filter((m) => m.seq > OPENING);
    expect(desk.map((m) => m.attachments.map((a) => a.filename))).toEqual([
      ["screen.jpg", "dxdiag.txt"],
      ["invoice.pdf"],
    ]);
    expect(desk[0]!.attachments.map((a) => a.position)).toEqual([0, 1]);
    expect(desk[0]!.attachments[0]).toMatchObject({
      content_type: "image/jpeg",
      size_bytes: 48_213,
      storage_key: null,
      business_id: businessId,
    });

    // An internal note's attachment is as internal as the note.
    const seen = await core.messagesFor(portal, t.id);
    expect(seen.flatMap((m) => m.attachments.map((a) => a.filename))).toEqual([
      "screen.jpg",
      "dxdiag.txt",
    ]);
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("C1 append-only", () => {
  it("C1 refuses to change or remove a message or an attachment", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    const { message } = await core.appendMessage(staff, t.id, {
      ...reply(),
      attachments: [{ filename: "a.txt" }],
    });

    await expect(
      core.query(`update conversation_messages set body = 'rewritten' where id = $1`, [message.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      core.query(`delete from conversation_messages where id = $1`, [message.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      core.query(`update conversation_attachments set filename = 'b.txt' where message_id = $1`, [
        message.id,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      core.query(`delete from conversation_attachments where message_id = $1`, [message.id]),
    ).rejects.toThrow(/append-only/);
    expect((await core.messagesFor(viewer, t.id)).find((m) => m.id === message.id)!.body).toBe(
      message.body,
    );
  }, 60_000);

  it("C1 refuses to delete a requester who wrote a message", async () => {
    if (guard()) return expect(available).toBe(false);
    // Erasing a person is a designed operation that does not exist yet. Until
    // it does, the delete stops at the append-only guard rather than taking
    // their messages with it.
    const t = await ticket();
    await core.appendMessage(system, t.id, {
      ...reply(),
      channel: "email",
      requesterId: t.requesterId,
    });
    await expect(
      core.query(`delete from requesters where id = $1`, [t.requesterId]),
    ).rejects.toThrow(/append-only/);
  }, 60_000);

  it("C1 lets a whole tenant be purged, whatever its messages point at", async () => {
    if (guard()) return expect(available).toBe(false);
    // Every reference a message holds is deleted in the same purge: the
    // requester, the delivery row, the audit events, the draft it came from.
    // Postgres picks the order, and none of them may stop it.
    const gone = await makeBusiness("purged");
    const sys = core.systemContext(gone);
    const t = await ticket(sys);
    await core.appendMessage(sys, t.id, {
      ...reply(),
      channel: "email",
      requesterId: t.requesterId,
      attachments: [{ filename: "x.txt" }],
    });
    const draft = await core.appendMessage(core.agentContext(gone), t.id, {
      ...reply(),
      kind: "draft",
      visibility: "internal",
      channel: "internal",
      ai: AI,
    });
    await core.appendMessage(core.agentContext(gone), t.id, {
      ...reply(),
      channel: "email",
      outboundId: await outboundRow(gone, t.id),
      derivedFromId: draft.message.id,
      ai: AI,
    });

    await core.purgeBusinessUnaudited(gone);
    const left = await core.queryOne<{ n: number }>(
      `select (select count(*) from conversation_messages where business_id = $1)
            + (select count(*) from conversation_attachments where business_id = $1)
            + (select count(*) from conversations where business_id = $1) as n`,
      [gone],
    );
    expect(Number(left!.n)).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("C10 locked conversations", () => {
  it("C10 locks the conversation of a merged ticket, and keeps what it had", async () => {
    if (guard()) return expect(available).toBe(false);
    const source = await ticket();
    const target = await ticket();
    const before = await core.appendMessage(staff, source.id, reply("before the merge"));

    await core.mergeTicket(system, source.id, target.id);

    const conversation = await core.conversationFor(viewer, source.id);
    expect(conversation).toMatchObject({ status: "locked", locked_reason: "merged" });
    await expect(core.appendMessage(staff, source.id, reply())).rejects.toThrow(
      core.ConversationLockedError,
    );
    // A retry of a message written before the lock still gets its answer.
    const retry = await core.appendMessage(staff, source.id, {
      ...reply("before the merge"),
      idempotencyKey: before.message.idempotency_key,
    });
    expect(retry).toMatchObject({ created: false, message: { id: before.message.id } });
    expect((await core.messagesFor(viewer, source.id)).map((m) => m.body)).toEqual([
      "It will not turn on.",
      "before the merge",
    ]);
    // The surviving ticket's conversation is untouched.
    expect((await core.appendMessage(staff, target.id, reply())).created).toBe(true);
  }, 60_000);

  it("C10 locks a merged ticket that had no conversation yet", async () => {
    if (guard()) return expect(available).toBe(false);
    const source = await ticket();
    const target = await ticket();
    await core.mergeTicket(system, source.id, target.id);
    expect(await core.conversationFor(viewer, source.id)).toMatchObject({ status: "locked" });
    await expect(core.appendMessage(staff, source.id, reply())).rejects.toThrow(
      core.ConversationLockedError,
    );
  }, 60_000);

  it("C10 refuses a ticket merged before conversations existed, and opens nothing", async () => {
    if (guard()) return expect(available).toBe(false);
    const source = await bareTicket();
    const target = await ticket();
    // What a merge before 0019 left behind: the pointer, and no conversation.
    await core.query(`update tickets set merged_into_id = $2, status = 'closed' where id = $1`, [
      source,
      target.id,
    ]);
    await expect(core.appendMessage(staff, source, reply())).rejects.toThrow(
      core.ConversationLockedError,
    );
    expect(await core.conversationFor(viewer, source)).toBeNull();
  }, 60_000);

  it("C10 refuses a merged ticket's first write without copying its history into an open conversation", async () => {
    if (guard()) return expect(available).toBe(false);
    // The copy on first write (D4) runs after the lock is checked, so a merged
    // ticket from before the conversation is left to the backfill, which opens
    // its conversation locked.
    const source = await bareTicket();
    const target = await ticket();
    await core.query(`update tickets set merged_into_id = $2, status = 'closed' where id = $1`, [
      source,
      target.id,
    ]);
    await expect(core.appendMessage(system, source, { ...reply(), channel: "internal" })).rejects.toThrow(
      core.ConversationLockedError,
    );
    const result = await core.backfillConversation(system, source);
    expect(result).toMatchObject({ written: OPENING, refused: null });
    expect(await core.conversationFor(viewer, source)).toMatchObject({
      status: "locked",
      locked_reason: "merged",
    });
  }, 60_000);

  it("C10 lets the lock win a race with a first append", async () => {
    if (guard()) return expect(available).toBe(false);
    // Whichever commits first, the other sees it: the append lands before the
    // lock, or is refused after it. Never an open conversation on a merged
    // ticket, and never a message after the lock.
    for (let i = 0; i < 5; i++) {
      const source = await ticket();
      const target = await ticket();
      const [appended] = await Promise.allSettled([
        core.appendMessage(staff, source.id, reply()),
        core.mergeTicket(system, source.id, target.id),
      ]);
      const conversation = await core.conversationFor(viewer, source.id);
      expect(conversation!.status).toBe("locked");
      const rows = await messageRows(source.id);
      if (appended.status === "fulfilled") {
        expect(rows).toHaveLength(OPENING + 1);
      } else {
        expect(appended.reason).toBeInstanceOf(core.ConversationLockedError);
        expect(rows).toHaveLength(OPENING);
      }
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("C11 secrets", () => {
  it("C11 masks a password in a requester's message before it is stored", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    const { message } = await core.appendMessage(system, t.id, {
      ...reply("I tried again, my password is hunter22 and it still fails."),
      channel: "email",
      requesterId: t.requesterId,
    });
    expect(message.body).not.toContain("hunter22");
    expect(message.body).toContain("[redacted:secret]");
    expect(message.secrets_scrubbed).toBe(true);
    const stored = await messageRows(t.id);
    expect(stored[0]!.body).not.toContain("hunter22");
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("C12 derived state", () => {
  it("C12 keeps last_seq equal to the messages written, and derives the rest", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    await core.appendMessage(system, t.id, {
      ...reply("Still broken."),
      channel: "email",
      requesterId: t.requesterId,
    });
    await core.appendMessage(staff, t.id, {
      ...reply("Looking now."),
      visibility: "internal",
      channel: "internal",
    });

    const conversation = await core.conversationFor(viewer, t.id);
    const messages = await core.messagesFor(viewer, t.id);
    expect(conversation!.last_seq).toBe(messages.length);
    expect(conversation!.last_message_at).not.toBeNull();
    expect(core.conversationState(messages)).toMatchObject({
      messages: OPENING + 2,
      public: OPENING + 1,
      internal: 1,
      awaiting: "desk",
      lastPublicAuthor: "requester",
    });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// D4: the history from before the conversation, copied into it.
// ---------------------------------------------------------------------------

/** Move a ticket's creation into the past, so its history can come after it. */
async function backdate(ticketId: string, minutes: number): Promise<void> {
  await core.query(
    `update tickets set created_at = now() - ($2 || ' minutes')::interval where id = $1`,
    [ticketId, String(minutes)],
  );
}

/**
 * A `reply` or `draft` event as the event log recorded them before the
 * conversation, `minutesAgo` in the past. `appendEvent` refuses both kinds
 * now, so the test writes the row itself.
 */
async function legacyEvent(
  ticketId: string,
  kind: "reply" | "draft",
  actor: string,
  payload: Record<string, unknown>,
  opts: { model?: string | null; minutesAgo: number },
): Promise<number> {
  const row = await core.queryOne<{ id: number }>(
    `insert into ticket_events (ticket_id, actor, kind, payload, model, created_at)
     values ($1, $2, $3, $4::jsonb, $5, now() - ($6 || ' minutes')::interval)
     returning id`,
    [ticketId, actor, kind, JSON.stringify(payload), opts.model ?? null, String(opts.minutesAgo)],
  );
  return row!.id;
}

/**
 * A ticket from before the conversation with a history: the opening words on
 * the row, the requester's reply, a person's reply that went out, and a draft
 * the agent parked.
 */
async function ticketWithHistory() {
  const id = await bareTicket();
  await backdate(id, 120);
  const requesterId = (await core.getTicket(system, id))!.requester_id!;
  const outbound = await outboundRow(businessId, id);
  const inbound = await legacyEvent(
    id,
    "reply",
    "user",
    {
      body: "Still dropping.",
      inbound: true,
      source: "email",
      source_message_id: `legacy-${randomUUID()}@mail.test`,
      requester_id: requesterId,
    },
    { minutesAgo: 90 },
  );
  const desk = await legacyEvent(
    id,
    "reply",
    `human:${staffUserId}`,
    { body: "Reinstall the client.", outbound_id: outbound },
    { minutesAgo: 60 },
  );
  const draft = await legacyEvent(
    id,
    "draft",
    "agent",
    { body: "Try the portal.", kind: "reply", sources: [{ title: "VPN", url: null, score: 0.8 }] },
    { model: "claude-sonnet-5", minutesAgo: 30 },
  );
  return { id, requesterId, outbound, inbound, desk, draft };
}

describe("D4 the history from before the conversation", () => {
  it("C13 copies a ticket's history as its record says it", async () => {
    if (guard()) return expect(available).toBe(false);
    const h = await ticketWithHistory();

    const result = await core.backfillConversation(system, h.id);
    expect(result).toMatchObject({ written: 4, present: 0, skipped: [], refused: null });

    const thread = await core.threadFor(viewer, h.id);
    expect(thread.map((m) => [m.seq, m.kind, m.author_kind, m.from])).toEqual([
      [1, "message", "requester", "requester"],
      [2, "message", "requester", "requester"],
      [3, "message", "staff", "desk"],
      [4, "draft", "ai", "desk"],
    ]);
    expect(thread[2]).toMatchObject({
      author_user_id: staffUserId,
      outbound_id: h.outbound,
      channel: "email",
      legacy: { from: "reply", event_id: h.desk, actor: `human:${staffUserId}`, inbound: false },
    });
    expect(thread[3]).toMatchObject({
      ai_model: "claude-sonnet-5",
      ai_prompt_version: null,
      ai_config_version: null,
      legacy: { from: "draft", event_id: h.draft },
    });

    // Each copy is when its record says, not when it was copied.
    const events = await core.eventsFor(system, h.id);
    const at = (eventId: number) =>
      new Date(events.find((e) => e.id === eventId)!.created_at).getTime();
    expect(thread[1]!.at.getTime()).toBe(at(h.inbound));
    expect(thread[2]!.at.getTime()).toBe(at(h.desk));

    // The system made the copies, and the log says they are copies (C7).
    const copies = events.filter((e) => e.kind === "message");
    expect(copies).toHaveLength(4);
    expect(copies.every((e) => e.actor === "system" && e.payload.legacy)).toBe(true);
  }, 60_000);

  it("C13 shows the portal what the portal showed before", async () => {
    if (guard()) return expect(available).toBe(false);
    // The parity check: the replies the portal read from the event log are the
    // replies it reads from the conversation now, same side, same words, same
    // time. The opening message is new to it, and the draft stays hidden.
    const h = await ticketWithHistory();
    await core.backfillConversation(system, h.id);

    const before = core.legacyThread(await core.eventsFor(system, h.id));
    const now = (await core.threadFor(portal, h.id)).filter((m) => m.legacy?.from === "reply");
    expect(now.map((m) => [m.from, m.body, m.at.getTime()])).toEqual(
      before.map((e) => [e.from, e.body, e.at.getTime()]),
    );
    expect((await core.threadFor(portal, h.id)).some((m) => m.kind === "draft")).toBe(false);
  }, 60_000);

  it("C8 C13 writes each copy once, however many runs and however concurrent", async () => {
    if (guard()) return expect(available).toBe(false);
    const h = await ticketWithHistory();

    const runs = await Promise.all([1, 2, 3].map(() => core.backfillConversation(system, h.id)));
    expect(runs.reduce((n, r) => n + r.written, 0)).toBe(4);
    expect(await messageRows(h.id)).toHaveLength(4);

    const again = await core.backfillConversation(system, h.id);
    expect(again).toMatchObject({ written: 0, present: 4, refused: null });
  }, 60_000);

  it("C13 writes nothing in a dry run, and says what a run would write", async () => {
    if (guard()) return expect(available).toBe(false);
    const h = await ticketWithHistory();
    const dry = await core.backfillConversation(system, h.id, { dryRun: true });
    expect(dry).toMatchObject({ written: 4, present: 0, refused: null, dryRun: true });
    expect(await core.conversationFor(viewer, h.id)).toBeNull();
  }, 60_000);

  it("C2 C13 refuses to copy a record after anything later, and writes nothing", async () => {
    if (guard()) return expect(available).toBe(false);
    // An old writer recorded a reply after the conversation already had newer
    // words, which is a deploy with both versions running. Copying it now
    // would put it after what came after it.
    const id = await bareTicket();
    await backdate(id, 120);
    await core.appendMessage(staff, id, reply("Written through the conversation."));
    const before = await messageRows(id);
    await legacyEvent(id, "reply", "agent", { body: "Late record." }, { minutesAgo: 10 });

    const result = await core.backfillConversation(system, id);
    expect(result.written).toBe(0);
    expect(result.refused).toMatch(/later than a legacy record/);
    expect(await messageRows(id)).toEqual(before);
  }, 60_000);

  it("C13 refuses a record missing what cannot be guessed, and leaves the ticket as it was", async () => {
    if (guard()) return expect(available).toBe(false);
    const id = await bareTicket();
    await backdate(id, 60);
    await legacyEvent(id, "reply", "user", { body: "How did I arrive?", inbound: true }, { minutesAgo: 30 });

    const result = await core.backfillConversation(system, id);
    expect(result.refused).toMatch(/does not record a channel/);
    // Not even an empty conversation is left behind.
    expect(await core.conversationFor(viewer, id)).toBeNull();
  }, 60_000);

  it("C3 C13 names nobody the tenant cannot vouch for", async () => {
    if (guard()) return expect(available).toBe(false);
    const id = await bareTicket();
    await backdate(id, 60);
    const outsiderUser = (await makeUser(other.businessId, "agent")).actorId!;
    await legacyEvent(
      id,
      "reply",
      "user",
      { body: "Spoofed.", inbound: true, source: "email", requester_id: other.requesterId },
      { minutesAgo: 40 },
    );
    await legacyEvent(id, "reply", `human:${outsiderUser}`, { body: "Not ours." }, { minutesAgo: 20 });

    await core.backfillConversation(system, id);
    const [, spoofed, outsider] = await core.threadFor(viewer, id);
    expect(spoofed).toMatchObject({ author_kind: "system", author_requester_id: null, from: "requester" });
    expect(outsider).toMatchObject({ author_kind: "system", author_user_id: null, from: "desk" });
  }, 60_000);

  it("C13 has the database refuse a copy under another key, or with provenance nothing recorded", async () => {
    if (guard()) return expect(available).toBe(false);
    const h = await ticketWithHistory();
    await core.backfillConversation(system, h.id);
    const thread = await core.threadFor(viewer, h.id);

    await expect(rawCopy(thread[2]!.id, { idempotency_key: key() })).rejects.toThrow(
      /conversation_messages_legacy_key/,
    );
    // Under its own key, so the key rule passes and only provenance is asked
    // about. Checks run before the unique index, so the duplicate key never
    // gets that far.
    await expect(
      rawCopy(thread[3]!.id, {
        idempotency_key: thread[3]!.idempotency_key,
        ai_prompt_version: "reply@v1",
      }),
    ).rejects.toThrow(/conversation_messages_legacy_provenance/);
  }, 60_000);
});

describe("D4 the first write copies the history before itself", () => {
  it("C2 C13 puts the history first, and leaves the backfill nothing to do", async () => {
    if (guard()) return expect(available).toBe(false);
    // A requester replies to an old ticket before anybody ran the backfill.
    // The backfill would refuse the ticket once the reply was in (C2), so the
    // reply's own write copies the history first.
    const h = await ticketWithHistory();
    const { message } = await core.appendMessage(system, h.id, {
      ...reply("Any news?"),
      channel: "email",
      requesterId: h.requesterId,
    });

    const thread = await core.threadFor(viewer, h.id);
    expect(thread.map((m) => m.body)).toEqual([
      "It will not turn on.",
      "Still dropping.",
      "Reinstall the client.",
      "Try the portal.",
      "Any news?",
    ]);
    expect(message.seq).toBe(5);
    expect(thread.slice(0, 4).every((m) => m.legacy !== null)).toBe(true);
    expect(await core.backfillConversation(system, h.id)).toMatchObject({
      written: 0,
      present: 4,
      refused: null,
    });
  }, 60_000);

  it("C13 still writes when the history cannot be copied, and the log says why", async () => {
    if (guard()) return expect(available).toBe(false);
    const id = await bareTicket();
    await backdate(id, 60);
    await legacyEvent(id, "reply", "user", { body: "No channel.", inbound: true }, { minutesAgo: 30 });

    const { message } = await core.appendMessage(staff, id, reply("Looking at it."));
    expect(message.seq).toBe(1);
    const notes = (await core.eventsFor(system, id)).filter(
      (e) => e.payload.stage === "conversation_history",
    );
    expect(notes).toHaveLength(1);
    expect(String(notes[0]!.payload.refused)).toMatch(/does not record a channel/);
  }, 60_000);

  it("C13 nothing writes a reply or a draft to the event log any more", async () => {
    if (guard()) return expect(available).toBe(false);
    const t = await ticket();
    for (const kind of ["reply", "draft"] as const) {
      await expect(
        core.appendEvent(system, { ticket_id: t.id, actor: "agent", kind, payload: { body: "x" } }),
      ).rejects.toThrow(/appendMessage/);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The writers.
// ---------------------------------------------------------------------------

describe("intake writes to the conversation", () => {
  it("opens a ticket's conversation with the requester's words and attachments", async () => {
    if (guard()) return expect(available).toBe(false);
    const sourceMessageId = `opening-${randomUUID()}@mail.test`;
    const intake = await core.intakeMessage(system, {
      source: "email",
      source_message_id: sourceMessageId,
      requester_email: `person-${randomUUID()}@acme.test`,
      requester_name: "Opening Person",
      subject: "screen flickers",
      body: "The screen flickers. My password is hunter22 if you need it.",
      attachments: [
        { filename: "video.mp4", content_type: "video/mp4", size_bytes: 1_000_000, storage_key: null },
      ],
      received_at: new Date(),
      meta: { mailbox: "support" },
    });
    const [opening] = await core.messagesFor(viewer, intake.ticket.id);
    expect(opening).toMatchObject({
      seq: 1,
      idempotency_key: core.openingKey(intake.ticket.id),
      author_kind: "requester",
      author_requester_id: intake.ticket.requester_id,
      channel: "email",
      source_message_id: sourceMessageId,
      metadata: { mailbox: "support" },
      legacy: null,
    });
    expect(opening!.body).not.toContain("hunter22");
    expect(opening!.attachments.map((a) => a.filename)).toEqual(["video.mp4"]);
    expect(await core.backfillConversation(system, intake.ticket.id)).toMatchObject({
      written: 0,
      present: 1,
    });
  }, 60_000);

  it("threads a reply into the conversation once, however often it is delivered", async () => {
    if (guard()) return expect(available).toBe(false);
    const first = `thread-${randomUUID()}@mail.test`;
    const email = `person-${randomUUID()}@acme.test`;
    const intake = await core.intakeMessage(system, {
      source: "email",
      source_message_id: first,
      requester_email: email,
      requester_name: null,
      subject: "printer jam",
      body: "Jammed again.",
      attachments: [],
      received_at: new Date(),
      meta: {},
    });
    await core.setStatus(system, intake.ticket.id, "awaiting_user");

    const replyMail = {
      source: "email" as const,
      source_message_id: `thread-reply-${randomUUID()}@mail.test`,
      requester_email: email,
      requester_name: null,
      subject: "Re: printer jam",
      body: "Here is a photo of the tray.",
      attachments: [
        { filename: "tray.jpg", content_type: "image/jpeg", size_bytes: 2048, storage_key: null },
      ],
      received_at: new Date(),
      meta: { in_reply_to: first },
    };
    const threaded = await core.intakeMessage(system, replyMail);
    expect(threaded).toMatchObject({ threaded: true, created: false });
    const again = await core.intakeMessage(system, replyMail);
    expect(again.threaded).toBe(true);

    const messages = await core.messagesFor(viewer, intake.ticket.id);
    expect(messages.map((m) => [m.seq, m.author_kind, m.body])).toEqual([
      [1, "requester", "Jammed again."],
      [2, "requester", "Here is a photo of the tray."],
    ]);
    // Attachments on a reply used to be dropped.
    expect(messages[1]!.attachments.map((a) => a.filename)).toEqual(["tray.jpg"]);
    expect(messages[1]!.idempotency_key).toBe(
      core.inboundKey("email", replyMail.source_message_id),
    );
    // The redelivery moved nothing: one resume, one status change.
    const resumes = (await core.eventsFor(system, intake.ticket.id)).filter(
      (e) => e.kind === "status_change" && e.payload.status === "triaged",
    );
    expect(resumes).toHaveLength(1);
  }, 60_000);
});
