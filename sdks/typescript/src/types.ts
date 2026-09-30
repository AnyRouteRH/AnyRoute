import type { Lane, ReceiptEnvelope } from "@anyroute/client";

/** Router receipt as returned inline: the v1 Ed25519 envelope, with the v2 COSE_Sign1 beside it when the router signs one. */
export type Receipt = ReceiptEnvelope & {
  anchor_hint?: string;
  v2?: { alg: string; kid: string; content_type?: string; cose: string; claims?: Record<string, unknown>; leaf?: string; anchor?: unknown } | null;
};

/** What the SDK reads off a response besides the body. */
export type ResponseMeta = {
  generationId: string | null;
  receiptId: string | null;
  lane: string | null;
  disclosure: string | null;
  policyHash: string | null;
  receipt: Receipt | null;
};

export type ProviderPrefs = {
  lane?: Lane;
  disclosure?: "any" | "policy" | "none";
  only?: string[];
  order?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
  sort?: "price" | "throughput" | "latency";
  [k: string]: unknown;
};

// ---- embeddings ---------------------------------------------------------------------------------------------------

export type EmbeddingsRequest = { model: string; input: string | string[] | number[] | number[][]; dimensions?: number; encoding_format?: "float" | "base64"; provider?: ProviderPrefs; [k: string]: unknown };
export type EmbeddingsResponse = {
  object: "list";
  model: string;
  data: Array<{ object: "embedding"; index: number; embedding: number[] | string }>;
  usage?: { prompt_tokens?: number; total_tokens?: number; [k: string]: unknown };
  receipt?: Receipt;
  [k: string]: unknown;
};

// ---- rerank -------------------------------------------------------------------------------------------------------

export type RerankRequest = { model: string; query: string; documents: Array<string | { text: string }>; top_n?: number; return_documents?: boolean; provider?: ProviderPrefs; [k: string]: unknown };
export type RerankResult = { index: number; relevance_score: number; document?: { text: string } | string };
export type RerankResponse = {
  id: string;
  model: string;
  results: RerankResult[];
  usage?: { total_tokens?: number; search_units?: number; cost?: number };
  cost?: number;
  receipt?: Receipt;
  [k: string]: unknown;
};

// ---- batches ------------------------------------------------------------------------------------------------------

export type BatchEndpoint = "/v1/chat/completions" | "/v1/embeddings";
export type BatchRequestLine = { custom_id: string; method?: "POST"; url: BatchEndpoint; body: Record<string, unknown> };
export type BatchStatus = "validating" | "in_progress" | "finalizing" | "completed" | "failed" | "expired" | "cancelling" | "cancelled";
export const TERMINAL_BATCH_STATUSES: readonly BatchStatus[] = ["completed", "failed", "expired", "cancelled"];

export type Batch = {
  id: string;
  object: "batch";
  endpoint: BatchEndpoint;
  status: BatchStatus;
  output_url: string;
  errors_url: string;
  created_at: number | null;
  in_progress_at: number | null;
  expires_at: number | null;
  completed_at: number | null;
  failed_at: number | null;
  expired_at: number | null;
  cancelled_at: number | null;
  request_counts: { total: number; completed: number; failed: number };
  cost: { usd: number; list_usd: number; discount_bps: number };
  results_expire_at: number | null;
  [k: string]: unknown;
};
export type BatchList = { object: "list"; data: Batch[]; first_id: string | null; last_id: string | null; has_more: boolean };
export type BatchResultLine = {
  id: string;
  custom_id: string | null;
  response: { status_code: number; request_id: string | null; body: any } | null;
  error: { code: string; message: string } | null;
};
export type CreateBatchParams = { requests: BatchRequestLine[]; endpoint?: BatchEndpoint; completion_window?: "24h"; metadata?: Record<string, string> } | { input_jsonl: string; endpoint?: BatchEndpoint; completion_window?: "24h"; metadata?: Record<string, string> };

// ---- presets ------------------------------------------------------------------------------------------------------

export type PresetDoc = {
  description?: string;
  models: string[];
  provider?: ProviderPrefs;
  params?: Record<string, unknown>;
  system_prompt?: string;
  response_format?: Record<string, unknown>;
  tools?: unknown[];
  tool_choice?: unknown;
};
export type Preset = { name: string; model: string; description: string; version: number; hash: string; config: PresetDoc; created_at: string; updated_at: string; [k: string]: unknown };
export type PresetVersion = { version: number; hash: string; model: string; source: "put" | "rollback"; restored_from?: number; created_at: string };

// ---- models -------------------------------------------------------------------------------------------------------

export type Model = {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: Record<string, string | number>;
  architecture?: { input_modalities?: string[]; output_modalities?: string[]; [k: string]: unknown };
  /** Lanes the model can be served on right now. */
  lanes: Lane[];
  attested_available?: boolean;
  attestation?: { best: string; manifest_ref: unknown; exec_profile_id: string | null; policy_hash: string | null } | null;
  disclosure?: { best: string | null; endpoints: Record<string, number> };
  routing_variants?: string[];
  [k: string]: unknown;
};
