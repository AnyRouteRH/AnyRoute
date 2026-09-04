import type { Candidate, ModelRow } from "../catalog/catalog.ts";
import { mulBps, type Pico, tokenCost } from "../lib/money.ts";

export type Usage = {
  prompt: number;
  completion: number;
  reasoning: number;
  cachedRead: number;
  cacheWrite: number;
  webSearch: number;
  images: number;
  estimated: boolean;
};

export type Mode = "prepaid" | "per_call" | "paywith" | "byok" | "cache";

export type Cost = {
  upstream: Pico; // what the provider charges (0 for BYOK: the caller pays the provider directly)
  notional: Pico; // provider list price for this usage (used for BYOK fees and rankings)
  royalty: Pico;
  margin: Pico;
  cacheDiscount: Pico;
  total: Pico; // charged to the caller
};

export function readUsage(u: any, fallback?: { prompt: number; completion: number }): Usage {
  const has = u && (typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number" || typeof u.input_tokens === "number");
  const prompt = Number(u?.prompt_tokens ?? u?.input_tokens ?? fallback?.prompt ?? 0);
  const completion = Number(u?.completion_tokens ?? u?.output_tokens ?? fallback?.completion ?? 0);
  return {
    prompt: Math.max(0, Math.ceil(prompt)),
    completion: Math.max(0, Math.ceil(completion)),
    reasoning: Math.max(0, Number(u?.completion_tokens_details?.reasoning_tokens ?? u?.reasoning_tokens ?? 0)),
    cachedRead: Math.max(0, Number(u?.prompt_tokens_details?.cached_tokens ?? u?.cache_read_input_tokens ?? 0)),
    cacheWrite: Math.max(0, Number(u?.prompt_tokens_details?.cache_write_tokens ?? u?.cache_creation_input_tokens ?? 0)),
    webSearch: Math.max(0, Number(u?.server_tool_use?.web_search_requests ?? 0)),
    images: 0,
    estimated: !has,
  };
}

/** Provider list price for a usage record. */
export function upstreamCost(c: Candidate, u: Usage): { cost: Pico; cacheDiscount: Pico } {
  const cached = Math.min(u.cachedRead, u.prompt);
  const freshPrompt = u.prompt - cached - Math.min(u.cacheWrite, u.prompt - cached);
  const readPrice = c.priceCacheRead ?? c.pricePrompt;
  const writePrice = c.priceCacheWrite ?? c.pricePrompt;
  const writes = Math.min(u.cacheWrite, u.prompt - cached);
  const reasoning = c.priceReasoning > 0n ? Math.min(u.reasoning, u.completion) : 0;
  const cost =
    tokenCost(freshPrompt, c.pricePrompt) +
    tokenCost(cached, readPrice) +
    tokenCost(writes, writePrice) +
    tokenCost(u.completion - reasoning, c.priceCompletion) +
    tokenCost(reasoning, c.priceReasoning) +
    c.priceRequest +
    BigInt(u.webSearch) * c.priceWebSearch +
    BigInt(u.images) * c.priceImage;
  const cacheDiscount = readPrice < c.pricePrompt ? tokenCost(cached, c.pricePrompt - readPrice) : 0n;
  return { cost, cacheDiscount };
}
