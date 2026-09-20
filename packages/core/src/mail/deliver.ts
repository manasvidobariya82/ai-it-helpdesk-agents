import { systemContext, type TenantContext } from "../auth/context.js";
import { env } from "../env.js";
import { enqueueOutbound } from "../queue.js";
import { effectiveMode } from "../settings.js";
import { getSettings } from "../repos/businesses.js";
import { appendEvent } from "../repos/events.js";
import {
  cancelOutbound,
  claimOutbound,
  deferOutbound,
  failOutbound,
  findOutboundByMessageId,
  findOutboundByProviderId,
  markBounced,
  markSent,
  recordOutboundEvent,
  suppressAddress,
  type OutboundMessage,
} from "../repos/outbound.js";
import { recordMessageId } from "../repos/threading.js";
import { getTicket, setStatus } from "../repos/tickets.js";
import type { ParsedBounce } from "./bounce.js";
import type { OutboundDraft } from "./render.js";
import {
  PermanentDeliveryError,
  retryDelayMs,
  transportFor,
  TransientDeliveryError,
} from "./transport.js";

/**
 * One delivery attempt.
 *
 * Everything about a message that could change between the decision to send it
 * and the attempt itself was frozen onto the row at queue time, so this
 * function reads, sends, and records — it renders nothing and decides nothing.
 * That is what makes the fourth attempt send the same words as the first.
 *
 * The worker calls it with a job id and no tenant, exactly like triage: the row
 * is what names the tenant, and every write below is scoped by the context
 * built from it.
 */
export type DeliveryOutcomeStatus =
  | "sent"
  | "deferred"
  | "failed"
  | "cancelled"
  | "skipped";

export interface DeliveryResult {
  messageId: string;
  status: DeliveryOutcomeStatus;
  provider: string | null;
  attempts: number;
  error?: string;
  /** Why nothing happened, for the `skipped` case. */
  note?: string;
}

export async function deliverOutbound(id: string): Promise<DeliveryResult> {
  // The claim is the lock. If it returns nothing, another worker has this
  // message, or it is no longer sendable — both of which are correct outcomes
  // for a duplicate job, and neither of which is an error.
  const message = await claimOutbound(id);
  if (!message) {
    return {
      messageId: id,
      status: "skipped",
      provider: null,
      attempts: 0,
      note: "not claimable: already sent, cancelled, in flight, or not yet due",
    };
  }

  // Delivery is infrastructure, not an agent decision — the same category as
  // the intake poller — so it runs as the system inside the tenant that owns
  // the row, and everything it writes is attributed that way.
  const tenant = systemContext(message.business_id, { requestId: `outbound:${id}` });
  const transport = transportFor();

  if (!transport) {
    // A deployment that has decided not to send is not a failure, and must not
    // accumulate retries against a transport that is never coming.
    const reason = "no outbound transport configured (OUTBOUND_EMAIL_PROVIDER=none)";
    await cancelOutbound(tenant, id, reason);
    return {
      messageId: id,
      status: "cancelled",
      provider: null,
      attempts: message.attempts,
      note: reason,
    };
  }

  /*
   * The kill switch has to reach the queue, not only the decision.
   *
   * `AGENT_MODE` and a tenant's `agent_mode_override` decide whether the agent
   * may contact anybody, and they used to be enough on their own because
   * nothing was ever sent. Now a reply can be queued in `auto` and delivered a
   * few seconds later, so narrowing the mode in between has to stop it — the
   * P4 gate is "flipping the switch stops outbound contact within one ticket",
   * and a queue that drains regardless would make that false.
   *
   * Only messages the agent queued. A human who clicked Send is not the agent,
   * and shadow mode is a statement about the agent.
   */
  if (message.created_by === "agent") {
    const settings = await getSettings(message.business_id);
    if (effectiveMode(env.AGENT_MODE, settings) !== "auto") {
      const reason =
        "the agent's autonomy was narrowed after this reply was queued, so it was not sent";
      await cancelOutbound(tenant, id, reason);
      // Unlike the no-transport case, this one tells the ticket: a resolution
      // the requester never received is not a resolution, and somebody has to
      // pick it up.
      await announceUndelivered(tenant, message, reason);
      return {
        messageId: id,
        status: "cancelled",
        provider: null,
        attempts: message.attempts,
        note: reason,
      };
    }
  }

  await recordOutboundEvent(tenant, id, "attempt", {
    attempt: message.attempts,
    of: message.max_attempts,
    provider: transport.name,
  });

  try {
    const outcome = await transport.send(draftFrom(message));
    await markSent(tenant, id, {
      provider: transport.name,
      providerMessageId: outcome.providerMessageId,
      response: outcome.response,
    });

    // Register our Message-ID as part of the thread only once it has actually
    // gone out. Before that there is nothing for a requester to reply to, and a
    // threading row for a message nobody received would quietly absorb an
    // unrelated mail that happened to quote the id.
    if (message.ticket_id) {
      await recordMessageId(message.ticket_id, message.message_id, "outbound");
    }

    return {
      messageId: id,
      status: "sent",
      provider: transport.name,
      attempts: message.attempts,
    };
  } catch (err) {
    return handleFailure(tenant, message, transport.name, err);
  }
}

