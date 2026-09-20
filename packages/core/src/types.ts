import { z } from "zod";

export const TicketStatus = z.enum([
  "new",
  "triaged",
  "awaiting_user",
  "awaiting_approval",
  "in_progress",
  "resolved",
  "closed",
  "reopened",
]);
export type TicketStatus = z.infer<typeof TicketStatus>;

export const TicketPriority = z.enum(["P1", "P2", "P3", "P4"]);
export type TicketPriority = z.infer<typeof TicketPriority>;

export const ResolutionPath = z.enum([
  "auto_reply",
  "auto_action",
  "clarify",
  "escalated",
  "human_only",
]);
export type ResolutionPath = z.infer<typeof ResolutionPath>;

export const TicketCategory = z.enum([
  "access_identity", // passwords, MFA, SSO, permissions
  "hardware", // laptops, peripherals, phones
  "software", // installs, licences, app errors
  "network_connectivity", // wifi, VPN, DNS
  "email_collab", // mail, calendar, Teams/Slack
  "security_incident", // phishing, malware, suspected breach
  "provisioning", // onboarding, offboarding, new seats
  "other",
]);
export type TicketCategory = z.infer<typeof TicketCategory>;

export const TicketSource = z.enum(["email", "slack", "widget", "phone", "api"]);
export type TicketSource = z.infer<typeof TicketSource>;

export const Attachment = z.object({
  filename: z.string(),
  content_type: z.string().nullable().default(null),
  size_bytes: z.number().int().nonnegative().nullable().default(null),
  storage_key: z.string().nullable().default(null),
});
export type Attachment = z.infer<typeof Attachment>;

/** The canonical object every intake channel normalizes into. */
/**
 * A normalized inbound message.
 *
 * Note the absence of `business_id`. Intake takes its tenant from the context
 * the transport resolved — a webhook token, a mailbox, a signed portal link —
 * and never from the message body, so there is no field for a caller to set.
 */
export const InboundMessage = z.object({
  source: TicketSource,
  source_message_id: z.string().min(1).nullable(),
  requester_email: z.email(),
  requester_name: z.string().nullable().default(null),
  subject: z.string().min(1),
  body: z.string(),
  attachments: z.array(Attachment).default([]),
  received_at: z.coerce.date().default(() => new Date()),
  /** Channel-specific extras (thread ids, phone numbers, widget page url). */
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type InboundMessage = z.infer<typeof InboundMessage>;

export interface Business {
  id: string;
  name: string;
  type: string;
  settings: Record<string, unknown>;
  /** Bearer credential the intake webhook presents. Never sent to a browser. */
  intake_token: string | null;
  intake_address: string | null;
  created_at: Date;
}

export interface Staff {
  id: string;
  business_id: string;
  email: string;
  full_name: string;
  queue: string;
  active: boolean;
}

export interface Requester {
  id: string;
  business_id: string;
  email: string;
  full_name: string | null;
  department: string | null;
  role: string | null;
  directory_id: string | null;
  vip: boolean;
  metadata: Record<string, unknown>;
}

export interface Asset {
  id: string;
  business_id: string;
  requester_id: string | null;
  asset_tag: string | null;
  kind: string | null;
  os: string | null;
  last_seen_at: Date | null;
  metadata: Record<string, unknown>;
}

export interface Ticket {
  id: string;
  business_id: string;
  external_ref: string | null;
  source: string;
  source_message_id: string | null;
  requester_id: string | null;
  asset_id: string | null;
  subject: string;
  body: string;
  attachments: Attachment[];
  status: TicketStatus;
  priority: TicketPriority | null;
  category: string | null;
  subcategory: string | null;
  triage_confidence: number | null;
  resolution_path: ResolutionPath | null;
  assigned_to: string | null;
  is_incident: boolean;
  parent_incident_id: string | null;
  first_response_at: Date | null;
  first_response_due_at: Date | null;
  resolution_due_at: Date | null;
  /**
   * When each clock enters its warning window.
   *
   * Stored rather than derived because the threshold is a share of a window
   * measured in business minutes, and the alternative is a second copy of the
   * working-hours calendar written in SQL. Every reader — console, portal, API
   * and the warning sweep — compares against these.
   */
  first_response_warn_at: Date | null;
  resolution_warn_at: Date | null;
  /** When the current pause began; null whenever the clock is running. */
  sla_paused_at: Date | null;
  /** Business minutes spent paused, accumulated across every cycle. */
  sla_paused_minutes: number;
  /**
   * Minutes the resolution clock has been given back for time spent resolved
   * or closed, accumulated across every reopen. The resolution clock only.
   */
  sla_resolved_minutes: number;
  /**
   * The deadline the first-response clock missed, once a breach is recorded.
   * Set once and never cleared: a recorded result is history, whatever the
   * deadline says afterwards.
   */
  first_response_breached_at: Date | null;
  /**
   * The deadline missed by the first resolution clock that breached. Never
   * cleared, including by a reopen.
   */
  resolution_breached_at: Date | null;
  /**
   * Whether the current resolution clock has a recorded breach. A reopen starts
   * a new clock and clears this, but never `resolution_breached_at`.
   */
  resolution_clock_breached: boolean;
  resolved_at: Date | null;
  closed_at: Date | null;
  reopened_count: number;
  clarify_count: number;
  merged_into_id: string | null;
  injection_suspected: boolean;
  secrets_scrubbed: boolean;
  /**
   * The configuration version in force when this ticket was triaged.
   *
   * Null for tickets decided before versioning existed, and for tickets that
   * have not been triaged. It is what makes a replay honest: the thresholds
   * that judged this ticket are recoverable even after somebody moves them.
   */
  config_version: number | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * The notifications this system sends.
 *
 * A closed list on purpose. Every kind has a template, an audience, a tenant
 * setting that switches it off, and an opt-out somebody can use themselves —
 * and "send an email about this" is not something a new code path should be
 * able to invent without appearing in this enum first.
 */
export const NotificationKind = z.enum([
  /** A ticket was assigned to a member of staff. To them. */
  "assignment",
  /** An SLA clock is nearly out. To the assignee, or to the queue. */
  "sla_warning",
  /** The agent handed a ticket to a queue. To that queue. */
  "escalation",
  /** The agent wants authorization for an action. To the approvers. */
  "approval",
  /** A person resolved the ticket. To the requester. */
  "resolution",
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

export const EventKind = z.enum([
  "triage",
  "retrieval",
  "reply",
  "draft",
  "tool_call",
  "approval",
  "escalation",
  "status_change",
  "note",
  "error",
  // A message appended to the ticket's conversation. The payload points at
  // the message and carries no body (C7 in docs/conversation.md).
  "message",
]);
export type EventKind = z.infer<typeof EventKind>;

export interface TicketEvent {
  id: number;
  ticket_id: string;
  actor: string;
  kind: EventKind;
  payload: Record<string, unknown>;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  created_at: Date;
}
