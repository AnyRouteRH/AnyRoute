import { toChatRequest } from "../../../src/anthropic/convert.ts";
import { estimatePromptTokens } from "../../../src/router/estimate.ts";
import { mulBps, usdToPico } from "../../../src/lib/money.ts";
import type { TorFetch } from "./tor.ts";

/** Use the same conversion and estimator as the router, including tools, tool results and images. No I/O. */
export function countMessageTokens(body: Record<string, unknown>) {
  return estimatePromptTokens(toChatRequest(body, { countOnly: true }).body);
}

/** Prices stay only in memory for one minute, and every refresh goes through the supplied Tor transport. */
export function messageBudget(fetchOverTor: TorFetch, onion: string) {
  let cached: { until: number; rows: Record<string, any>[] } | null = null;
  let pending: Promise<Record<string, any>[]> | null = null;
  const rows = async (signal: AbortSignal) => {
    if (cached && cached.until > Date.now()) return cached.rows;
    if (!pending) {
      pending = (async () => {
        const res = await fetchOverTor(`http://${onion}/api/v1/models?lane=unlinkable`, { headers: { accept: "application/json" }, signal });
        if (!res.ok) throw new Error(`Model prices could not be read (${res.status}). No tokens were leased.`);
        const json = await res.json() as { data?: Record<string, any>[] };
        if (!Array.isArray(json.data)) throw new Error("The model directory is invalid.");
        cached = { until: Date.now() + 60_000, rows: json.data };
        return json.data;
      })().finally(() => { pending = null; });
    }
    return pending;
  };
  return async (body: Record<string, unknown>, signal: AbortSignal): Promise<bigint> => {
    // Validate before any network or token lease. Keep the un-clamped max_tokens for a conservative estimate.
    const conv = toChatRequest(body);
    const input = estimatePromptTokens(conv.body);
    const model = (await rows(signal)).find((row) => row.id === body.model);
    if (!model) throw new Error("Choose an attested model from GET /v1/models. No tokens were leased.");
    const price = (field: string) => {
      const raw = model.pricing?.[field];
      if (typeof raw !== "string" && typeof raw !== "number") throw new Error(`Model ${field} price is unavailable. No tokens were leased.`);
      const value = usdToPico(raw);
      if (value < 0n) throw new Error("Model prices must be nonnegative.");
      return value;
    };
    const outputPrice = price("completion");
    const reasoningPrice = model.pricing?.internal_reasoning == null ? outputPrice : price("internal_reasoning");
    const base = BigInt(input) * price("prompt") + BigInt(conv.body.max_tokens as number) * (reasoningPrice > outputPrice ? reasoningPrice : outputPrice) + price("request");
    const royalty = Number(model.royalty_bps ?? 0);
    if (!Number.isInteger(royalty) || royalty < 0 || royalty > 10_000) throw new Error("Invalid model royalty.");
    return base + mulBps(base, royalty);
  };
}
