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
  holderDiscount: Pico; // fee saved by an $ANYR holder tier (already taken off margin)
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

/** `discountBps` ($ANYR holder tier) lowers Anyroute's own fee rates, never below 0: upstream cost and
 *  royalties are never discounted, so a caller never pays less than the provider's cost. */
export type Fees = { royaltyBps: number; perCallMarginBps: number; byokFeeBps: number; discountBps?: number };

export function priceUsage(c: Candidate, model: ModelRow, u: Usage, mode: Mode, fees: Fees, byok: boolean): Cost {
  const { cost: notional, cacheDiscount } = upstreamCost(c, u);
  const upstream = byok ? 0n : notional;
  const royalty = model.creator && model.royaltyBps > 0 ? mulBps(notional, model.royaltyBps) : 0n;
  const marginAt = (off: number) =>
    (mode === "per_call" ? mulBps(upstream + royalty, Math.max(0, fees.perCallMarginBps - off)) : 0n) + (byok ? mulBps(notional, Math.max(0, fees.byokFeeBps - off)) : 0n);
  const off = Math.max(0, fees.discountBps ?? 0);
  const margin = marginAt(off);
  // What the discount saved: the margin at full rates minus the margin charged (0 when no margin applies).
  const holderDiscount = off ? marginAt(0) - margin : 0n;
  return { upstream, notional, royalty, margin, cacheDiscount, holderDiscount, total: upstream + royalty + margin };
}

/** Conservative prompt-token estimate used only for holds and context checks. */
export function estimatePromptTokens(body: Record<string, unknown>): number {
  const messages = Array.isArray(body.messages) ? (body.messages as any[]) : [];
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    if (typeof m?.content === "string") chars += m.content.length;
    else if (Array.isArray(m?.content))
      for (const p of m.content) {
        if (p?.type === "text") chars += String(p.text ?? "").length;
        else if (p?.type === "image_url") images++;
        else chars += JSON.stringify(p ?? "").length;
      }
    chars += 16;
    if (m?.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  if (typeof body.prompt === "string") chars += body.prompt.length;
  if (body.tools) chars += JSON.stringify(body.tools).length;
  if (body.response_format) chars += JSON.stringify(body.response_format).length;
  return Math.ceil(chars / 3) + images * 1_600 + 8;
}

export function maxOutputTokens(body: Record<string, unknown>, c: Candidate, model: ModelRow, promptTokens: number) {
  const asked = Number(body.max_completion_tokens ?? body.max_tokens ?? 0);
  const ctx = c.ctx ?? model.ctx;
  const cap = c.maxOut ?? model.maxOut ?? Math.max(1, Math.min(ctx - promptTokens, 16_384));
  const room = Math.max(1, ctx - promptTokens);
  return Math.max(1, Math.min(asked > 0 ? asked : cap, cap, room));
}

/** Worst-case charge for a request on a candidate: the hold amount. */
export function worstCase(c: Candidate, model: ModelRow, body: Record<string, unknown>, promptTokens: number, mode: Mode, fees: Fees, byok: boolean): Pico {
  // n / best_of multiply the generated output (providers bill every choice).
  const choices = Math.max(1, Number(body.n ?? 1), Number(body.best_of ?? 1));
  const out = maxOutputTokens(body, c, model, promptTokens) * choices;
  const usage: Usage = { prompt: promptTokens, completion: out, reasoning: c.priceReasoning > c.priceCompletion ? out : 0, cachedRead: 0, cacheWrite: 0, webSearch: 0, images: 0, estimated: true };
  return priceUsage(c, model, usage, mode, fees, byok).total;
}
