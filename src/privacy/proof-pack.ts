import type { Evidence, ExternalDoc, RedisFamily } from "./types.ts";

// U100: proof packs (src/proof-pack/read.ts). Read-only over existing records; one new per-key rate-limit family.

const ev = (file: string, contains: string): Evidence => ({ file, contains });

export const proofPackLimit: RedisFamily = {
  key: "rl:proof-pack:<key hash>:<window start>",
  purpose: "Proof pack downloads, ten per minute per API key. Contains only the key hash and a counter.",
  holds: "key-hash",
  limiterPrefix: "proof-pack:",
  windowSeconds: 60,
  ttl: "61 seconds (the 60-second window plus one second)",
  evidence: [ev("src/api/proof-pack.ts", "await ctx.limiter.take(`proof-pack:${key.keyHash}`"), ev("src/lib/ratelimit.ts", "const k = `rl:${key}:${start}`;"), ev("src/lib/ratelimit.ts", "await this.redis.pexpire(k, windowMs + 1000);")],
};

export const proofPackStores: ExternalDoc["otherStores"] = [{
  id: "proof-pack", name: "Proof pack in memory",
  purpose: "With STATEMENTS_ENABLED (off by default), GET /api/v1/proof-pack?from=&to= builds one JSON file for at most 31 UTC days: the calls Activity lists for the key's scope with their stored signed receipts and Merkle paths, issued refund receipts, the signed monthly statements covering the range, the published receipt keys, a lane report of the listed calls and a manifest signed with the existing receipt signer. Management and owner/admin keys read the account; ordinary and session keys read only their own key. A range with more than 2,000 calls, or calls under more than 200 anchors, is split into parts with a cursor.",
  holds: "Generation ids, call times, key hashes, model and provider ids, mode, lane, exact charged amounts, the stored signed receipt payloads and COSE claims (request and response hashes, token counts or buckets, amounts, attestation references, and the payer key hash or per-call payer wallet and payment transaction a receipt was signed with), anchor roots, indexes and Merkle paths, refund receipts with their stored evidence and any on-chain refund wallet, signed statements, public receipt keys and the manifest of listed receipt ids and leaves. No request or answer text, key secrets or network addresses; recorded provider attempts are not read.",
  ttl: "Discarded after the response with cache-control no-store. No new tables, columns or log fields; one rate-limit counter per key. Downloaded files remain on the caller's device. Existing receipt, refund, ledger and anchor retention apply.",
  requestText: "hashes", evidence: [ev("src/proof-pack/read.ts", "export async function readProofPack"), ev("src/api/proof-pack.ts", 'c.header("cache-control", "no-store")')],
}];
