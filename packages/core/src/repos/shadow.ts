import { query, queryOne } from "../db.js";
import { requirePermission, type TenantContext } from "../auth/context.js";
import type { ResolutionPath, TicketPriority } from "../types.js";

/**
 * Shadow mode's whole point: log what the agent would have done next to what
 * a human actually did, then set thresholds from the measured disagreement
 * instead of from a number somebody liked the look of.
 *
 * This file deliberately does no arithmetic. It used to carry `group by`
 * helpers that computed accuracy per bucket for the console, which meant the
 * dashboard's number and the gate's number came from two implementations that
 * were free to drift. Everything statistical now lives in `@hd/eval`, reading
 * the raw pairs below; a threshold you can defend and a threshold the console
 * shows have to be the same threshold.
 */
export async function recordShadow(
  ctx: TenantContext,
  input: {
    ticket_id: string;
    agent_category: string;
    agent_priority: TicketPriority;
    agent_confidence: number;
    agent_path: ResolutionPath;
    /** Model and prompt that produced this classification, for attribution. */
    agent_model?: string | null;
    agent_prompt_version?: string | null;
    /** The rendered context block, so a replay reuses the prompt as it was sent. */
    prompt_vars?: Record<string, string> | null;
    /** The agent's own safety flags, so the safety slice is one table's problem. */
    agent_security_sensitive?: boolean | null;
    agent_destructive?: boolean | null;
    /** The configuration version that judged this classification. */
    config_version?: number | null;
  },
): Promise<void> {
  await query(
    `insert into triage_shadow
       (business_id, ticket_id, agent_category, agent_priority, agent_confidence,
        agent_path, agent_model, agent_prompt_version, prompt_vars,
        agent_security_sensitive, agent_destructive, config_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (ticket_id) do update
       set agent_category = excluded.agent_category,
           agent_priority = excluded.agent_priority,
           agent_confidence = excluded.agent_confidence,
           agent_path = excluded.agent_path,
           agent_model = excluded.agent_model,
           agent_prompt_version = excluded.agent_prompt_version,
           prompt_vars = excluded.prompt_vars,
           agent_security_sensitive = excluded.agent_security_sensitive,
           agent_destructive = excluded.agent_destructive,
           config_version = excluded.config_version,
           recorded_at = now(),
           human_category = null, human_priority = null, human_path = null,
           agreed_category = null, agreed_priority = null, reconciled_at = null,
           human_security_sensitive = null, human_destructive = null`,
    [
      ctx.businessId,
      input.ticket_id,
      input.agent_category,
      input.agent_priority,
      input.agent_confidence,
      input.agent_path,
      input.agent_model ?? null,
      input.agent_prompt_version ?? null,
      input.prompt_vars ? JSON.stringify(input.prompt_vars) : null,
      input.agent_security_sensitive ?? null,
      input.agent_destructive ?? null,
      input.config_version ?? null,
    ],
  );
}

/**
 * The agent's side of one ticket's record, for the console's review form.
 *
 * `triage_shadow` carries its own `business_id`, so the scope is a predicate
 * rather than a join, and a ticket id from another tenant returns null.
 */
export async function getShadow(
  ctx: TenantContext,
  ticketId: string,
): Promise<{
  agent_category: string;
  agent_priority: TicketPriority;
  agent_confidence: number;
  agent_security_sensitive: boolean | null;
  agent_destructive: boolean | null;
  human_security_sensitive: boolean | null;
  human_destructive: boolean | null;
} | null> {
  const rows = await query<{
    agent_category: string;
    agent_priority: TicketPriority;
    agent_confidence: number;
    agent_security_sensitive: boolean | null;
    agent_destructive: boolean | null;
    human_security_sensitive: boolean | null;
    human_destructive: boolean | null;
  }>(
    `select agent_category, agent_priority, agent_confidence::float8 as agent_confidence,
            agent_security_sensitive, agent_destructive,
            human_security_sensitive, human_destructive
       from triage_shadow where ticket_id = $1 and business_id = $2`,
    [ticketId, ctx.businessId],
  );
  return rows[0] ?? null;
}

/**
 * Called when a human overrides (or confirms) the agent's classification.
 *
 * This row is the ground truth every threshold is set from, which makes it
 * worth scoping twice over: a label written against another tenant's ticket
 * would corrupt a number somebody later uses to justify turning autonomy up.
 */
export async function reconcileShadow(
  ctx: TenantContext,
  input: {
    ticket_id: string;
    human_category: string;
    human_priority: TicketPriority;
    human_path?: ResolutionPath | null;
    /**
     * The safety slice, when the reviewer said. Left null otherwise: the
     * evaluation harness reports an unlabelled safety slice as unmeasured, and a
     * default of `false` here would turn that into a silent pass.
     */
    human_security_sensitive?: boolean | null;
    human_destructive?: boolean | null;
  },
): Promise<void> {
  await query(
    `update triage_shadow
        set human_category = $2,
            human_priority = $3,
            human_path = $4,
            agreed_category = (agent_category = $2),
            agreed_priority = (agent_priority = $3),
            human_security_sensitive = coalesce($5, human_security_sensitive),
            human_destructive = coalesce($6, human_destructive),
            reconciled_at = now()
      where ticket_id = $1 and business_id = $7`,
    [
      input.ticket_id,
      input.human_category,
      input.human_priority,
      input.human_path ?? null,
      input.human_security_sensitive ?? null,
      input.human_destructive ?? null,
      ctx.businessId,
    ],
  );
}

