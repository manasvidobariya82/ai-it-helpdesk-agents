import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration test against a real Postgres.
 *
 * The model is stubbed - what this exercises is every SQL statement the agent
 * path touches, which is where the bugs actually are: parameter type
 * inference, enum casts, the vector query, the append-only log. Skips itself
 * with a message rather than failing when no database is reachable.
 *
 *   npm run db:up && npm run db:migrate
 */

// The pipeline reads AGENT_MODE once, at import. Set it before core loads so
// the test exercises the auto-mode path rather than whatever .env happens to say.
process.env.AGENT_MODE = "auto";

const triageStub = vi.hoisted(() => ({
  value: {
    category: "access_identity",
    subcategory: "password expiry",
    priority: "P2",
    confidence: 0.97,
    is_security_sensitive: false,
    is_destructive_request: false,
    affected_system: "Entra ID",
    missing_info: [] as string[],
    duplicate_of_hint: null as string | null,
    reasoning: "Expired password with a documented self-service path.",
  },
}));

vi.mock("@hd/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hd/llm")>();
  return {
    ...actual,
    callStructured: vi.fn(async () => ({
      data: triageStub.value,
      model: "stub-model",
      tokensIn: 1200,
      tokensOut: 180,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.0042,
      latencyMs: 950,
      attempts: 1,
    })),
    callText: vi.fn(async () => ({
      text: "1. Go to the reset portal.\n2. Sign in with the new password.\n\n— Test Support",
      model: "stub-model",
      tokensIn: 800,
      tokensOut: 90,
      costUsd: 0.0018,
      latencyMs: 700,
    })),
  };
});

const core = await import("@hd/core");
const { ingestDocument } = await import("@hd/rag");
const { runPipeline } = await import("../src/pipeline.js");

const BASE_TRIAGE = { ...triageStub.value };

let businessId = "";
let tenant: import("@hd/core").TenantContext;
let available = true;

beforeEach(() => {
  triageStub.value = { ...BASE_TRIAGE };
});

const settings = {
  default_policy: { autonomy: "act", confidence_threshold: 0.9 },
  // Low on purpose: this test is about the pipeline, not about how well the
  // dev hash embedder scores.
  kb_support_floor: 0.1,
  auto_action_whitelist: ["identity.reset_password", "ticket.send_reply"],
  max_clarify_rounds: 1,
};

beforeAll(async () => {
  try {
    await core.query("select 1");
  } catch {
    available = false;
    return;
  }

  const row = await core.queryOne<{ id: string }>(
    `insert into businesses (name, type, settings) values ($1,$2,$3::jsonb) returning id`,
    [`test-${Date.now()}`, "it_services", JSON.stringify(settings)],
  );
  businessId = row!.id;
  // Everything below acts inside this one tenant. The isolation tests in
  // packages/core/test cover what happens when a second one is involved.
  tenant = core.systemContext(businessId, { requestId: "pipeline-test" });

  await ingestDocument(tenant, {
    title: "Password reset and expiry",
    content:
      "# Password reset and expiry\n\nWhen a password expires after 90 days the user cannot sign in.\nUse the self-service reset portal, set a new password, then sign out of Outlook\nand Teams on the phone and sign back in so the cached password is replaced.",
    origin: "runbook",
    categories: ["access_identity"],
  });
}, 60_000);

afterAll(async () => {
  if (businessId) {
    await core.purgeBusinessUnaudited(businessId);
  }
  await core.closeQueues().catch(() => {});
  await core.closePool().catch(() => {});
});

async function makeTicket(subject: string, body: string) {
  const result = await core.intakeMessage(tenant, {
    source: "email",
    source_message_id: `test-${crypto.randomUUID()}`,
    requester_email: "test.user@example.test",
    requester_name: "Test User",
    subject,
    body,
    attachments: [],
    received_at: new Date(),
    meta: {},
  });
  return result.ticket;
}

