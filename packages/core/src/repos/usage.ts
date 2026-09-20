import { query, queryOne } from "../db.js";

export interface UsageRecord {
  business_id: string | null;
  ticket_id?: string | null;
  purpose: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd: number;
  latency_ms?: number | null;
  ok?: boolean;
  error?: string | null;
}

export async function recordUsage(u: UsageRecord): Promise<void> {
  await query(
    `insert into llm_usage
       (business_id, ticket_id, purpose, model, tokens_in, tokens_out,
        cache_read_tokens, cache_write_tokens, cost_usd, latency_ms, ok, error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      u.business_id,
      u.ticket_id ?? null,
      u.purpose,
      u.model,
      u.tokens_in,
      u.tokens_out,
      u.cache_read_tokens ?? 0,
      u.cache_write_tokens ?? 0,
      u.cost_usd,
      u.latency_ms ?? null,
      u.ok ?? true,
      u.error ?? null,
    ],
  );
}

export async function spendToday(businessId: string | null): Promise<number> {
  const row = await queryOne<{ total: number }>(
    `select coalesce(sum(cost_usd), 0)::numeric as total
       from llm_usage
      where created_at >= date_trunc('day', now())
        and created_at < date_trunc('day', now()) + interval '1 day'
        and ($1::uuid is null or business_id = $1)`,
    [businessId],
  );
  return Number(row?.total ?? 0);
}
