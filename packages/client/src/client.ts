import { verifyProvider, fetchRouterAttestation, type AttestFetcher, type ExpectedDigests, type ProviderVerification, type QuoteVerifier, type RouterAttestation } from "./attestation.js";
import type { Ed25519Verifier } from "./ed25519.js";
import { AnyRouteError, AttestationRefused, ReceiptInvalid } from "./errors.js";
import { routingHeaders, withRouting, type DisclosureMax, type Lane } from "./options.js";
import { fetchReceiptKeys, verifyReceipt, type ReceiptVerification } from "./receipts.js";
import type { Fetch, KeySet, ReceiptEnvelope } from "./types.js";

export type ClientOptions = {
  /** The router's base URL, for example https://router.example (the /api/v1 prefix is added). */
  baseUrl: string;
  /** A router API key, sent as `Authorization: Bearer`. */
  apiKey?: string;
  /** A finished blind token, sent as `Authorization: PrivateToken token=...`. Takes the place of the API key on chat. */
  privateToken?: string;
  fetch?: Fetch;
  headers?: Record<string, string>;
  /** Default disclosure ceiling for every request. A per-request option can only tighten it. */
  disclosure?: DisclosureMax;
  /** Default lane for every request. */
  lane?: Lane;
  /** Check the signed receipt on every response (default true). The result is on `response.anyroute.receipt`. */
  verifyReceipts?: boolean;
  /** Throw {@link ReceiptInvalid} when a receipt does not verify, instead of only reporting it. Default false. */
  strictReceipts?: boolean;
  /** Pinned router receipt keys. When set, the well-known key set is never fetched. */
  receiptKeys?: KeySet;
  ed25519?: Ed25519Verifier;
  /** Clock used for freshness checks (milliseconds). Defaults to Date.now; set it only to replay recorded evidence. */
  now?: () => number;
};

export type AttestedOptions = {
  providerId: string;
  /** The provider's /attest URL (or base URL). Required: the router's word alone is not enough to send. */
  attestUrl: string;
  expected?: ExpectedDigests;
  freshNonce?: boolean;
  allowSimulated?: boolean;
  requireCertificate?: boolean;
  maxAttestationAgeMs?: number;
  certificate?: Uint8Array | string;
  quoteVerifier?: QuoteVerifier;
  /** How long a passing verification is reused before the provider is checked again. Default 60 000 ms; 0 disables caching. */
  cacheMs?: number;
  /** Read the connection's certificate too (see `nodeAttestFetcher` in @anyroute/client/node). */
  attestFetcher?: AttestFetcher;
};

export type RequestOptions = {
  disclosure?: DisclosureMax;
  lane?: Lane;
  /** Verify the provider first, then pin the request to it (`provider.only`, no fallbacks, lane "attested"). */
  attested?: AttestedOptions;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  verifyReceipt?: boolean;
};

/** What the client adds to a response. */
export type AnyRouteMeta = {
  generationId: string | null;
  /** The class the request was served under, from X-Anyroute-Disclosure: attested, policy or vendor-forwarded. */
  disclosure: string | null;
  lane: string | null;
  receipt: ReceiptEnvelope | null;
  /** null when receipts are not verified or the response carried none. */
  receiptVerification: ReceiptVerification | null;
  /** The provider check that ran before this request was sent, when `attested` was used. */
  provider: ProviderVerification | null;
  /** Set when the receipt names a provider other than the verified one. */
  servedByVerifiedProvider: boolean | null;
};

export type ChatBody = { model: string; messages: unknown[]; stream?: boolean; provider?: Record<string, unknown>; [k: string]: unknown };
export type ChatCompletion = { id?: string; model?: string; choices?: unknown[]; usage?: Record<string, unknown>; receipt?: ReceiptEnvelope; [k: string]: unknown };
export type ChatResult = ChatCompletion & { anyroute: AnyRouteMeta };

export class AnyRoute {
  readonly baseUrl: string;
  private readonly f: Fetch;
  private keys: KeySet | null;
  private keyFetch: Promise<KeySet> | null = null;
  private verified = new Map<string, { at: number; v: ProviderVerification }>();

  constructor(private readonly opts: ClientOptions) {
    if (!opts?.baseUrl) throw new AnyRouteError("baseUrl is required", "bad_options");
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.f = opts.fetch ?? ((...a: Parameters<Fetch>) => fetch(...a));
    this.keys = opts.receiptKeys ?? null;
  }

