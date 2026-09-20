import { query, requirePermission, type TenantContext } from "@hd/core";
import { embedOne, toVectorLiteral } from "./embed.js";

export interface RetrievedChunk {
  id: string;
  doc_id: string;
  doc_title: string;
  source_url: string | null;
  origin: string;
  content: string;
  categories: string[];
  /** Cosine similarity in [0, 1]. Higher is closer. */
  score: number;
}

export interface RetrieveOptions {
  queryText: string;
  limit?: number;
  /** Soft filter: matching categories are boosted, others still eligible. */
  categories?: string[];
  /** Drop anything below this similarity before returning. */
  floor?: number;
}

/**
 * Semantic search over runbooks, vendor docs and resolved-ticket writebacks.
 *
 * Superseded chunks are excluded at the query level rather than filtered
 * afterwards: a stale fix that still ranks highly is exactly the failure mode
 * `superseded_by` exists to prevent.
 */
export async function retrieve(
  ctx: TenantContext,
  opts: RetrieveOptions,
): Promise<RetrievedChunk[]> {
  requirePermission(ctx, "kb:read");
  const limit = opts.limit ?? 5;
  const vector = toVectorLiteral(await embedOne(opts.queryText));
  const cats = opts.categories?.length ? opts.categories : null;

  const rows = await query<RetrievedChunk & { distance: number }>(
    `select id, doc_id, doc_title, source_url, origin, content, categories,
            (embedding <=> $2::vector) as distance
       from kb_chunks
      where business_id = $1
        and superseded_by is null
      order by
        -- category overlap is a tiebreak, not a filter: a runbook filed under
        -- the wrong category should still surface if the text matches.
        (embedding <=> $2::vector) - case
          when $3::text[] is not null and categories && $3::text[] then 0.05
          else 0
        end
      limit $4`,
    [ctx.businessId, vector, cats, limit],
  );

  const floor = opts.floor ?? 0;
  return rows
    .map((r) => ({ ...r, score: 1 - Number(r.distance) }))
    .filter((r) => r.score >= floor);
}

/** Compact block for a prompt, with sources the reply can be audited against. */
export function formatExcerpts(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "none";
  return chunks
    .map(
      (c, i) =>
        `[${i + 1}] ${c.doc_title} (${c.origin}, similarity ${c.score.toFixed(2)})\n${c.content}`,
    )
    .join("\n\n---\n\n");
}
