import { fail } from "../lib/errors.ts";

// Rerank requests (POST /api/v1/rerank) in the Cohere / Jina shape, and what a provider's /rerank answer must look
// like before the router passes it on. A provider answer that is not a valid ranking of the documents sent is a failed
// attempt: the router never makes up, fills in or reorders scores it did not get from the provider.

export const MAX_RERANK_DOCUMENTS = 1000;
/** Cohere's unit: one query over up to 100 documents, each document split into chunks of 500 tokens (query included). */
export const DOCS_PER_SEARCH_UNIT = 100;
export const TOKENS_PER_CHUNK = 500;

export type RerankRequest = { model: string; query: string; documents: string[]; topN: number; returnDocuments: boolean };
export type RerankResult = { index: number; relevance_score: number; document?: { text: string } };

/** Validate a rerank body. Documents may be strings or `{ text }` objects; top_n defaults to every document. */
export function parseRerankRequest(body: Record<string, unknown>): RerankRequest {
  if (typeof body.model !== "string" || !body.model) fail(400, "`model` is required.", "invalid_request");
  if (typeof body.query !== "string" || !body.query.trim()) fail(400, "`query` must be a non-empty string.", "invalid_request");
  const docs = body.documents;
  if (!Array.isArray(docs) || docs.length === 0 || docs.length > MAX_RERANK_DOCUMENTS)
    fail(400, `\`documents\` must be a non-empty array of at most ${MAX_RERANK_DOCUMENTS} strings or { text } objects.`, "invalid_request");
  const documents = docs.map((d, i) => {
    if (typeof d === "string") return d;
    if (d && typeof d === "object" && !Array.isArray(d) && typeof (d as { text?: unknown }).text === "string") return (d as { text: string }).text;
    return fail(400, `\`documents[${i}]\` must be a string or an object with a string \`text\`.`, "invalid_request");
  });
  const topN = body.top_n;
  if (topN != null && (!Number.isInteger(topN) || (topN as number) < 1)) fail(400, "`top_n` must be a positive integer.", "invalid_request");
  if (body.return_documents != null && typeof body.return_documents !== "boolean") fail(400, "`return_documents` must be a boolean.", "invalid_request");
  return { model: body.model, query: body.query, documents, topN: Math.min((topN as number | undefined) ?? documents.length, documents.length), returnDocuments: body.return_documents === true };
}

const tokensOf = (s: string) => Math.ceil(s.length / 3);

/**
 * Conservative estimates for the hold and for a provider that reports no usage: tokens as every (query, document)
 * pair read in full, and search units as Cohere counts them (documents split into 500-token chunks, 100 chunks a unit).
 */
export function estimateRerank(r: Pick<RerankRequest, "query" | "documents">): { tokens: number; searchUnits: number } {
  const q = tokensOf(r.query);
  let tokens = 8;
  let chunks = 0;
  for (const d of r.documents) {
    const pair = q + tokensOf(d);
    tokens += pair;
    chunks += Math.max(1, Math.ceil(pair / TOKENS_PER_CHUNK));
  }
  return { tokens, searchUnits: Math.max(1, Math.ceil(chunks / DOCS_PER_SEARCH_UNIT)) };
}

/** The body sent upstream: the fields every Cohere-, Jina- or OpenAI-compatible /rerank accepts. Documents go as strings. */
export function upstreamRerankBody(providerModelId: string, r: RerankRequest) {
  return { model: providerModelId, query: r.query, documents: r.documents, top_n: r.topN };
}

/**
 * A provider's ranking, checked: every result names a document that was sent (once) and carries a finite score
 * (`relevance_score`, or `score` as some servers name it). Returned best first (ties by index), cut to top_n, with
 * the caller's own document text attached when asked. null when the answer is not a usable ranking.
 */
export function readRerankResults(json: unknown, r: RerankRequest): RerankResult[] | null {
  const list = Array.isArray(json) ? json : (json as { results?: unknown; data?: unknown } | null)?.results ?? (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(list) || list.length === 0) return null;
  const seen = new Set<number>();
  const out: RerankResult[] = [];
  for (const item of list) {
    const index = (item as { index?: unknown })?.index;
    const raw = (item as { relevance_score?: unknown; score?: unknown })?.relevance_score ?? (item as { score?: unknown })?.score;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= r.documents.length || seen.has(index as number)) return null;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
    seen.add(index as number);
    out.push({ index: index as number, relevance_score: raw });
  }
  out.sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index);
  return out.slice(0, r.topN).map((x) => (r.returnDocuments ? { ...x, document: { text: r.documents[x.index] } } : x));
}

/** Usage as the provider reported it: tokens (usage.total_tokens / prompt_tokens / input_tokens) and search units (Cohere's meta.billed_units, or usage.search_units). */
export function readRerankUsage(json: unknown): { tokens: number | null; searchUnits: number | null } {
  const j = (json ?? {}) as { usage?: Record<string, unknown>; meta?: { billed_units?: Record<string, unknown> } };
  const num = (...vs: unknown[]) => {
    for (const v of vs) if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.ceil(v);
    return null;
  };
  const billed = j.meta?.billed_units ?? {};
  return {
    tokens: num(j.usage?.total_tokens, j.usage?.prompt_tokens, j.usage?.input_tokens, billed.input_tokens),
    searchUnits: num(billed.search_units, j.usage?.search_units),
  };
}
