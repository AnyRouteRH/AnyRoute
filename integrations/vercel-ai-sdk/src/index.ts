// SPDX-License-Identifier: Apache-2.0
// Anyroute provider for the Vercel AI SDK. Anyroute speaks the OpenAI chat, completion and embeddings API, so this
// is the SDK's own OpenAI-compatible provider with Anyroute's defaults: the router URL, the key read from
// ANYROUTE_API_KEY when a request is made (not at import), the attested lane as an option, and the signed
// receipt of every call surfaced as provider metadata.
import { createOpenAICompatible, type MetadataExtractor, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { type FetchFunction, loadApiKey, loadOptionalSetting, withoutTrailingSlash } from "@ai-sdk/provider-utils";

/** The public Anyroute router. Point `baseURL` elsewhere to use a self-hosted router. */
export const ANYROUTE_BASE_URL = "https://api-production-70da.up.railway.app/api/v1";

/** Any id from GET /api/v1/models, e.g. "meta-llama/llama-3.3-70b-instruct" or "z-ai/glm-5.3". */
export type AnyrouteModelId = string & {};

export interface AnyrouteProviderSettings {
  /** Anyroute API key (sk-ar-v1-...). Defaults to the ANYROUTE_API_KEY environment variable, read per request. */
  apiKey?: string;
  /** Router base URL including /api/v1. Defaults to ANYROUTE_BASE_URL, then the public router. */
  baseURL?: string;
  /**
   * "attested" sends every call only to providers whose enclave the router has verified, and makes the router
   * refuse (sending nothing, charging nothing) when none can answer. Sent as the X-Anyroute-Lane header.
   */
  lane?: "public" | "attested";
  /** Extra headers for every request. */
  headers?: Record<string, string>;
  /** Custom fetch, for tests or middleware. */
  fetch?: FetchFunction;
}

/** What `providerMetadata.anyroute` carries on a response: the receipt id to verify later, and the billed cost. */
export type AnyrouteMetadata = { receiptId?: string; receiptKeyId?: string; costUsd?: number };

const pick = (body: unknown): AnyrouteMetadata => {
  const b = (body ?? {}) as { receipt?: { id?: unknown; key_id?: unknown }; usage?: { cost?: unknown } };
  const out: AnyrouteMetadata = {};
  if (typeof b.receipt?.id === "string") out.receiptId = b.receipt.id;
  if (typeof b.receipt?.key_id === "string") out.receiptKeyId = b.receipt.key_id;
  if (typeof b.usage?.cost === "number") out.costUsd = b.usage.cost;
  return out;
};

const asMetadata = (m: AnyrouteMetadata) => (Object.keys(m).length ? { anyroute: { ...m } } : undefined);

/** Lifts `receipt` and `usage.cost` from Anyroute responses (and from the stream chunks that carry them). */
export const anyrouteMetadata: MetadataExtractor = {
  extractMetadata: async ({ parsedBody }) => asMetadata(pick(parsedBody)),
  createStreamExtractor: () => {
    let seen: AnyrouteMetadata = {};
    return {
      processChunk: (chunk) => {
        seen = { ...seen, ...pick(chunk) };
      },
      buildMetadata: () => asMetadata(seen),
    };
  },
};

export type AnyrouteProvider = OpenAICompatibleProvider<AnyrouteModelId, AnyrouteModelId, AnyrouteModelId, AnyrouteModelId>;

/** Create an Anyroute provider. `anyroute("<model id>")` returns a chat model. */
export function createAnyroute(options: AnyrouteProviderSettings = {}): AnyrouteProvider {
  const baseURL = withoutTrailingSlash(loadOptionalSetting({ settingValue: options.baseURL, environmentVariableName: "ANYROUTE_BASE_URL" })) ?? ANYROUTE_BASE_URL;
  const send = options.fetch ?? globalThis.fetch;
  // The key is resolved when a request is sent, so the default `anyroute` export works however late the
  // environment is loaded, and a missing key fails the call with a clear message instead of the import.
  const withKey: FetchFunction = (input, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("authorization")) {
      const key = loadApiKey({ apiKey: options.apiKey, environmentVariableName: "ANYROUTE_API_KEY", description: "Anyroute" });
      headers.set("authorization", `Bearer ${key}`);
    }
    return send(input, { ...init, headers });
  };
  return createOpenAICompatible<AnyrouteModelId, AnyrouteModelId, AnyrouteModelId, AnyrouteModelId>({
    name: "anyroute",
    baseURL,
    headers: { ...(options.lane && options.lane !== "public" ? { "X-Anyroute-Lane": options.lane } : {}), ...options.headers },
    fetch: withKey,
    includeUsage: true,
    supportsStructuredOutputs: true,
    metadataExtractor: anyrouteMetadata,
  });
}

/** The default provider: the public router, key from ANYROUTE_API_KEY. */
export const anyroute = createAnyroute();
