import type { Evidence, ExternalDoc, RedisFamily, TableDoc } from "./types.ts";
import { CREATED, JSON_FIELDS, UPDATED, rv } from "./tables/common.ts";
// The window plus one second, as RedisRateLimiter.take sets it (the same wording as outside.ts windowTtl).
const windowTtl = (s: number) => `${(s + 1).toLocaleString("en-US")} seconds (the ${s.toLocaleString("en-US")}-second window plus one second)`;

// v6 T: the paid tool market (src/tools). Tool calls are billing records with hashes and amounts; the tool's answer and
// the caller's tool arguments pass through router memory and are never stored.

const ev = (file: string, contains: string): Evidence => ({ file, contains });
const RL = [ev("src/lib/ratelimit.ts", "const k = `rl:${key}:${start}`;"), ev("src/lib/ratelimit.ts", "await this.redis.pexpire(k, windowMs + 1000);")];

export const toolTables: Record<string, TableDoc> = {
  tool_listings: {
    category: "operations",
    purpose: "x402 tools a seller account listed for the paid tool catalog (/tools), each with a known-answer canary probe and its current probe state. A Skills Hub skill's paid invocation is a listing that names the skill.",
    request: "no",
    retention: "Until the listing account removes it (the row stays with status removed so the address cannot silently change hands); delisted rows stay to show why.",
    columns: {
      id: "Listing id (tl_...), also the seller id on tool calls and canary runs.",
      account_id: "The account that listed the tool.",
      created_by: "Key hash that listed it; never a raw API key.",
      skill_id: "The Skills Hub skill whose paid invocation this is, or null.",
      name: "Seller-written tool name, up to 80 characters.",
      summary: "Seller-written one-line summary, up to 280 characters.",
      resource: "The tool's public https origin and path, without a query string.",
      method: "GET or POST.",
      price_units: "The price the tool quoted in its 402 when listed, in USDG base units.",
      pay_to: "The seller's payTo wallet from that quote; calls are refused if the live quote names another wallet.",
      network: "The x402 network name of that quote.",
      canary: { purpose: "The seller-written probe: method, optional query arguments and JSON body, and the expected substring or SHA-256 of a correct answer.", review: rv(["type:json"], "config", "Written by the listing account and validated against a strict schema; it describes a public probe, never a caller's request or answer.") },
      status: "listed, delisted (three failed probes in a row) or removed.",
      failures: "Consecutive failed canary probes.",
      delisted_at: "When the canary rule delisted it.",
      checked_at: "When it was last probed.",
      created_at: CREATED,
      updated_at: UPDATED,
    },
  },
  tool_calls: {
    category: "billing",
    purpose: "One row per paid x402 tool call made with a key's balance: the seller, the tool address, the price and take, the hold, the signed authorization's nonce and the settlement transaction, the answer's hash and the signed tool.call receipt. Never the tool arguments, the query string or the answer.",
    request: "yes",
    retention: "No automatic deletion: these are billing records, like generations and the ledger.",
    columns: {
      id: "Call id (tc_...), also the id of its hold.",
      key_hash: "The key that paid.",
      account_id: "The account charged.",
      seller_id: "The tool listing id when the address is listed, else null.",
      pay_to: "The seller's payTo wallet (public on chain).",
      resource: "The tool's https origin and path that was paid, without the query string.",
      method: "GET or POST.",
      network: "The x402 network of the paid offer.",
      x402_version: "1 or 2: which x402 wire format the seller spoke.",
      price_units: "The seller's price in USDG base units.",
      price: "The seller's price in pico-USD.",
      take: "The router's take in pico-USD (TOOLS_TAKE_BPS).",
      hold_id: "The hold on the key's balance.",
      payer: "The router's own buyer wallet that signed the authorization.",
      nonce: "The EIP-3009 nonce of that authorization; the reconcile job asks the chain whether it was used.",
      valid_before: "When that authorization expires.",
      settle_tx: "The settlement transaction hash the seller reported, if any.",
      response_sha256: { purpose: "SHA-256 of the tool's answer bytes, as in the receipt. The answer cannot be recovered from it.", review: rv(["name:content"], "digest-only", "A hash of the tool answer kept for the signed receipt; 64 hex characters, no text.") },
      seller_status: "The tool's HTTP status code.",
      status: "paying, ok, failed, released or charged_after_failure.",
      failure: "A fixed failure code, such as seller_status_500 or response_too_large.",
      receipt: { purpose: "The tool.call receipt: COSE_Sign1 bytes (base64), key id, leaf and the signed claims (hashes, amounts, seller, address, settlement).", review: JSON_FIELDS("Ids, hashes, amounts, the public tool address and wallet, and the signature over them; no arguments or answer text.") },
      created_at: CREATED,
      closed_at: "When the hold was charged or released.",
    },
  },
  tool_canary_runs: {
    category: "operations",
    purpose: "Results of the daily paid canary probe of each listed tool: whether the known answer came back, latency, a failure code, what the probe paid and the settlement transaction.",
    request: "no",
    retention: "Deleted after 90 days by the canary job; deleted with the listing.",
    columns: {
      id: "Run id, a sequence number.",
      seller_id: "The tool listing probed.",
      ok: "Whether the answer matched the listing's known answer.",
      latency_ms: "Time for the probe.",
      failure: "A fixed failure code, or null.",
      price_units: "What the probe paid, in USDG base units, if it paid.",
      settle_tx: "The settlement transaction hash the seller reported, if any.",
      at: "When it ran.",
    },
  },
};