  /** A copy that authenticates with a blind token (see buyTokens in @anyroute/client/blind) instead of an API key. */
  withPrivateToken(token: string): AnyRoute {
    return new AnyRoute({ ...this.opts, apiKey: undefined, privateToken: token });
  }

  private authHeaders(): Record<string, string> {
    if (this.opts.privateToken) return { authorization: `PrivateToken token=${this.opts.privateToken}` };
    if (this.opts.apiKey) return { authorization: `Bearer ${this.opts.apiKey}` };
    return {};
  }

  // ---- receipts ---------------------------------------------------------------------------------------------------

  /** The router's published receipt keys, fetched once and reused. */
  async receiptKeys(refresh = false): Promise<KeySet> {
    if (this.keys && !refresh && !this.opts.receiptKeys) return this.keys;
    if (this.opts.receiptKeys) return this.opts.receiptKeys;
    this.keyFetch ??= fetchReceiptKeys(this.baseUrl, this.f).finally(() => (this.keyFetch = null));
    return (this.keys = await this.keyFetch);
  }

  /** Verify a receipt against the router's keys, re-reading the key set once when the key id is unknown (key rotation). */
  async verifyReceipt(receipt: ReceiptEnvelope): Promise<ReceiptVerification> {
    let keys = await this.receiptKeys();
    if (!keys.keys.some((k) => k.kid === receipt?.key_id) && !this.opts.receiptKeys) keys = await this.receiptKeys(true);
    return verifyReceipt(receipt, { keys, ed25519: this.opts.ed25519 });
  }