async function handleFailure(
  tenant: TenantContext,
  message: OutboundMessage,
  provider: string,
  err: unknown,
): Promise<DeliveryResult> {
  const permanent = err instanceof PermanentDeliveryError;
  const error = err instanceof Error ? err.message : String(err);
  const code =
    err instanceof PermanentDeliveryError || err instanceof TransientDeliveryError
      ? err.code
      : null;

  // A failure that is a statement about the address rather than about this
  // message stops the address, not just the message. Five retries per message
  // rediscovering a mailbox that no longer exists is how a sender's reputation
  // is spent.
  if (err instanceof PermanentDeliveryError && err.suppress) {
    await suppressAddress(tenant, {
      email: message.to_email,
      reason: err.suppress,
      detail: error,
      outbound_id: message.id,
    });
  }

  const exhausted = message.attempts >= message.max_attempts;
  if (!permanent && !exhausted) {
    const delayMs = retryDelayMs(message.attempts);
    await deferOutbound(tenant, message.id, { error, code, delayMs, provider });
    // The job is a doorbell; the sweep rings it again if this enqueue is lost,
    // so a Redis outage during a retry costs a sweep interval and not the mail.
    await enqueueOutbound(message.id, {
      delayMs,
      attempt: message.attempts,
    }).catch(() => {});
    return {
      messageId: message.id,
      status: "deferred",
      provider,
      attempts: message.attempts,
      error,
    };
  }

  await failOutbound(tenant, message.id, { error, code, provider, permanent });
  await announceUndelivered(tenant, message, `delivery failed: ${error}`);
  return {
    messageId: message.id,
    status: "failed",
    provider,
    attempts: message.attempts,
    error,
  };
}

/**
 * Tell the ticket, and put it back in front of a human.
 *
 * The event log is the only honest answer to "why did this ticket close with
 * nobody hearing from us", so a dead letter writes to it. And a ticket whose
 * resolving reply never arrived is not resolved: it goes back to `triaged`,
 * which routes to a person. Never back to the agent — the same rule the reopen
 * path follows, for the same reason. The agent has already had its turn and
 * the outcome was that the requester heard nothing.
 */
async function announceUndelivered(
  tenant: TenantContext,
  message: OutboundMessage,
  summary: string,
): Promise<void> {
  if (!message.ticket_id) return;

  await appendEvent(tenant, {
    ticket_id: message.ticket_id,
    actor: "system",
    kind: "error",
    payload: {
      stage: "delivery",
      outbound_id: message.id,
      to: message.to_email,
      subject: message.subject,
      attempts: message.attempts,
      summary,
    },
  });

  const ticket = await getTicket(tenant, message.ticket_id);
  if (ticket && ["resolved", "closed"].includes(ticket.status)) {
    await setStatus(tenant, message.ticket_id, "triaged");
    await appendEvent(tenant, {
      ticket_id: message.ticket_id,
      actor: "system",
      kind: "status_change",
      payload: {
        status: "triaged",
        reason: "the reply that resolved this ticket was never delivered",
        routes_to: "human",
      },
    });
  }
}