/**
 * One reconciled row per ticket, unaggregated.
 *
 * The evaluation harness needs the individual pairs, not an average: you
 * cannot compute a calibration curve, a Wilson bound or a threshold sweep from
 * a `group by`.
 */
export interface ReconciledSample {
  ticket_id: string;
  business_id: string;
  agent_category: string;
  agent_priority: TicketPriority;
  agent_confidence: number;
  agent_path: ResolutionPath;
  agent_model: string | null;
  agent_prompt_version: string | null;
  agent_security_sensitive: boolean | null;
  agent_destructive: boolean | null;
  human_category: string;
  human_priority: TicketPriority;
  human_path: ResolutionPath | null;
  human_security_sensitive: boolean | null;
  human_destructive: boolean | null;
  recorded_at: Date;
  reconciled_at: Date;
}

export async function reconciledSamples(
  ctx: TenantContext,
  opts: { days?: number; promptVersion?: string; limit?: number } = {},
): Promise<ReconciledSample[]> {
  requirePermission(ctx, "analytics:read");
  return query<ReconciledSample>(
    `select ticket_id, business_id, agent_category, agent_priority,
            agent_confidence::float8 as agent_confidence, agent_path,
            agent_model, agent_prompt_version,
            agent_security_sensitive, agent_destructive,
            human_category, human_priority, human_path,
            human_security_sensitive, human_destructive,
            recorded_at, reconciled_at
       from triage_shadow
      where business_id = $1
        and reconciled_at is not null
        and human_category is not null
        and ($2::int is null or recorded_at >= now() - ($2 || ' days')::interval)
        and ($3::text is null or agent_prompt_version = $3)
      order by recorded_at desc
      limit $4`,
    [
      ctx.businessId,
      opts.days ?? null,
      opts.promptVersion ?? null,
      opts.limit ?? 5000,
    ],
  );
}

/**
 * How much of the triaged traffic ever got a human verdict.
 *
 * Every accuracy number the harness produces is computed on the reconciled
 * slice. If that slice is a third of the traffic and it is the third people
 * found interesting, the numbers describe the reviewers' attention, not the
 * classifier. This is the denominator that makes that checkable.
 */
export async function countTriagedAndLabelled(
  ctx: TenantContext,
  opts: { days?: number } = {},
): Promise<{ triaged: number; labelled: number }> {
  requirePermission(ctx, "analytics:read");
  const row = await queryOne<{ triaged: number; labelled: number }>(
    `select count(*)::int as triaged,
            count(*) filter (where reconciled_at is not null
                               and human_category is not null)::int as labelled
       from triage_shadow
      where business_id = $1
        and ($2::int is null or recorded_at >= now() - ($2 || ' days')::interval)`,
    [ctx.businessId, opts.days ?? null],
  );
  return row ?? { triaged: 0, labelled: 0 };
}

/**
 * The same rows joined to the ticket and the frozen prompt context, for
 * building a golden dataset. Kept separate from `reconciledSamples` because
 * scoring never needs the ticket body and the body is the expensive column.
 */
export interface ExportableSample extends ReconciledSample {
  subject: string;
  body: string;
  source: string;
  attachments: unknown;
  prompt_vars: Record<string, string> | null;
  business_name: string;
  business_type: string;
  requester_email: string | null;
  requester_name: string | null;
  requester_department: string | null;
  requester_role: string | null;
  requester_vip: boolean | null;
}

export async function exportableSamples(
  ctx: TenantContext,
  opts: { days?: number; limit?: number } = {},
): Promise<ExportableSample[]> {
  // The ticket body travels with these rows, so this needs the ticket
  // permission as well as the analytics one.
  requirePermission(ctx, "analytics:read");
  requirePermission(ctx, "ticket:read");
  return query<ExportableSample>(
    `select s.ticket_id, s.business_id, s.agent_category, s.agent_priority,
            s.agent_confidence::float8 as agent_confidence, s.agent_path,
            s.agent_model, s.agent_prompt_version,
            s.agent_security_sensitive, s.agent_destructive,
            s.human_category, s.human_priority, s.human_path,
            s.human_security_sensitive, s.human_destructive,
            s.recorded_at, s.reconciled_at, s.prompt_vars,
            t.subject, t.body, t.source, t.attachments,
            b.name as business_name, b.type as business_type,
            p.email as requester_email, p.full_name as requester_name,
            p.department as requester_department, p.role as requester_role,
            p.vip as requester_vip
       from triage_shadow s
       join tickets t on t.id = s.ticket_id
       join businesses b on b.id = s.business_id
       left join requesters p on p.id = t.requester_id
      where s.business_id = $1
        and s.reconciled_at is not null
        and s.human_category is not null
        and ($2::int is null or s.recorded_at >= now() - ($2 || ' days')::interval)
      order by s.recorded_at desc
      limit $3`,
    [ctx.businessId, opts.days ?? null, opts.limit ?? 5000],
  );
}