  /** GET /api/v1/receipts/:id, including its anchor proof once the receipt has been anchored. */
  async getReceipt(id: string, signal?: AbortSignal): Promise<ReceiptEnvelope> {
    const res = await this.f(`${this.baseUrl}/api/v1/receipts/${encodeURIComponent(id)}`, { signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new AnyRouteError(`receipt lookup failed with ${res.status}`, "receipt_lookup_failed", res.status);
    return ((await res.json()) as { data: ReceiptEnvelope }).data;
  }

  // ---- attestation ------------------------------------------------------------------------------------------------

  /** What the router says it has verified about a provider. */
  attestation(providerId: string, signal?: AbortSignal): Promise<RouterAttestation | null> {
    return fetchRouterAttestation(this.baseUrl, providerId, this.f, signal);
  }

  /** Check a provider now (no caching). Never throws for a bad provider: read `.ok` and `.checks`. */
  verifyProvider(o: AttestedOptions & { signal?: AbortSignal }): Promise<ProviderVerification> {
    return verifyProvider({ routerUrl: this.baseUrl, fetch: this.f, now: this.opts.now, ...o });
  }

  private async attest(o: AttestedOptions, signal?: AbortSignal): Promise<ProviderVerification> {
    const ttl = o.cacheMs ?? 60_000;
    const key = `${o.providerId}|${o.attestUrl}`;
    const hit = this.verified.get(key);
    const clock = this.opts.now ?? Date.now;
    if (hit && ttl > 0 && clock() - hit.at < ttl) return hit.v;
    const v = await this.verifyProvider({ ...o, signal });
    if (v.ok) this.verified.set(key, { at: clock(), v });
    else this.verified.delete(key);
    if (!v.ok) throw new AttestationRefused(v);
    return v;
  }

  // ---- chat -------------------------------------------------------------------------------------------------------

  private async prepare(body: ChatBody, o: RequestOptions) {
    const disclosure = o.disclosure ?? this.opts.disclosure;
    const lane = o.lane ?? this.opts.lane;
    let provider: ProviderVerification | null = null;
    let routed = withRouting(body, { disclosure, lane });
    let headers: Record<string, string> = { ...routingHeaders({ disclosure, lane }) };
    if (o.attested) {
      // Nothing has been sent yet. A provider that does not verify ends the call here.
      provider = await this.attest(o.attested, o.signal);
      routed = withRouting(routed, { disclosure: "none", lane: "attested", only: [o.attested.providerId], allowFallbacks: false });
      headers = { ...headers, ...routingHeaders({ disclosure: "none", lane: "attested" }) };
    }
    return { routed, headers, provider };
  }

  private async finish(res: Response, receipt: ReceiptEnvelope | null, provider: ProviderVerification | null, o: RequestOptions): Promise<AnyRouteMeta> {
    let receiptVerification: ReceiptVerification | null = null;
    if (receipt && (o.verifyReceipt ?? this.opts.verifyReceipts ?? true)) {
      receiptVerification = await this.verifyReceipt(receipt);
      if (!receiptVerification.valid && this.opts.strictReceipts) throw new ReceiptInvalid(receiptVerification);
    }
    return {
      generationId: res.headers.get("x-generation-id"),
      disclosure: res.headers.get("x-anyroute-disclosure"),
      lane: res.headers.get("x-anyroute-lane"),
      receipt,
      receiptVerification,
      provider,
      servedByVerifiedProvider: provider && receipt ? receipt.payload?.provider === provider.providerId : null,
    };
  }

  private async post(path: string, body: unknown, headers: Record<string, string>, o: RequestOptions): Promise<Response> {
    return this.f(`${this.baseUrl}${path}`, {
      method: "POST",
      signal: o.signal,
      headers: { "content-type": "application/json", ...this.opts.headers, ...this.authHeaders(), ...headers, ...o.headers },
      body: JSON.stringify(body),
    });
  }

  readonly chat = {
    completions: {
      /** POST /api/v1/chat/completions (non-streaming). */
      create: async (body: ChatBody, o: RequestOptions = {}): Promise<ChatResult> => {
        if (body.stream) throw new AnyRouteError("Use chat.completions.stream() for streaming requests.", "bad_options");
        const { routed, headers, provider } = await this.prepare(body, o);
        const res = await this.post("/api/v1/chat/completions", routed, headers, o);
        const json = (await res.json().catch(() => null)) as (ChatCompletion & { error?: { message?: string; type?: string; metadata?: unknown } }) | null;
        if (!res.ok || !json) throw new AnyRouteError(json?.error?.message ?? `chat request failed with ${res.status}`, json?.error?.type ?? "request_failed", res.status, json?.error?.metadata);
        const meta = await this.finish(res, json.receipt ?? null, provider, o);
        return { ...json, anyroute: meta };
      },
      /**
       * POST with stream: true. Iterate for the parsed chunks; `meta()` resolves after the stream ends with the
       * receipt (sent as the last event) and its verification.
       */
      stream: async (body: ChatBody, o: RequestOptions = {}): Promise<ChatStream> => {
        const { routed, headers, provider } = await this.prepare({ ...body, stream: true }, o);
        const res = await this.post("/api/v1/chat/completions", routed, headers, o);
        if (!res.ok || !res.body) {
          const json = (await res.json().catch(() => null)) as { error?: { message?: string; type?: string; metadata?: unknown } } | null;
          throw new AnyRouteError(json?.error?.message ?? `chat request failed with ${res.status}`, json?.error?.type ?? "request_failed", res.status, json?.error?.metadata);
        }
        return new ChatStream(res, (receipt) => this.finish(res, receipt, provider, o));
      },
    },
  };

  async models(signal?: AbortSignal): Promise<{ data: Array<Record<string, unknown>> }> {
    const res = await this.f(`${this.baseUrl}/api/v1/models`, { signal, headers: { ...this.authHeaders(), accept: "application/json" } });
    if (!res.ok) throw new AnyRouteError(`models request failed with ${res.status}`, "request_failed", res.status);
    return (await res.json()) as { data: Array<Record<string, unknown>> };
  }
}

/** Server-sent events from a streamed completion. */
export class ChatStream implements AsyncIterable<Record<string, unknown>> {
  private receipt: ReceiptEnvelope | null = null;
  private resolveMeta!: (m: AnyRouteMeta) => void;
  private rejectMeta!: (e: unknown) => void;
  private readonly metaPromise: Promise<AnyRouteMeta>;

  constructor(
    private readonly res: Response,
    private readonly finish: (receipt: ReceiptEnvelope | null) => Promise<AnyRouteMeta>,
  ) {
    this.metaPromise = new Promise((resolve, reject) => {
      this.resolveMeta = resolve;
      this.rejectMeta = reject;
    });
    this.metaPromise.catch(() => {}); // a caller that only iterates should not get an unhandled rejection
  }

  meta(): Promise<AnyRouteMeta> {
    return this.metaPromise;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>> {
    const reader = this.res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (;;) {
          const cut = buf.search(/\r?\n\r?\n/);
          if (cut < 0) break;
          const block = buf.slice(0, cut);
          buf = buf.slice(cut).replace(/^\r?\n\r?\n/, "");
          const data = block
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!data || data === "[DONE]") continue;
          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          if (chunk.receipt && typeof chunk.receipt === "object") this.receipt = chunk.receipt as ReceiptEnvelope;
          yield chunk;
        }
      }
      this.resolveMeta(await this.finish(this.receipt));
    } catch (e) {
      this.rejectMeta(e);
      throw e;
    } finally {
      reader.releaseLock();
    }
  }
}