export const toolsRateFamilies: RedisFamily[] = [
  { key: "rl:tools-call:<key hash>:<window start>", purpose: "Paid tool calls per minute for one API key (60).", holds: "key-hash", limiterPrefix: "tools-call:", windowSeconds: 60, ttl: windowTtl(60), evidence: [ev("src/tools/call.ts", "await ctx.limiter.take(`tools-call:${key.keyHash}`"), ...RL] },
  { key: "rl:tools-list:<account id>:<window start>", purpose: "Tool listings per hour for one account (20); each listing asks the tool for its quote.", holds: "account", limiterPrefix: "tools-list:", windowSeconds: 3600, ttl: windowTtl(3600), evidence: [ev("src/tools/routes.ts", "await ctx.limiter.take(`tools-list:${key.accountId}`"), ...RL] },
];

export const toolsBodyReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/tools/routes.ts",
  carries: "prompt-or-answer",
  reads: "A paid tool call: the tool's address, method, a JSON body of at most 64 KiB for the tool, max_price and optionally a model and prompt to hand the answer to. A tool listing: name, summary, address and a canary probe.",
  then: "Sends the body to the tool through the egress guard and reads its answer (2 MB at most, JSON or plain text only) in memory, returning it to the caller marked untrusted. Only when the rulebook sets tools.pass_to_models and the call asks for it is the answer sent to a model through the ordinary chat route.",
  kept: "tool_calls keeps hashes of the request and answer, amounts, the address without its query and the signed receipt; tool_listings keeps the listing. The body, the query string and the answer are not stored or logged. No new Redis family beyond the two rate limits, no caller-address reader.",
  evidence: [ev("src/tools/routes.ts", "const data = await callPaidTool(ctx, key, await readJson(c)"), ev("src/tools/call.ts", "requestSha256: sha256(canonicalJson({ method, url: url.toString(), body: input.body ?? null }))")],
};

export const toolsStores: ExternalDoc["otherStores"] = [
  {
    id: "public-tool-catalog",
    name: "Public tool catalog in the router's memory",
    purpose: "When TOOLS_PUBLIC_CATALOG_URL is set, the router fetches that public x402 catalog through the egress guard to answer tool searches.",
    holds: "Public tool names, summaries, addresses, prices and payTo wallets. No caller data.",
    ttl: "TOOLS_PUBLIC_CATALOG_TTL_S (900 seconds by default); a failed refresh keeps the previous copy; lost on restart.",
    requestText: "none",
    evidence: [ev("src/tools/catalog.ts", "const publicCache = new Map<string, { at: number; items: CatalogItem[] }>();")],
  },
];