describe("pipeline against a real database", () => {
  it("runs the happy path and records every stage", async () => {
    if (!available) return expect(available).toBe(false);

    const ticket = await makeTicket(
      "Password expired and I cannot sign in",
      "My password expired this morning and now Outlook on my phone keeps rejecting the new one.",
    );

    const result = await runPipeline(ticket.id);
    expect(result.ok).toBe(true);
    expect(result.decision?.rule).toBe("confident_with_runbook");

    const after = await core.getTicket(tenant, ticket.id);
    expect(after?.category).toBe("access_identity");
    expect(after?.priority).toBe("P2");
    expect(Number(after?.triage_confidence)).toBeCloseTo(0.97, 2);
    expect(after?.status).toBe("resolved");
    expect(after?.resolution_path).toBe("auto_reply");

    const events = await core.eventsFor(tenant, ticket.id);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("triage");
    expect(kinds).toContain("retrieval");
    expect(kinds).toContain("note"); // intake + decision
    expect(kinds).toContain("message");

    // Retrieval actually hit the vector index rather than returning nothing.
    expect(result.chunks?.length).toBeGreaterThan(0);

    /*
     * A reply is a queued message, not a log line.
     *
     * The event log used to be the whole of "the agent replied": the transport
     * was a stub, so a ticket could read as answered while nothing had been
     * addressed to anybody. These assertions are the difference — an
     * `outbound_messages` row addressed to the requester, threaded, with the
     * reply event pointing at it.
     */
    const outbound = await core.outboundForTicket(tenant, ticket.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.to_email).toBe("test.user@example.test");
    expect(outbound[0]!.status).toBe("queued");
    expect(outbound[0]!.subject).toContain(`[NG-${ticket.id.slice(0, 8)}]`);
    // Threaded onto the inbound message, so the answer lands in the same
    // conversation in the requester's mail client.
    expect(outbound[0]!.in_reply_to).toBe(ticket.source_message_id);

    // The conversation: the requester's opening message, then the agent's
    // reply, which says what wrote it and which row delivers it.
    const thread = await core.threadFor(tenant, ticket.id);
    expect(thread.map((m) => [m.seq, m.author_kind, m.visibility])).toEqual([
      [1, "requester", "public"],
      [2, "ai", "public"],
    ]);
    expect(thread[0]!.body).toContain("Outlook on my phone");
    expect(thread[1]).toMatchObject({
      kind: "message",
      channel: "email",
      outbound_id: outbound[0]!.id,
      ai_model: "stub-model",
      legacy: null,
    });
    expect(thread[1]!.ai_prompt_version).toMatch(/^helpdesk\.reply@/);
    expect(Array.isArray(thread[1]!.ai_sources)).toBe(true);
    // Nothing writes the old `reply` event any more.
    expect(kinds).not.toContain("reply");

    // And the queue is the record: the same reply sent twice is one message.
    const again = await core.queueOutbound(tenant, {
      ticket_id: ticket.id,
      to_email: outbound[0]!.to_email,
      from_email: outbound[0]!.from_email,
      subject: outbound[0]!.subject,
      body: outbound[0]!.body,
      message_id: `second-${crypto.randomUUID()}@test`,
      idempotency_key: outbound[0]!.idempotency_key,
    });
    expect(again.queued).toBe(false);
    expect(again.message.id).toBe(outbound[0]!.id);
  }, 60_000);

  it("records the counterfactual in the shadow table", async () => {
    if (!available) return expect(available).toBe(false);

    const ticket = await makeTicket(
      "Password expired again",
      "Same as last time, my password has expired and I cannot get in.",
    );
    await runPipeline(ticket.id);

    const shadow = await core.queryOne<{
      agent_category: string;
      agent_path: string;
      agent_confidence: number;
    }>(`select * from triage_shadow where ticket_id = $1`, [ticket.id]);

    expect(shadow?.agent_category).toBe("access_identity");
    expect(shadow?.agent_path).toBe("auto_reply");

    // And a human correction reconciles it, which is the calibration loop.
    await core.reconcileShadow(tenant, {
      ticket_id: ticket.id,
      human_category: "email_collab",
      human_priority: "P3",
    });
    const reconciled = await core.queryOne<{
      agreed_category: boolean;
      agreed_priority: boolean;
    }>(`select agreed_category, agreed_priority from triage_shadow where ticket_id = $1`, [
      ticket.id,
    ]);
    expect(reconciled?.agreed_category).toBe(false);
    expect(reconciled?.agreed_priority).toBe(false);
  }, 60_000);

  it("escalates a destructive request without touching a tool", async () => {
    if (!available) return expect(available).toBe(false);

    triageStub.value = {
      ...triageStub.value,
      category: "provisioning",
      subcategory: "offboarding",
      is_destructive_request: true,
      confidence: 0.99,
    };

    const ticket = await makeTicket(
      "Delete Tom's account",
      "Tom leaves Friday. Delete his account and wipe the laptop.",
    );
    const result = await runPipeline(ticket.id);

    expect(result.decision?.rule).toBe("destructive_request");
    const after = await core.getTicket(tenant, ticket.id);
    expect(after?.resolution_path).toBe("escalated");

    const events = await core.eventsFor(tenant, ticket.id);
    expect(events.some((e) => e.kind === "escalation")).toBe(true);
    // Nobody at the desk, agent or person, said anything to the requester.
    const thread = await core.threadFor(tenant, ticket.id);
    expect(thread.filter((m) => m.from === "desk")).toEqual([]);

    const calls = await core.query<{ tool_name: string }>(
      `select tool_name from tool_calls where ticket_id = $1`,
      [ticket.id],
    );
    expect(calls.map((c) => c.tool_name)).toEqual(["ticket.escalate"]);
  }, 60_000);

  it("asks a clarifying question when information is missing", async () => {
    if (!available) return expect(available).toBe(false);

    triageStub.value = {
      ...triageStub.value,
      category: "hardware",
      subcategory: "unspecified slowness",
      missing_info: ["Which application is slow", "When it started"],
      confidence: 0.95,
    };

    const ticket = await makeTicket("laptop playing up", "its slow again");
    const result = await runPipeline(ticket.id);

    expect(result.decision?.rule).toBe("missing_info");
    const after = await core.getTicket(tenant, ticket.id);
    expect(after?.status).toBe("awaiting_user");
    expect(after?.clarify_count).toBe(1);
  }, 60_000);

  it("keeps the SLA credit a ticket has earned when it is retriaged", async () => {
    if (!available) return expect(available).toBe(false);

    // A requester of its own, so the agent-run rate limit this file's other
    // tests spend against the shared one cannot park the retriage.
    const intake = await core.intakeMessage(tenant, {
      source: "email",
      source_message_id: `test-${crypto.randomUUID()}`,
      requester_email: `retriage-${Date.now()}@example.test`,
      requester_name: "Retriage Person",
      subject: "laptop playing up",
      body: "its slow again",
      attachments: [],
      received_at: new Date(),
      meta: {},
    });
    const id = intake.ticket.id;
    const settings = await core.getSettings(businessId);

    // First pass asks a question, which stops the clock.
    triageStub.value = {
      ...triageStub.value,
      category: "hardware",
      subcategory: "unspecified slowness",
      missing_info: ["Which application is slow"],
      confidence: 0.95,
    };
    await runPipeline(id);
    expect((await core.getTicket(tenant, id))?.sla_paused_at).not.toBeNull();

    // The requester holds it for a week. P2 runs on business hours in this
    // tenant, and a week holds working time whenever the suite runs.
    await core.query(
      `update tickets set sla_paused_at = now() - interval '7 days' where id = $1`,
      [id],
    );

    // Then somebody retriages it, and this time it escalates.
    triageStub.value = { ...triageStub.value, missing_info: [], is_destructive_request: true };
    await runPipeline(id);

    const once = (await core.getTicket(tenant, id))!;
    expect(once.status).toBe("triaged");
    expect(once.sla_paused_at).toBeNull();
    expect(once.sla_paused_minutes).toBeGreaterThan(0);
    const owed = core.computeSla(
      new Date(intake.ticket.created_at),
      "P2",
      settings,
      once.sla_paused_minutes,
    );
    expect(new Date(once.resolution_due_at!).getTime()).toBe(owed.resolutionDueAt.getTime());

    // And again. The stamp used to start from `created_at` with nothing
    // carried, so this second pass took the whole week back off the deadline
    // while `sla_paused_minutes` went on saying it had been credited.
    await runPipeline(id);
    const twice = (await core.getTicket(tenant, id))!;
    expect(twice.sla_paused_minutes).toBe(once.sla_paused_minutes);
    expect(twice.resolution_due_at).toEqual(once.resolution_due_at);
    expect(twice.resolution_warn_at).toEqual(once.resolution_warn_at);
  }, 60_000);

  it("keeps the credit of a reply that lands while the model is thinking", async () => {
    if (!available) return expect(available).toBe(false);

    // The pipeline read the ticket, and so the credit, before the model call,
    // and computed the stamp from that. A requester who replied during the
    // call resumed the clock and was credited the wait, and the stamp then
    // wrote the uncredited deadline over it. `applyTriage` now stamps from the
    // row it has locked, so whatever committed first is what it builds on.
    const intake = await core.intakeMessage(tenant, {
      source: "email",
      source_message_id: `test-${crypto.randomUUID()}`,
      requester_email: `mid-triage-${Date.now()}@example.test`,
      requester_name: "Mid Triage Person",
      subject: "laptop playing up",
      body: "its slow again",
      attachments: [],
      received_at: new Date(),
      meta: {},
    });
    const id = intake.ticket.id;
    const settings = await core.getSettings(businessId);

    triageStub.value = {
      ...triageStub.value,
      category: "hardware",
      subcategory: "unspecified slowness",
      missing_info: ["Which application is slow"],
      confidence: 0.95,
    };
    await runPipeline(id);
    await core.query(
      `update tickets set sla_paused_at = now() - interval '7 days' where id = $1`,
      [id],
    );

    // The retriage's model call is where the requester answers: the resume
    // commits after the pipeline has read the ticket and before it writes.
    const llm = await import("@hd/llm");
    vi.mocked(llm.callStructured).mockImplementationOnce(async () => {
      await core.setStatus(tenant, id, "triaged");
      return {
        data: triageStub.value,
        model: "stub-model",
        tokensIn: 1200,
        tokensOut: 180,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0042,
        latencyMs: 950,
        attempts: 1,
      };
    });
    triageStub.value = { ...triageStub.value, missing_info: [], is_destructive_request: true };
    await runPipeline(id);

    const after = (await core.getTicket(tenant, id))!;
    expect(after.sla_paused_at).toBeNull();
    expect(after.sla_paused_minutes).toBeGreaterThan(0);
    const owed = core.computeSla(
      new Date(intake.ticket.created_at),
      "P2",
      settings,
      after.sla_paused_minutes,
    );
    expect(new Date(after.resolution_due_at!).getTime()).toBe(owed.resolutionDueAt.getTime());
    expect(new Date(after.resolution_warn_at!).getTime()).toBe(owed.resolutionWarnAt.getTime());
  }, 60_000);

  it("is idempotent on a redelivered message", async () => {
    if (!available) return expect(available).toBe(false);

    const messageId = `dupe-${crypto.randomUUID()}`;
    const payload = {
      source: "email" as const,
      source_message_id: messageId,
      requester_email: "test.user@example.test",
      requester_name: "Test User",
      subject: "Same message twice",
      body: "The webhook retried.",
      attachments: [],
      received_at: new Date(),
      meta: {},
    };

    const first = await core.intakeMessage(tenant, payload);
    const second = await core.intakeMessage(tenant, payload);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.ticket.id).toBe(first.ticket.id);
  }, 60_000);

  it("parks a draft in the conversation, and a person sending it keeps the lineage", async () => {
    if (!available) return expect(available).toBe(false);

    // A tenant whose policy lets the agent suggest and nothing more, so the
    // reply it would have sent becomes a draft for a person.
    const row = await core.queryOne<{ id: string }>(
      `insert into businesses (name, type, settings) values ($1,$2,$3::jsonb) returning id`,
      [
        `suggest-${Date.now()}`,
        "it_services",
        JSON.stringify({ ...settings, default_policy: { autonomy: "suggest", confidence_threshold: 0.9 } }),
      ],
    );
    const suggestId = row!.id;
    const sys = core.systemContext(suggestId);
    const email = `reviewer-${crypto.randomUUID()}@example.test`;
    const userId = await core.createUserUnaudited({
      email,
      fullName: "Reviewer",
      password: "correct horse battery staple",
    });
    try {
      await core.addMembershipUnaudited(userId, suggestId, "admin");
      await ingestDocument(sys, {
        title: "Password reset and expiry",
        content:
          "# Password reset and expiry\n\nUse the self-service reset portal, set a new password, then sign out and back in on the phone.",
        origin: "runbook",
        categories: ["access_identity"],
      });
      const intake = await core.intakeMessage(sys, {
        source: "email",
        source_message_id: `suggest-${crypto.randomUUID()}`,
        requester_email: "suggest.user@example.test",
        requester_name: "Suggest User",
        subject: "Password expired",
        body: "My password expired and my phone keeps rejecting the new one.",
        attachments: [],
        received_at: new Date(),
        meta: {},
      });
      const result = await runPipeline(intake.ticket.id);
      expect(result.decision?.action).toBe("draft_only");

      const thread = await core.threadFor(sys, intake.ticket.id);
      const draft = thread.find((m) => m.kind === "draft")!;
      expect(draft).toMatchObject({
        visibility: "internal",
        author_kind: "ai",
        ai_model: "stub-model",
        channel: "internal",
      });
      expect(draft.ai_prompt_version).toMatch(/^helpdesk\.reply@/);
      // The configuration the decision was made under: none yet, for a tenant
      // created straight into the table.
      expect(draft.ai_config_version).toBe(await core.currentConfigVersionNumber(suggestId));
      expect(draft.metadata).toMatchObject({
        draft_kind: "reply",
        would_have: result.decision?.intendedAction,
        rule: result.decision?.rule,
      });
      // The model call's cost is on the draft's audit event, where every other
      // model call's is.
      const event = (await core.eventsFor(sys, intake.ticket.id)).find(
        (e) => e.id === draft.event_id,
      )!;
      expect(Number(event.cost_usd)).toBeCloseTo(0.0018, 6);
      expect(event.model).toBe("stub-model");

      // The portal never sees it.
      const seen = await core.threadFor(core.portalContext(suggestId), intake.ticket.id);
      expect(seen.some((m) => m.kind === "draft")).toBe(false);

      // A person edits it and sends it. The reply is theirs, from the draft.
      const person = core.humanContext({
        businessId: suggestId,
        actorId: userId,
        actorEmail: email,
        role: "admin",
      });
      const { executeTool } = await import("@hd/tools");
      await executeTool(
        "ticket.send_reply",
        { body: `${draft.body}\n\nEdited.`, close_after: true, derived_from_id: draft.id },
        { tenant: person, ticketId: intake.ticket.id },
        { whitelist: ["ticket.send_reply"], agent: "helpdesk", rationale: "reviewed" },
      );
      const after = await core.threadFor(sys, intake.ticket.id);
      const sent = after.at(-1)!;
      expect(sent).toMatchObject({
        kind: "message",
        visibility: "public",
        author_kind: "staff",
        author_user_id: userId,
        derived_from_id: draft.id,
        ai_model: null,
      });
      expect(sent.outbound_id).not.toBeNull();
    } finally {
      await core.purgeBusinessUnaudited(suggestId);
      await core.query(`delete from users where id = $1`, [userId]);
    }
  }, 60_000);

  it("refuses an agent reply that does not say what wrote it, before anything is queued", async () => {
    if (!available) return expect(available).toBe(false);

    const ticket = await makeTicket("Nothing wrote this", "Please help.");
    const { executeTool } = await import("@hd/tools");
    await expect(
      executeTool(
        "ticket.send_reply",
        { body: "Words from nowhere." },
        { tenant: core.agentContext(businessId), ticketId: ticket.id },
        { whitelist: ["ticket.send_reply"], agent: "helpdesk", rationale: "test" },
      ),
    ).rejects.toThrow(/must say what wrote it/);
    expect(await core.outboundForTicket(tenant, ticket.id)).toHaveLength(0);
  }, 60_000);

  it("writes a templated reply as the system's, naming its template and no model", async () => {
    if (!available) return expect(available).toBe(false);

    // An incident acknowledgement: settings text, no model call. Saying the
    // agent's model wrote it would be provenance for words it never produced.
    const ticket = await makeTicket("VPN down", "Cannot connect.");
    const { executeTool } = await import("@hd/tools");
    const tool = { whitelist: ["ticket.send_reply"], agent: "helpdesk" as const, rationale: "test" };
    const ctx = { tenant: core.agentContext(businessId), ticketId: ticket.id };

    await expect(
      executeTool("ticket.send_reply", { body: "No template.", provenance: { model: null } }, ctx, tool),
    ).rejects.toThrow(/must name its template/);

    await executeTool(
      "ticket.send_reply",
      { body: "We are already tracking this.", provenance: { model: null, template: "incident_ack" } },
      ctx,
      tool,
    );
    const sent = (await core.threadFor(tenant, ticket.id)).at(-1)!;
    expect(sent).toMatchObject({
      author_kind: "system",
      ai_model: null,
      metadata: { template: "incident_ack" },
      visibility: "public",
    });
    expect(sent.outbound_id).not.toBeNull();
  }, 60_000);

  it("refuses provenance from a person, whose authorship is their session", async () => {
    if (!available) return expect(available).toBe(false);

    const ticket = await makeTicket("Printer", "Jammed.");
    const { executeTool } = await import("@hd/tools");
    const person = core.humanContext({
      businessId,
      actorId: crypto.randomUUID(),
      actorEmail: "someone@example.test",
      role: "admin",
    });
    await expect(
      executeTool(
        "ticket.send_reply",
        { body: "Written by a model, honest.", provenance: { model: "stub-model" } },
        { tenant: person, ticketId: ticket.id },
        { whitelist: ["ticket.send_reply"], agent: "helpdesk", rationale: "test" },
      ),
    ).rejects.toThrow(/only the agent's reply carries provenance/);
    expect(await core.outboundForTicket(tenant, ticket.id)).toHaveLength(0);
  }, 60_000);
});
