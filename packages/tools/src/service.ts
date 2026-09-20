import {
  appendEvent,
  appendMessage,
  ConversationLockedError,
  conversationFor,
  IdempotencyConflictError,
  systemContext,
  type AppendMessageInput,
  type TenantContext,
  currentBusiness,
  enqueueOutbound,
  env,
  getRequester,
  getTicket,
  markFirstResponse,
  notifyEscalation,
  outboundProviderName,
  query,
  queueOutbound,
  renderReply,
  replyIdempotencyKey,
  setStatus,
  threadMessageIds,
} from "@hd/core";
import { z } from "zod";
import { defineTool, toolActor } from "./registry.js";

/**
 * Ticketing, MDM and communication tools.
 *
 * `ticket.send_reply` is the one tool that touches the requester, so it is the
 * one the autonomy dial actually gates.
 */

export const sendReply = defineTool({
  name: "ticket.send_reply",
  description: "Send a reply to the requester on the ticket thread.",
  riskTier: "safe_write",
  agents: ["helpdesk"],
  schema: z.object({
    body: z.string().min(1),
    close_after: z.boolean().default(false),
    /**
     * Supplied only by a caller that means to say the same words twice. The
     * default key is derived from the ticket and the body, which is what makes
     * a double-clicked Send button one email.
     */
    idempotency_key: z.string().min(8).max(200).optional(),
    /**
     * What wrote the words, when the agent sends them (C6 in
     * docs/conversation.md). Required from the agent and refused from anybody
     * else, whose authorship is their session. A model's reply names the
     * model. A templated one, such as an incident acknowledgement, names the
     * template and no model, and is written as the system's.
     */
    provenance: z
      .object({
        model: z.string().min(1).nullable(),
        template: z.string().min(1).nullable().optional(),
        prompt_version: z.string().nullable().optional(),
        config_version: z.number().int().nullable().optional(),
        sources: z.array(z.unknown()).nullable().optional(),
        cost_usd: z.number().nullable().optional(),
        latency_ms: z.number().int().nullable().optional(),
      })
      .optional(),
    /** The draft these words were made from, when a person sends one (C6). */
    derived_from_id: z.string().min(1).optional(),
  }),
  summarize: (a) =>
    `Reply to the requester${a.close_after ? " and resolve the ticket" : ""}`,
  /**
   * Queues a message; it does not send one.
   *
   * The distinction is the whole design. This runs inside a request or a triage
   * job, and a network call to a mail provider from there has no safe failure
   * mode: on a timeout the caller cannot tell whether the requester was
   * contacted, and retrying the job would either duplicate the mail or lose it.
   * So the message is written to `outbound_messages` in the same breath as the
   * event log, and a worker owns delivery, retries and the eventual answer.
   *
   * What comes back is therefore `queued`, never `delivered`. Nothing here is
   * permitted to claim a person received anything.
   */
  execute: async (args, ctx) => {
    if (!ctx.ticketId) throw new Error("ticket.send_reply requires a ticket");

    const ticket = await getTicket(ctx.tenant, ctx.ticketId);
    if (!ticket) throw new Error("ticket.send_reply: no such ticket in this tenant");
    const requester = ticket.requester_id
      ? await getRequester(ctx.tenant, ticket.requester_id)
      : null;
    if (!requester?.email) {
      // Escalation is the honest outcome: there is no address to answer, and a
      // reply event claiming otherwise would be a lie in the audit trail.
      throw new Error(
        "ticket.send_reply: this ticket has no requester email to reply to",
      );
    }

    // Settled before anything is queued: a reply the conversation would refuse
    // must not reach the requester and then be missing from the thread.
    const writer = replyWriter(ctx.tenant, args.provenance);
    const conversation = await conversationFor(ctx.tenant, ticket.id);
    if (conversation?.status === "locked") {
      throw new ConversationLockedError(conversation.locked_reason ?? "locked");
    }
    const key = args.idempotency_key ?? replyIdempotencyKey("reply", ticket.id, args.body);

    const business = await currentBusiness(ctx.tenant);
    const draft = renderReply({
      ticketId: ticket.id,
      subject: ticket.subject,
      body: args.body,
      toEmail: requester.email,
      toName: requester.full_name,
      intakeAddress: business.intake_address,
      fallbackFrom: env.OUTBOUND_FROM_ADDRESS,
      fromName: env.OUTBOUND_FROM_NAME,
      messageIdDomain: env.OUTBOUND_MESSAGE_ID_DOMAIN,
      threadMessageIds: await threadMessageIds(ctx.tenant, ticket.id),
    });

    const { message, queued, suppressed } = await queueOutbound(ctx.tenant, {
      ticket_id: ticket.id,
      kind: "reply",
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
      idempotency_key: key,
    });

    if (suppressed) {
      // We cannot write to this address: it has hard-bounced or the person
      // complained, and both are recorded decisions this tool must not
      // override. The message row exists with `suppressed` on it, so the trail
      // says what happened, and then this fails — which parks the ticket with a
      // human, who can reach the person another way. Marking a first response
      // or resolving the ticket here would record a reply that nobody received.
      await appendEvent(ctx.tenant, {
        ticket_id: ctx.ticketId,
        actor: toolActor(ctx),
        kind: "error",
        payload: {
          stage: "delivery",
          outbound_id: message.id,
          to: message.to_email,
          summary: "address is on this tenant's suppression list; nothing was sent",
        },
      });
      throw new Error(
        `ticket.send_reply: ${message.to_email} is suppressed after a bounce or complaint, so this reply was not sent. A human needs to reach them another way.`,
      );
    }

    // The reply joins the conversation, pointing at the row that delivers it.
    // It used to be a `reply` event carrying the body. The message's key is the
    // outbound row's, so a retry of this call finds both and writes neither
    // again, and a call that failed between the two is finished by its retry.
    let recorded = true;
    try {
      await appendMessage(writer.ctx, ticket.id, {
        visibility: "public",
        channel: "email",
        body: args.body,
        idempotencyKey: key,
        outboundId: message.id,
        derivedFromId: args.derived_from_id ?? null,
        ai: writer.ai,
        metadata: writer.metadata,
      });
    } catch (err) {
      // The same words already sent by somebody else: the outbound row was
      // already there, so no second email went out, and the conversation
      // keeps the first author's message.
      if (!(err instanceof IdempotencyConflictError) || queued) throw err;
      recorded = false;
    }
    await markFirstResponse(ctx.tenant, ctx.ticketId);
    if (args.close_after) await setStatus(ctx.tenant, ctx.ticketId, "resolved");

    if (queued) {
      // The row is the queue of record; the job is a doorbell. A Redis outage
      // delays this reply by one sweep instead of dropping it, so failing to
      // enqueue is not failing to reply.
      await enqueueOutbound(message.id).catch(() => {});
    }

    return {
      queued,
      // False when these words were already on the thread from someone else.
      recorded,
      outbound_id: message.id,
      status: message.status,
      to: message.to_email,
      transport: outboundProviderName(),
      chars: args.body.length,
    };
  },
});

