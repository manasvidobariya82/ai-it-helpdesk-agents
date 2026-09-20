import {
  activeIncidents,
  getRequester,
  primaryAsset,
  recentTicketsFor,
  type Asset,
  type Requester,
  type TenantContext,
  type Ticket,
} from "@hd/core";

export interface EnrichedContext {
  requester: Requester | null;
  asset: Asset | null;
  recentTickets: Ticket[];
  incidents: Ticket[];
}

/**
 * Enrichment is what separates a competent agent from a generic one. The
 * context block below is also what stops the agent opening forty duplicate
 * tickets during an Exchange outage - it can see the parent incident.
 */
export async function enrich(
  tenant: TenantContext,
  ticket: Ticket,
): Promise<EnrichedContext> {
  const requester = ticket.requester_id
    ? await getRequester(tenant, ticket.requester_id)
    : null;
  const [asset, recentTickets, incidents] = await Promise.all([
    requester ? primaryAsset(tenant, requester.id) : Promise.resolve(null),
    requester
      ? recentTicketsFor(tenant, requester.id, 14, ticket.id)
      : Promise.resolve([] as Ticket[]),
    activeIncidents(tenant),
  ]);
  return { requester, asset, recentTickets, incidents };
}

export function requesterLine(ctx: {
  requester: Pick<Requester, "email" | "full_name" | "department" | "role"> | null;
}): string {
  const r = ctx.requester;
  if (!r) return "Unknown sender (not in the directory)";
  const parts = [r.full_name ?? r.email];
  const role = [r.department, r.role].filter(Boolean).join(", ");
  return role ? `${parts[0]} — ${role}` : `${parts[0]}`;
}

export function deviceLine(ctx: {
  asset: Pick<Asset, "kind" | "os" | "asset_tag" | "last_seen_at"> | null;
}): string {
  const a = ctx.asset;
  if (!a) return "none on record";
  const seen = a.last_seen_at
    ? new Date(a.last_seen_at).toISOString().slice(0, 16).replace("T", " ")
    : "never";
  return `${a.kind ?? "device"} ${a.os ?? ""} (tag ${a.asset_tag ?? "unknown"}, last seen ${seen})`.replace(
    /\s+/g,
    " ",
  );
}

export function recentTicketsBlock(ctx: {
  recentTickets: ReadonlyArray<Pick<Ticket, "created_at" | "status" | "category" | "subject">>;
}): string {
  if (ctx.recentTickets.length === 0) return "none";
  return ctx.recentTickets
    .map(
      (t) =>
        `- ${new Date(t.created_at).toISOString().slice(0, 10)} [${t.status}] ${t.category ?? "untriaged"}: ${t.subject}`,
    )
    .join("\n");
}

export function incidentsBlock(ctx: {
  incidents: ReadonlyArray<Pick<Ticket, "id" | "priority" | "subject">>;
}): string {
  if (ctx.incidents.length === 0) return "none";
  return ctx.incidents
    .map((t) => `- ${t.id} [${t.priority ?? "?"}] ${t.subject}`)
    .join("\n");
}

/** Only accept a duplicate hint that names an incident we actually showed it. */
export function resolveIncidentHint(
  hint: string | null,
  ctx: { incidents: ReadonlyArray<Pick<Ticket, "id">> },
): string | null {
  if (!hint) return null;
  const trimmed = hint.trim();
  return ctx.incidents.find((i) => i.id === trimmed)?.id ?? null;
}
