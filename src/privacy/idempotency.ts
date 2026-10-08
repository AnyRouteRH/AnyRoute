import type { ExternalDoc, RedisFamily } from "./types.ts";
const evidence = [{ file: "src/idempotency/store.ts", contains: "export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;" }, { file: "src/idempotency/middleware.ts", contains: "const body = await readJson(c);" }];
export const idempotencyFamily: RedisFamily = {
  key: "idempotency:<sha256>", holds: "digest", requestText: "answer-text",
  purpose: "Opt-in retry protection for API-key inference calls with Idempotency-Key. The key hashes account id, API key hash and the caller's idempotency key. AES-256-GCM ciphertext under APP_SECRET and this scope contains a canonical request-body and endpoint hash, an ownership marker, and the final status, reply and receipt headers. The request body and raw idempotency key are not stored. Replies can echo request text. Stream replies are not retained; a completed marker keeps status and receipt headers instead. An unfinished call or failed retention leaves an in-progress marker; retries never run inference again while it remains. Redis failure refuses a new protected call before billing. No new database row or log field is added.",
  ttl: "86,400 seconds (24 hours) from the first request; completion does not extend it. Redis deletes the entry at expiry. After expiry the same key starts a new billable call.", evidence,
};
export const idempotencyReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/idempotency/middleware.ts", carries: "prompt-or-answer", reads: "API-key request JSON only when Idempotency-Key is present on a supported inference endpoint.",
  then: "Authenticates the current key and role, hashes the canonical body and endpoint in memory, and claims a scoped retry guard before approval consumption or billing. Ordinary router paths still read request text in memory on every lane; encryption at rest does not hide replies from the router.",
  kept: "Only a request hash plus an encrypted final reply, status and selected response headers for 24 hours, in Redis or memory. Streaming keeps no answer text. The same key with a different request gets 422; an unfinished call gets 409. Unsupported credential types cannot opt in.", evidence,
};
export const idempotencyMemory: ExternalDoc["otherStores"][number] = {
  id: "idempotency-memory", name: "Retry protection without Redis", purpose: "The same opt-in retry guard and encrypted reply as Redis, scoped to this router process only. Up to 5,000 live entries; a full store refuses new protected calls rather than evicting a guard.",
  holds: "AES-256-GCM sealed request hash, ownership marker, status, reply and receipt headers. No raw key, prompt or address. Replies may contain request text.",
  ttl: "24 hours from the first request. A timer deletes ciphertext at expiry, and lookups also sweep expired entries. Process restart loses entries. Without Redis, retries routed to another process are not protected.", requestText: "answer-text", evidence,
};