function draftFrom(message: OutboundMessage): OutboundDraft {
  return {
    toEmail: message.to_email,
    toName: message.to_name,
    fromEmail: message.from_email,
    fromName: message.from_name,
    replyTo: message.reply_to,
    subject: message.subject,
    body: message.body,
    messageId: message.message_id,
    inReplyTo: message.in_reply_to,
    references: message.reference_ids ?? [],
  };
}

/**
 * Drain everything that is due.
 *
 * The worker's own loop. Deliveries run one at a time here rather than in
 * parallel: the expensive resource is the provider's willingness to accept mail
 * from us, and a burst is the one thing that gets a sender rate-limited.
 */
export async function deliverDue(
  ids: { id: string }[],
): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];
  for (const row of ids) {
    results.push(await deliverOutbound(row.id));
  }
  return results;
}

// ---------------------------------------------------------------------------
// bounces
// ---------------------------------------------------------------------------

export interface BounceOutcome {
  matched: OutboundMessage | null;
  suppressed: boolean;
  /** What this changed: a status, an event only, or nothing we could place. */
  applied: "bounced" | "noted" | "unmatched";
}

/**
 * Record a bounce or complaint that arrived for this tenant.
 *
 * The tenant comes from the transport that delivered the report — an intake
 * token, a mailbox, a provider webhook authenticated per tenant — and never
 * from the report's contents. That matters more here than almost anywhere else:
 * a bounce is a document written by a stranger's mail server, quoting our
 * Message-ID back at us, and a Message-ID is not a secret. Resolving it without
 * a tenant predicate would let anybody who has ever received one of our
 * messages mark another tenant's mail as bounced.
 *
 * A soft bounce is deliberately not a failure. `4.x.x` and `Action: delayed`
 * are the far side saying it is still trying, and turning that into "the
 * requester never got this" would be wrong about a mail that is in flight.
 */
export async function applyBounce(
  ctx: TenantContext,
  parsed: ParsedBounce,
): Promise<BounceOutcome> {
  const message = await matchBounce(ctx, parsed);

  const hard = parsed.kind === "hard" || parsed.kind === "complaint";
  let suppressed = false;

  // The address can be suppressed even when the message cannot be placed. A
  // hard bounce naming a recipient is a fact about that mailbox whether or not
  // we can work out which of our messages provoked it.
  const address = parsed.recipient ?? message?.to_email ?? null;
  if (hard && address) {
    await suppressAddress(ctx, {
      email: address,
      reason: parsed.kind === "complaint" ? "complaint" : "hard_bounce",
      detail: parsed.diagnostic ?? parsed.status ?? null,
      outbound_id: message?.id ?? null,
    });
    suppressed = true;
  }

  if (!message) {
    return { matched: null, suppressed, applied: "unmatched" };
  }

  if (!hard) {
    await recordOutboundEvent(ctx, message.id, "bounced", {
      kind: "soft",
      status: parsed.status,
      action: parsed.action,
      diagnostic: parsed.diagnostic,
      note: "delay notice; the receiving server is still trying",
    });
    return { matched: message, suppressed, applied: "noted" };
  }

  const detail = [parsed.status, parsed.diagnostic].filter(Boolean).join(" ") || null;
  const updated = await markBounced(ctx, message.id, {
    kind: parsed.kind === "complaint" ? "complaint" : "hard",
    detail,
  });
  if (updated) {
    await announceUndelivered(
      ctx,
      updated,
      parsed.kind === "complaint"
        ? `the requester reported this message as spam${detail ? `: ${detail}` : ""}`
        : `the message bounced${detail ? `: ${detail}` : ""}`,
    );
  }
  return { matched: updated ?? message, suppressed, applied: "bounced" };
}

async function matchBounce(
  ctx: TenantContext,
  parsed: ParsedBounce,
): Promise<OutboundMessage | null> {
  if (parsed.originalMessageId) {
    const byOurId = await findOutboundByMessageId(ctx, parsed.originalMessageId);
    if (byOurId) return byOurId;
    // Some providers replace our Message-ID with their own on the way out and
    // then quote theirs back in the webhook.
    const byProviderId = await findOutboundByProviderId(ctx, parsed.originalMessageId);
    if (byProviderId) return byProviderId;
  }
  return null;
}

/** The transport this deployment would use, for the console to display. */
export function outboundProviderName(): string {
  return env.OUTBOUND_EMAIL_PROVIDER;
}
