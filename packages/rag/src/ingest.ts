import { createHash } from "node:crypto";
import {
  query,
  queryOne,
  requirePermission,
  tx,
  type TenantContext,
} from "@hd/core";
import { chunkDocument } from "./chunk.js";
import { embed, toVectorLiteral } from "./embed.js";

export interface IngestInput {
  title: string;
  content: string;
  origin: "runbook" | "vendor_doc" | "resolved_ticket";
  categories?: string[];
  sourceUrl?: string | null;
  /**
   * Chunk ids this document replaces. Set when a resolved ticket corrects a
   * runbook: the old chunks stay for audit but stop being retrievable.
   */
  supersedes?: string[];
}

export interface IngestResult {
  docId: string;
  chunks: number;
  skipped: boolean;
}

/**
 * Add a document to one tenant's knowledge base.
 *
 * The tenant comes from the context rather than the input object, so there is
 * no field a caller could set to file a runbook into somebody else's index —
 * which would be a data leak in the other direction, since the agent retrieves
 * from it into prompts.
 */
export async function ingestDocument(
  ctx: TenantContext,
  input: IngestInput,
): Promise<IngestResult> {
  requirePermission(ctx, "kb:create");
  const contentHash = createHash("sha256")
    .update(`${input.title}\n${input.content}`)
    .digest("hex");

  const existing = await queryOne<{ id: string }>(
    `select id from kb_documents where business_id = $1 and content_hash = $2`,
    [ctx.businessId, contentHash],
  );
  if (existing) return { docId: existing.id, chunks: 0, skipped: true };

  const chunks = chunkDocument(input.content);
  if (chunks.length === 0) throw new Error(`nothing to ingest for "${input.title}"`);

  const { vectors } = await embed(chunks.map((c) => c.content));
  const categories = input.categories ?? [];

  const docId = await tx(async (client) => {
    const doc = await client.query<{ id: string }>(
      `insert into kb_documents (business_id, title, source_url, origin, categories, content_hash)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [
        ctx.businessId,
        input.title,
        input.sourceUrl ?? null,
        input.origin,
        categories,
        contentHash,
      ],
    );
    const id = doc.rows[0]!.id;

    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        `insert into kb_chunks
           (business_id, doc_id, doc_title, source_url, origin, content, embedding, categories)
         values ($1, $2, $3, $4, $5, $6, $7::vector, $8)`,
        [
          ctx.businessId,
          id,
          input.title,
          input.sourceUrl ?? null,
          input.origin,
          chunks[i]!.content,
          toVectorLiteral(vectors[i]!),
          categories,
        ],
      );
    }

    if (input.supersedes?.length) {
      const replacement = await client.query<{ id: string }>(
        `select id from kb_chunks where doc_id = $1 order by created_at limit 1`,
        [id],
      );
      // Scoped, so a supersede list carrying another tenant's chunk ids
      // retires nothing rather than blanking their index.
      await client.query(
        `update kb_chunks set superseded_by = $2
          where id = any($1::uuid[]) and business_id = $3`,
        [input.supersedes, replacement.rows[0]!.id, ctx.businessId],
      );
    }

    return id;
  });

  return { docId, chunks: chunks.length, skipped: false };
}

export interface KbStats {
  origin: string;
  documents: number;
  chunks: number;
  superseded: number;
}

export interface KbDocumentRow {
  id: string;
  title: string;
  origin: string;
  categories: string[];
  created_at: Date;
  chunks: number;
  superseded: number;
}

/**
 * The tenant's documents, for the console listing.
 *
 * Lives here rather than as a raw query in the page it serves. A hand-written
 * `select` in a React component is scoped correctly right up until somebody
 * copies it into a second page and drops the predicate, and it is invisible to
 * any check that looks at the data layer.
 */
export async function listKbDocuments(
  ctx: TenantContext,
  limit = 200,
): Promise<KbDocumentRow[]> {
  requirePermission(ctx, "kb:read");
  return query<KbDocumentRow>(
    `select d.id, d.title, d.origin, d.categories, d.created_at,
            count(c.id)::int as chunks,
            count(c.id) filter (where c.superseded_by is not null)::int as superseded
       from kb_documents d
       left join kb_chunks c on c.doc_id = d.id
      where d.business_id = $1
      group by d.id
      order by d.created_at desc
      limit $2`,
    [ctx.businessId, limit],
  );
}

export async function kbStats(ctx: TenantContext): Promise<KbStats[]> {
  requirePermission(ctx, "kb:read");
  return query<KbStats>(
    `select origin,
            count(distinct doc_id)::int as documents,
            count(*)::int as chunks,
            count(*) filter (where superseded_by is not null)::int as superseded
       from kb_chunks
      where business_id = $1
      group by origin
      order by origin`,
    [ctx.businessId],
  );
}