type Provenance = NonNullable<z.infer<typeof sendReply.schema>["provenance"]>;

/**
 * Who writes a reply into the conversation (C4, C6).
 *
 * A person and the system are who their context says, and carry no
 * provenance. The agent names what wrote the words: a model, or a template.
 * A templated reply is the system's, because no model wrote it, and saying the
 * agent's model did would be provenance for words it never produced.
 */
function replyWriter(
  tenant: TenantContext,
  provenance: Provenance | undefined,
): { ctx: TenantContext; ai: AppendMessageInput["ai"]; metadata: Record<string, unknown> } {
  if (tenant.actorType !== "agent") {
    if (provenance) {
      throw new Error("ticket.send_reply: only the agent's reply carries provenance");
    }
    return { ctx: tenant, ai: undefined, metadata: {} };
  }
  if (!provenance) {
    throw new Error("ticket.send_reply: the agent's reply must say what wrote it");
  }
  if (provenance.model) {
    return {
      ctx: tenant,
      ai: {
        model: provenance.model,
        promptVersion: provenance.prompt_version ?? null,
        configVersion: provenance.config_version ?? null,
        sources: provenance.sources ?? null,
        usage: { costUsd: provenance.cost_usd ?? null, latencyMs: provenance.latency_ms ?? null },
      },
      metadata: {},
    };
  }
  if (!provenance.template) {
    throw new Error("ticket.send_reply: a reply no model wrote must name its template");
  }
  return {
    ctx: systemContext(tenant.businessId, { requestId: tenant.requestId }),
    ai: undefined,
    metadata: { template: provenance.template },
  };
}

export const setTicketStatus = defineTool({
  name: "ticket.set_status",
  description: "Move the ticket to a different status.",
  riskTier: "internal",
  agents: ["helpdesk"],
  schema: z.object({
    status: z.enum([
      "triaged",
      "awaiting_user",
      "awaiting_approval",
      "in_progress",
      "resolved",
      "closed",
    ]),
    note: z.string().optional(),
  }),
  summarize: (a) => `Set ticket status to ${a.status}`,
  execute: async (args, ctx) => {
    if (!ctx.ticketId) throw new Error("ticket.set_status requires a ticket");
    await setStatus(ctx.tenant, ctx.ticketId, args.status);
    await appendEvent(ctx.tenant, {
      ticket_id: ctx.ticketId,
      actor: toolActor(ctx),
      kind: "status_change",
      payload: { status: args.status, note: args.note ?? null },
    });
    return { status: args.status };
  },
});

