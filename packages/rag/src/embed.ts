import { EMBEDDING_DIMS, env, recordUsage } from "@hd/core";

export interface EmbedResult {
  vectors: number[][];
  model: string;
  tokens: number;
}

/**
 * Embeddings are pluggable because the reasoning model and the retrieval
 * model are separate decisions. `hash` is a deterministic local embedder so
 * the whole pipeline runs in dev and in tests with no API key and no network;
 * it is real lexical similarity, not noise, but it is not semantic - do not
 * ship it.
 */
export async function embed(texts: string[]): Promise<EmbedResult> {
  if (texts.length === 0) return { vectors: [], model: env.EMBEDDING_PROVIDER, tokens: 0 };
  return env.EMBEDDING_PROVIDER === "openai"
    ? embedOpenAI(texts)
    : embedHash(texts);
}

export async function embedOne(text: string): Promise<number[]> {
  const { vectors } = await embed([text]);
  const v = vectors[0];
  if (!v) throw new Error("embedder returned no vector");
  return v;
}

/** Postgres vector literal: pgvector accepts '[0.1,0.2,...]' as text. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",")}]`;
}

// ---------------------------------------------------------------------------

async function embedOpenAI(texts: string[]): Promise<EmbedResult> {
  const key = env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is unset. Set the key or use EMBEDDING_PROVIDER=hash.",
    );
  }
  const started = Date.now();
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: env.EMBEDDING_MODEL,
      input: texts,
      dimensions: EMBEDDING_DIMS,
    }),
  });
  if (!res.ok) {
    throw new Error(`embedding request failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    data: { index: number; embedding: number[] }[];
    usage?: { total_tokens?: number };
  };
  const vectors = json.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
  const tokens = json.usage?.total_tokens ?? 0;

  await recordUsage({
    business_id: null,
    purpose: "embed",
    model: env.EMBEDDING_MODEL,
    tokens_in: tokens,
    tokens_out: 0,
    cost_usd: (tokens / 1_000_000) * 0.02,
    latency_ms: Date.now() - started,
  }).catch(() => {});

  return { vectors, model: env.EMBEDDING_MODEL, tokens };
}

function embedHash(texts: string[]): EmbedResult {
  return {
    vectors: texts.map(hashEmbedding),
    model: "hash",
    tokens: 0,
  };
}

/**
 * Hashed bag-of-words with sublinear term weighting, L2-normalised so cosine
 * distance behaves. Deterministic across processes: the same text always maps
 * to the same vector, which is what makes dev retrieval reproducible.
 */
function hashEmbedding(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMS).fill(0);
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s._-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));

  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  // Bigrams give the hash embedder a little word-order sensitivity.
  for (let i = 0; i + 1 < tokens.length; i++) {
    const bg = `${tokens[i]}_${tokens[i + 1]}`;
    counts.set(bg, (counts.get(bg) ?? 0) + 1);
  }

  for (const [term, count] of counts) {
    const weight = 1 + Math.log(count);
    const h = fnv1a(term);
    const idx = h % EMBEDDING_DIMS;
    const sign = (h >>> 31) % 2 === 0 ? 1 : -1;
    v[idx] = (v[idx] ?? 0) + sign * weight;
  }

  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) {
    v[0] = 1; // an all-stopword document still needs a unit vector
    return v;
  }
  return v.map((x) => x / norm);
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was",
  "one", "our", "out", "day", "get", "has", "him", "his", "how", "man", "new",
  "now", "old", "see", "two", "way", "who", "boy", "did", "its", "let", "put",
  "say", "she", "too", "use", "with", "this", "that", "have", "from", "they",
  "been", "will", "would", "there", "their", "what", "about", "when", "make",
  "like", "time", "just", "know", "take", "into", "your", "some", "them",
  "than", "then", "were", "does", "hi", "hello", "thanks", "regards", "please",
]);
