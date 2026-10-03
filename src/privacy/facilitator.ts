import type { ExternalDoc, RedisFamily, TableDoc, Touchpoint } from "./types.ts";
import { CREATED, KEPT, UPDATED, rv } from "./tables/common.ts";

// The same wording as outside.ts windowTtl (not imported: outside.ts imports this file).
const windowTtl = (seconds: number) => `${(seconds + 1).toLocaleString("en-US")} seconds (the ${seconds.toLocaleString("en-US")}-second window plus one second)`;

// v6 F: what the hosted x402 facilitator (src/facilitator) keeps. It relays payments between other people's wallets, so
// it stores public chain facts (addresses, amounts, nonces, transaction hashes) and seller listings, and no request text.

export const facilitatorTables: Record<string, TableDoc> = {
  facilitator_sellers: {
    category: "operations",
    request: "no",
    purpose: "Sellers who opted in to the facilitator's discovery index: the paid URL, a price hint, an output schema and tags, each listing signed by the seller's payTo key. Shown publicly at /facilitator/discovery/resources while listed.",
    retention: "Kept until the seller replaces it with a later signed listing; listed false hides it from discovery. No job removes rows.",
    columns: {
      id: "Random listing identifier (fsl_ followed by 24 hex characters).",
      pay_to: "Lowercase wallet address the seller is paid at, which signed the listing. Public in every 402 response the seller sends.",
      resource: "The seller's paid https URL as signed. The first payTo to list a URL owns that entry.",
      price_hint: "Price the seller states, in USDG base units; the seller's own 402 response stays authoritative.",
      result_schema: { purpose: "JSON schema the seller published for its endpoint's result (x402 outputSchema), as signed.", review: rv(["type:json"], "config", "Seller-written description of a public paid endpoint's result shape, signed by its payTo key and shown in discovery; never a caller's request or answer.") },
      tags: "Up to ten lowercase words the seller chose for search.",
      listed: "Whether the listing shows in discovery.",
      signature: "The payTo key's EIP-712 signature over the listing.",
      signed_at: "issuedAt of the stored signature; only a later signature replaces the listing.",
      created_at: CREATED,
      updated_at: UPDATED,
    },
  },
  facilitator_settlements: {
    category: "chain",
    request: "yes",
    purpose: "One row per facilitator settle that passed verification: the payer's signed USDG authorization relayed straight to the seller's payTo (or to the treasury for a gas float top-up). (payer, nonce) is unique, so an authorization settles at most once here. Settled rows carry a signed receipt of kind facilitator.settle that joins the hourly anchor.",
    retention: KEPT,
    notes: ["Payer, payTo, amount, nonce and transaction hash are the same facts the public chain shows for the transfer. Payers are not screened: the facilitator never holds the funds it relays."],
    columns: {
      id: "Random settlement identifier (fst_ followed by 24 hex characters); also the receipt id.",
      kind: "payment, or gas_float for a seller's gas float top-up.",
      payer: "Lowercase wallet address that signed the authorization.",
      pay_to: "Lowercase wallet address the USDG went to.",
      value: "Authorized USDG base units.",
      nonce: "The authorization's EIP-3009 nonce.",
      tx_hash: "Relay transaction hash, once settled.",
      status: "verified (claimed, relay in flight), settled or failed.",
      error: { purpose: "A fixed code for a failed relay (relay_failed).", review: rv(["name:content"], "no-request-content", "A fixed code written by the facilitator code, never chain error text, a request body or an answer.") },
      seller_id: "Listing the payment belongs to, when the payTo has one.",
      x402_version: "x402 protocol version of the payment, 1 or 2.",
      fee_value: "USDG base units of the facilitator fee authorization, when a fee is charged.",
      fee_tx_hash: "Transaction hash of the relayed fee authorization.",
      gas_debit: "USDG base units taken from the seller's gas float for this settle.",
      settled_at: "When the relay landed and the receipt was signed.",
      receipt_cose: "The signed receipt (base64 COSE_Sign1): network, asset, transaction, amount, payTo and fee. It names no payer.",
      receipt_leaf: "The receipt's leaf hash in the hourly anchoring tree.",
      receipt_key_id: "Receipt signing key id.",
      anchor_index: "Anchor (Merkle root) this receipt was included in, once rooted.",
      leaf_index: "Position of the receipt's leaf in that anchor's tree.",
      created_at: CREATED,
    },
  },
  seller_gas_floats: {
    category: "billing",
    request: "aggregate",
    purpose: "USDG a seller prepaid to the treasury so the facilitator settles its payments below the minimum; each such settle is debited at its measured gas times a buffer.",
    retention: KEPT,
    columns: {
      seller_id: "The listing the float belongs to.",
      balance: "USDG base units left.",
      funded: "USDG base units paid in, in total.",
      debited: "USDG base units taken for gas, in total.",
      updated_at: UPDATED,
    },
  },
};

