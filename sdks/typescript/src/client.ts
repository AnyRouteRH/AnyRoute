import {
  AnyRoute as CoreClient,
  routingHeaders,
  verifyReceiptV2,
  withRouting,
  type AnyRouteMeta,
  type ChatBody,
  type ChatResult,
  type ChatStream,
  type ClientOptions as CoreOptions,
  type DisclosureMax,
  type Fetch,
  type KeySet,
  type Lane,
  type ReceiptV2Verification,
  type ReceiptVerification,
  type RequestOptions as CoreRequestOptions,
  type VerifyReceiptV2Options,
} from "@anyroute/client";
import { AnyrouteAPIError, BatchTimeoutError, parseRetryAfter } from "./errors.js";
import { supportsLane } from "./lanes.js";
import {
  TERMINAL_BATCH_STATUSES,
  type Batch,
  type BatchList,
  type BatchResultLine,
  type CreateBatchParams,
  type EmbeddingsRequest,
  type EmbeddingsResponse,
  type Model,
  type Preset,
  type PresetDoc,
  type PresetVersion,
  type Receipt,
  type RerankRequest,
  type RerankResponse,
  type ResponseMeta,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://api-production-70da.up.railway.app";
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

export type AnyrouteOptions = {
  /** Router API key. Default: the ANYROUTE_API_KEY environment variable. */
  apiKey?: string;
  /** Router origin, with or without /api/v1. Default: ANYROUTE_BASE_URL, then the public router. */
  baseUrl?: string;
  /** Default lane for every request (header X-Anyroute-Lane and body provider.lane). */
  lane?: Lane;
  /** Default disclosure ceiling for every request. */
  disclosure?: DisclosureMax;
  headers?: Record<string, string>;
  fetch?: Fetch;
  /** Retries on 408, 409, 429 and 5xx, waiting for Retry-After when the router sends it. Default 2. */
  maxRetries?: number;
  /** Longest single wait between retries. Default 30 000 ms. */
  maxRetryDelayMs?: number;
  /** Check the signed receipt (v1 and, when present, v2) on every chat response. Default true. */
  verifyReceipts?: boolean;
  /** Throw when a chat receipt does not verify. Default false. */
  strictReceipts?: boolean;
  /** Pinned receipt keys: the well-known key set is then never fetched. */
  receiptKeys?: KeySet;
  /** Everything else @anyroute/client takes (transparency log, blind tokens, ed25519 verifier, clock). */
  core?: Partial<Omit<CoreOptions, "baseUrl" | "apiKey" | "fetch" | "lane" | "disclosure" | "headers" | "verifyReceipts" | "strictReceipts" | "receiptKeys">>;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
};

export type CallOptions = { lane?: Lane; disclosure?: DisclosureMax; headers?: Record<string, string>; signal?: AbortSignal };
export type ChatOptions = CoreRequestOptions;
export type ChatResponse = ChatResult & { anyroute: AnyRouteMeta & { receiptV2Verification: ReceiptV2Verification | null } };
export type WithMeta<T> = T & { anyroute: ResponseMeta };
export type ReceiptCheck = { valid: boolean; v1: ReceiptVerification | null; v2: ReceiptV2Verification | null };
export type ReceiptProof = { rid: string; leaf: string | null; leaf_version: 1 | 2; rooted: boolean; anchored: boolean; root?: string; proof?: string[]; status?: string; [k: string]: unknown };

const env = (name: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name] || undefined;
const origin = (u: string) => u.replace(/\/+$/, "").replace(/\/(api\/)?v1$/, "");
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The Anyroute SDK. Chat goes through @anyroute/client (receipt checks, attested lane, verify-before-send); the rest
 * of the API (embeddings, rerank, batches, presets, models, receipts) is plain JSON over the same fetch.
 */
export class Anyroute {
  readonly baseUrl: string;
  /** The underlying @anyroute/client instance: attestation, transparency log, blind tokens. */
  readonly core: CoreClient;
  private readonly opts: AnyrouteOptions;
  private readonly rawFetch: Fetch;
  private readonly apiKey: string | undefined;

  constructor(opts: AnyrouteOptions = {}) {
    this.opts = opts;
    this.apiKey = opts.apiKey ?? env("ANYROUTE_API_KEY");
    this.baseUrl = origin(opts.baseUrl ?? env("ANYROUTE_BASE_URL") ?? DEFAULT_BASE_URL);
    this.rawFetch = opts.fetch ?? ((...a: Parameters<Fetch>) => fetch(...a));
    this.core = new CoreClient({
      ...opts.core,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      fetch: (input, init) => this.send(String(input instanceof Request ? input.url : input), init),
      lane: opts.lane,
      disclosure: opts.disclosure,
      headers: opts.headers,
      verifyReceipts: opts.verifyReceipts,
      strictReceipts: opts.strictReceipts,
      receiptKeys: opts.receiptKeys,
    });
  }

  /** A copy of this client whose requests default to `lane` (and optionally a disclosure ceiling). */
  withLane(lane: Lane, disclosure?: DisclosureMax): Anyroute {
    return new Anyroute({ ...this.opts, apiKey: this.apiKey, baseUrl: this.baseUrl, lane, disclosure: disclosure ?? this.opts.disclosure });
  }

  // ---- transport --------------------------------------------------------------------------------------------------

  /** fetch with retries; a failed answer from the router's API becomes an {@link AnyrouteAPIError}. */
  private async send(url: string, init: RequestInit = {}): Promise<Response> {
    const api = url.startsWith(`${this.baseUrl}/api/v1/`) && !url.startsWith(`${this.baseUrl}/api/v1/attestation`);
    const max = this.opts.maxRetries ?? 2;
    const sleep = this.opts.sleep ?? defaultSleep;
    for (let attempt = 0; ; attempt++) {
      const res = await this.rawFetch(url, init);
      if (res.ok || !api) return res;
      if (attempt < max && RETRYABLE.has(res.status) && !init.signal?.aborted) {
        const hinted = parseRetryAfter(res.headers.get("retry-after"));
        const wait = Math.min(this.opts.maxRetryDelayMs ?? 30_000, hinted ?? 500 * 2 ** attempt);
        await res.body?.cancel().catch(() => {});
        await sleep(wait);
        continue;
      }
      throw await AnyrouteAPIError.fromResponse(res);
    }
  }

  private headers(o: CallOptions = {}, json = false): Record<string, string> {
    return {
      accept: "application/json",
      ...(json ? { "content-type": "application/json" } : {}),
      ...this.opts.headers,
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...routingHeaders({ lane: o.lane ?? this.opts.lane, disclosure: o.disclosure ?? this.opts.disclosure }),
      ...o.headers,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown, o: CallOptions = {}): Promise<{ json: T; res: Response }> {
    const res = await this.send(`${this.baseUrl}${path}`, { method, signal: o.signal, headers: this.headers(o, body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });
    return { json: (await res.json()) as T, res };
  }

  private async text(path: string, o: CallOptions = {}): Promise<string> {
    const res = await this.send(`${this.baseUrl}${path}`, { method: "GET", signal: o.signal, headers: { ...this.headers(o), accept: "application/jsonl, application/json, text/plain" } });
    return res.text();
  }

  /** Merge the lane and disclosure into body.provider without loosening a stricter value already there. */
  private routed<T extends Record<string, unknown>>(body: T, o: CallOptions): T {
    return withRouting(body, { lane: o.lane ?? this.opts.lane, disclosure: o.disclosure ?? this.opts.disclosure });
  }

  private meta(res: Response, receipt: Receipt | undefined | null): ResponseMeta {
    const h = res.headers;
    return {
      generationId: h.get("x-generation-id"),
      receiptId: h.get("x-receipt-id") ?? receipt?.id ?? null,
      lane: h.get("x-anyroute-lane"),
      disclosure: h.get("x-anyroute-disclosure"),
      policyHash: h.get("x-anyroute-policy-hash"),
      receipt: receipt ?? null,
    };
  }

  // ---- chat -------------------------------------------------------------------------------------------------------

  readonly chat = {
    completions: {
      /** POST /api/v1/chat/completions. The receipt is checked (v1 and v2) unless verifyReceipts is false. */
      create: async (body: ChatBody, o: ChatOptions = {}): Promise<ChatResponse> => {
        const r = await this.core.chat.completions.create(body, o);
        const receipt = r.anyroute.receipt as Receipt | null;
        const check = (o.verifyReceipt ?? this.opts.verifyReceipts ?? true) && receipt?.v2?.cose;
        const receiptV2Verification = check ? await verifyReceiptV2(receipt!.v2!.cose, { keys: await this.core.receiptKeys(), ed25519: this.opts.core?.ed25519 }) : null;
        return { ...r, anyroute: { ...r.anyroute, receiptV2Verification } };
      },
      /** Streamed chat. Iterate the chunks; then `meta()` has the receipt and `verifyChain()` checks the chunk chain. */
      stream: (body: ChatBody, o: ChatOptions = {}): Promise<ChatStream> => this.core.chat.completions.stream(body, o),
    },
  };

  // ---- embeddings and rerank --------------------------------------------------------------------------------------

  readonly embeddings = {
    /** POST /api/v1/embeddings. */
    create: async (body: EmbeddingsRequest, o: CallOptions = {}): Promise<WithMeta<EmbeddingsResponse>> => {
      const { json, res } = await this.request<EmbeddingsResponse>("POST", "/api/v1/embeddings", this.routed(body, o), o);
      return { ...json, anyroute: this.meta(res, json.receipt) };
    },
  };

  readonly rerank = {
    /** POST /api/v1/rerank: results best first, each with the index of the document it scores. */
    create: async (body: RerankRequest, o: CallOptions = {}): Promise<WithMeta<RerankResponse>> => {
      const { json, res } = await this.request<RerankResponse>("POST", "/api/v1/rerank", this.routed(body, o), o);
      return { ...json, anyroute: this.meta(res, json.receipt) };
    },
  };

  // ---- batches ----------------------------------------------------------------------------------------------------

  readonly batches = {
    /** Submit up to the router's line limit of chat or embeddings requests, run later at a discount. */
    create: async (params: CreateBatchParams, o: CallOptions = {}): Promise<Batch> => (await this.request<Batch>("POST", "/api/v1/batches", params, o)).json,
    retrieve: async (id: string, o: CallOptions = {}): Promise<Batch> => (await this.request<Batch>("GET", `/api/v1/batches/${encodeURIComponent(id)}`, undefined, o)).json,
    list: async (q: { limit?: number; after?: string } = {}, o: CallOptions = {}): Promise<BatchList> => {
      const qs = new URLSearchParams();
      if (q.limit) qs.set("limit", String(q.limit));
      if (q.after) qs.set("after", q.after);
      return (await this.request<BatchList>("GET", `/api/v1/batches${qs.size ? `?${qs}` : ""}`, undefined, o)).json;
    },
    cancel: async (id: string, o: CallOptions = {}): Promise<Batch> => (await this.request<Batch>("POST", `/api/v1/batches/${encodeURIComponent(id)}/cancel`, undefined, o)).json,
    /** Successful lines, parsed from JSONL. */
    output: async (id: string, o: CallOptions = {}): Promise<BatchResultLine[]> => parseJsonl(await this.text(`/api/v1/batches/${encodeURIComponent(id)}/output`, o)),
    /** Failed, cancelled and expired lines, parsed from JSONL. */
    errors: async (id: string, o: CallOptions = {}): Promise<BatchResultLine[]> => parseJsonl(await this.text(`/api/v1/batches/${encodeURIComponent(id)}/errors`, o)),
    /** Poll until the batch is completed, failed, expired or cancelled. */
    wait: async (id: string, w: { pollIntervalMs?: number; timeoutMs?: number; onPoll?: (b: Batch) => void; signal?: AbortSignal } = {}): Promise<Batch> => {
      const started = Date.now();
      const sleep = this.opts.sleep ?? defaultSleep;
      for (;;) {
        const b = await this.batches.retrieve(id, { signal: w.signal });
        w.onPoll?.(b);
        if (TERMINAL_BATCH_STATUSES.includes(b.status)) return b;
        if (w.timeoutMs != null && Date.now() - started >= w.timeoutMs) throw new BatchTimeoutError(id, b.status);
        await sleep(w.pollIntervalMs ?? 5_000);
      }
    },
    /** Wait for the batch, then return every line keyed by custom_id: `ok` holds answers, `failed` holds errors. */
    results: async (id: string, w: { pollIntervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}) => {
      const batch = await this.batches.wait(id, w);
      const [ok, failed] = await Promise.all([this.batches.output(id, { signal: w.signal }), batch.request_counts.failed || batch.status !== "completed" ? this.batches.errors(id, { signal: w.signal }) : Promise.resolve([])]);
      return { batch, ok, failed, byCustomId: new Map([...ok, ...failed].map((l) => [l.custom_id ?? l.id, l])) };
    },
  };

  // ---- presets ----------------------------------------------------------------------------------------------------

  readonly presets = {
    list: async (o: CallOptions = {}): Promise<Preset[]> => (await this.request<{ data: Preset[] }>("GET", "/api/v1/presets", undefined, o)).json.data,
    /** A preset, or one of its versions (3, "v3" or a hash prefix). */
    get: async (name: string, version?: number | string, o: CallOptions = {}): Promise<Preset & { latest_version: number }> =>
      (await this.request<{ data: Preset & { latest_version: number } }>("GET", `/api/v1/presets/${encodeURIComponent(name)}${version != null ? `?version=${encodeURIComponent(String(version))}` : ""}`, undefined, o)).json.data,
    /** Create or update. A new version is written only when the config changed (`changed`). */
    put: async (name: string, doc: PresetDoc, o: CallOptions = {}): Promise<Preset & { changed: boolean }> => (await this.request<{ data: Preset & { changed: boolean } }>("PUT", `/api/v1/presets/${encodeURIComponent(name)}`, doc, o)).json.data,
    delete: async (name: string, o: CallOptions = {}): Promise<{ name: string; model: string; deleted: boolean; versions: number }> => (await this.request<{ data: { name: string; model: string; deleted: boolean; versions: number } }>("DELETE", `/api/v1/presets/${encodeURIComponent(name)}`, undefined, o)).json.data,
    versions: async (name: string, o: CallOptions = {}): Promise<PresetVersion[]> => (await this.request<{ data: PresetVersion[] }>("GET", `/api/v1/presets/${encodeURIComponent(name)}/versions`, undefined, o)).json.data,
    diff: async (name: string, from: number | string, to: number | string, o: CallOptions = {}) =>
      (await this.request<{ data: { name: string; from: PresetVersion; to: PresetVersion; identical: boolean; changes: unknown[] } }>("GET", `/api/v1/presets/${encodeURIComponent(name)}/diff?from=${encodeURIComponent(String(from))}&to=${encodeURIComponent(String(to))}`, undefined, o)).json.data,
    rollback: async (name: string, version: number | string, o: CallOptions = {}): Promise<Preset & { changed: boolean; restored_from: number }> =>
      (await this.request<{ data: Preset & { changed: boolean; restored_from: number } }>("POST", `/api/v1/presets/${encodeURIComponent(name)}/rollback`, { version }, o)).json.data,
    /** The model string that runs a preset: "@preset/name" or "@preset/name@3". */
    model: (name: string, version?: number | string) => `@preset/${name}${version != null ? `@${version}` : ""}`,
  };

  // ---- models -----------------------------------------------------------------------------------------------------

  readonly models = {
    /** GET /api/v1/models, optionally only those servable on `lane` right now or with an output modality (e.g. "rerank"). */
    list: async (q: { lane?: Lane; outputModalities?: string; signal?: AbortSignal } = {}): Promise<Model[]> => {
      const qs = q.outputModalities ? `?output_modalities=${encodeURIComponent(q.outputModalities)}` : "";
      const { json } = await this.request<{ data: Model[] }>("GET", `/api/v1/models${qs}`, undefined, { signal: q.signal, lane: undefined });
      return q.lane ? json.data.filter((m) => supportsLane(m, q.lane!)) : json.data;
    },
    /** The live endpoints (providers) behind one model. */
    endpoints: async (id: string, o: CallOptions = {}) => (await this.request<{ data: Record<string, unknown> }>("GET", `/api/v1/models/${id.split("/").map(encodeURIComponent).join("/")}/endpoints`, undefined, o)).json.data,
  };

  // ---- receipts ---------------------------------------------------------------------------------------------------

  readonly receipts = {
    /** GET /api/v1/receipts/:id: the v1 envelope, the v2 COSE receipt beside it, and the anchor once rooted. */
    get: async (id: string, o: CallOptions = {}): Promise<Receipt & { version: 1 | 2; privacy?: unknown }> => (await this.request<{ data: Receipt & { version: 1 | 2 } }>("GET", `/api/v1/receipts/${encodeURIComponent(id)}`, undefined, o)).json.data,
    /** GET /api/v1/receipts/:id/proof: the Merkle path once the hour has been rooted. */
    proof: async (id: string, version?: 1 | 2, o: CallOptions = {}): Promise<ReceiptProof> => (await this.request<{ data: ReceiptProof }>("GET", `/api/v1/receipts/${encodeURIComponent(id)}/proof${version === 1 ? "?v=1" : ""}`, undefined, o)).json.data,
    /** The router's published receipt keys (cached). */
    keys: (refresh = false): Promise<KeySet> => this.core.receiptKeys(refresh),
    /**
     * Check a receipt offline against the router's keys: the v1 Ed25519 signature, and the v2 COSE_Sign1 when present
     * (with the streamed chunks, hashes and anchor proof when you pass them).
     */
    verify: async (receipt: Receipt, v2: Omit<VerifyReceiptV2Options, "keys" | "publicKeyHex"> = {}): Promise<ReceiptCheck> => {
      const v1 = receipt.sig && receipt.payload ? await this.core.verifyReceipt(receipt) : null;
      const cose = receipt.v2?.cose;
      const v2r = cose ? await verifyReceiptV2(cose, { ed25519: this.opts.core?.ed25519, ...v2, keys: await this.core.receiptKeys() }) : null;
      return { valid: !!(v1 || v2r) && (v1?.valid ?? true) && (v2r?.valid ?? true), v1, v2: v2r };
    },
    /** Fetch a receipt by id and its proof, then verify both. */
    fetchAndVerify: async (id: string): Promise<ReceiptCheck & { receipt: Receipt }> => {
      const receipt = await this.receipts.get(id);
      const p = receipt.v2?.cose ? await this.receipts.proof(id).catch(() => null) : null;
      const proof = p?.root && p.proof ? { root: p.root, proof: p.proof, anchored: p.anchored } : null;
      return { ...(await this.receipts.verify(receipt, { proof })), receipt };
    },
  };
}

export function parseJsonl<T = BatchResultLine>(text: string): T[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}