export const searchPastTickets = defineTool({
  name: "ticket.search_history",
  description: "Full-text search resolved tickets for a similar past problem.",
  riskTier: "read",
  agents: ["helpdesk"],
  schema: z.object({ q: z.string().min(2), limit: z.number().int().min(1).max(10).default(5) }),
  summarize: (a) => `Search past tickets for "${a.q}"`,
  execute: async (args, ctx) => {
    const rows = await query<{ id: string; subject: string; category: string | null; resolved_at: Date | null }>(
      `select id, subject, category, resolved_at
         from tickets
        where business_id = $1
          and status in ('resolved','closed')
          and (subject ilike $2 or body ilike $2)
        order by resolved_at desc nulls last
        limit $3`,
      [ctx.tenant.businessId, `%${args.q}%`, args.limit],
    );
    return { matches: rows };
  },
});

export const assetStatus = defineTool({
  name: "mdm.asset_status",
  description: "Read device enrolment, OS version and last check-in from the MDM.",
  riskTier: "read",
  agents: ["helpdesk"],
  schema: z.object({ asset_tag: z.string().min(1) }),
  summarize: (a) => `Read MDM status for asset ${a.asset_tag}`,
  execute: async (args, ctx) => {
    const rows = await query<{
      asset_tag: string;
      kind: string | null;
      os: string | null;
      last_seen_at: Date | null;
      metadata: Record<string, unknown>;
    }>(
      `select asset_tag, kind, os, last_seen_at, metadata
         from assets where business_id = $1 and asset_tag = $2`,
      [ctx.tenant.businessId, args.asset_tag],
    );
    const asset = rows[0];
    if (!asset) return { found: false };
    const stale =
      asset.last_seen_at != null &&
      Date.now() - new Date(asset.last_seen_at).getTime() > 7 * 24 * 3600 * 1000;
    return { found: true, ...asset, checkin_stale: stale };
  },
});

export const wipeDevice = defineTool({
  name: "mdm.wipe_device",
  description: "Remotely wipe a device. Irreversible.",
  riskTier: "destructive",
  agents: ["helpdesk"],
  schema: z.object({ asset_tag: z.string().min(1), reason: z.string().min(1) }),
  summarize: (a) => `WIPE device ${a.asset_tag} (${a.reason})`,
  execute: async (args) => {
    if (!process.env.MDM_PROVIDER) {
      return {
        simulated: true,
        action: "wipe_device",
        asset_tag: args.asset_tag,
        note: "No MDM configured. Nothing was wiped.",
      };
    }
    throw new Error("mdm.wipe_device: provider client not implemented.");
  },
});

export const escalateToHuman = defineTool({
  name: "ticket.escalate",
  description:
    "Hand the ticket to a human with a summary and a suggested fix. Never gated.",
  riskTier: "internal",
  agents: ["helpdesk"],
  schema: z.object({
    reason: z.string().min(1),
    summary: z.string().min(1),
    suggested_fix: z.string().nullable().default(null),
    queue: z.string().default("tier1"),
  }),
  summarize: (a) => `Escalate to ${a.queue}: ${a.reason}`,
  execute: async (args, ctx) => {
    if (!ctx.ticketId) throw new Error("ticket.escalate requires a ticket");
    await appendEvent(ctx.tenant, {
      ticket_id: ctx.ticketId,
      actor: toolActor(ctx),
      kind: "escalation",
      payload: {
        reason: args.reason,
        summary: args.summary,
        suggested_fix: args.suggested_fix,
        queue: args.queue,
      },
    });
    await setStatus(ctx.tenant, ctx.ticketId, "triaged");

    // Tell the queue. Escalation is the agent saying it has stopped, and until
    // now that announcement went only into a table somebody had to think to
    // open — which is how a ticket the agent declined to touch sits untouched
    // by anybody. `notifyEscalation` never throws: handing the ticket to a
    // human must not fail because an email could not be queued.
    const notified = await notifyEscalation(ctx.tenant, {
      ticketId: ctx.ticketId,
      queue: args.queue,
      reason: args.reason,
      summary: args.summary,
      suggestedFix: args.suggested_fix,
    });

    return {
      queue: args.queue,
      notified: notified.results.filter((r) => r.sent).length,
      nobody_to_notify: notified.nobody,
    };
  },
});