const ROUTES = "src/facilitator/routes.ts";
const family = (prefix: string, shape: string, holds: RedisFamily["holds"], seconds: number, purpose: string, contains: string): RedisFamily => ({
  key: `rl:${shape}:<window start>`,
  purpose,
  holds,
  limiterPrefix: prefix,
  windowSeconds: seconds,
  ttl: windowTtl(seconds),
  evidence: [{ file: ROUTES, contains }],
});

export const facilitatorRedisFamilies: RedisFamily[] = [
  family("facilitator:", "facilitator:<caller address or onion>", "address", 60, "Facilitator requests per caller address per minute (FACILITATOR_RPM, 120 by default), a bucket apart from the API's. The raw address is part of the key; over Tor the shared onion bucket is used.", "await ctx.limiter.take(`facilitator:${from.id}`"),
  family("facilitator-payer:", "facilitator-payer:<payer wallet>", "wallet", 60, "Verify and settle calls per payer wallet per minute, so one payer cannot drain the relay with tiny payments. Links calls by the public payer wallet.", "await ctx.limiter.take(`facilitator-payer:${payer.toLowerCase()}`"),
  family("facilitator-seller:", "facilitator-seller:<payTo wallet>", "wallet", 60, "Verify and settle calls per seller payTo wallet per minute.", "await ctx.limiter.take(`facilitator-seller:${payTo.toLowerCase()}`"),
  family("facilitator-listing:", "facilitator-listing:<payTo wallet>", "wallet", 3600, "Signed listing writes per payTo wallet per hour (FACILITATOR_LISTINGS_PER_HOUR).", "await ctx.limiter.take(`facilitator-listing:${listing.payTo}`"),
];

export const facilitatorAddressReader: Touchpoint = {
  file: ROUTES,
  reads: "The caller address bucket on every /facilitator route; over Tor the shared onion bucket.",
  then: "Counts requests in the facilitator's own per-address limiter; trusted proxy and onion rules apply.",
  kept: "Raw address in the limiter key for 61 seconds in Redis, or until the memory limiter sweeps; never in a settlement, listing, receipt or log line.",
  evidence: [{ file: ROUTES, contains: "const from = addressBucket(c, ctx.cfg);" }],
};

export const facilitatorBodyReader: ExternalDoc["bodyReaders"][number] = {
  file: ROUTES,
  carries: "payment-or-signature",
  reads: "x402 verify and settle bodies (a payer's signed USDG authorization and the seller's payment requirements), signed seller listings, and gas float top-ups, each at most 64 KB.",
  then: "Checks signatures, amounts, time windows and nonces, relays a valid authorization from the payer straight to payTo with the relay key, and screens a listed payTo against the sanctions list.",
  kept: "Settled and failed attempts in facilitator_settlements, signed listings in facilitator_sellers and float balances in seller_gas_floats. Request bodies are not stored and carry no prompts.",
  evidence: [{ file: ROUTES, contains: "const text = await c.req.text();" }],
};
