import { and, eq, lt } from "drizzle-orm";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { recoverMessageAddress, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { quotes, x402PaidResults } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { decrypt, encrypt, log, sha256 } from "../lib/util.ts";
import { readJson } from "../api/common.ts";
import { requestHash } from "../api/chat.ts";
import { parsePaymentHeader } from "./percall.ts";
import { paymentHeaderOf, x402Enabled, type X402Payment } from "./x402.ts";

// x402 payment recovery: a paid call whose answer was lost on the way back (a timeout, or a 502, 503 or 504 from something
// between the caller and the router) is never paid for twice. The caller sends the identical request again with the same
// payment (X-PAYMENT or PAYMENT-SIGNATURE) and a PAYMENT-RECOVERY header: the payer's EIP-191 (personal_sign) signature
// of recoveryMessage(). The router answers with the response it stored for that (payer, nonce), byte for byte, and never
// relays the authorization again. Nothing here verifies or settles a payment: that stays in percall.ts and x402.ts.
//
// What is kept, for 24 hours: a row in x402_paid_results with the payer, the authorization nonce, the SHA-256 of the
// request and of the response, and the name of the Redis key that holds the response (body_ref). The response itself is
// sealed with AES-256-GCM under a key derived from APP_SECRET, the payer, the nonce and the request hash, and kept in Redis
// (or the router's memory without Redis), never in Postgres. Redis drops it when its time-to-live ends; the
// x402-recovery-expire job, and each replica that keeps answers (at most hourly), delete rows and sealed answers past 24 hours.

export const RECOVERY_TTL_MS = 24 * 3_600_000;
/** The answer's largest size that is kept; a larger answer is served but cannot be recovered. */
const MAX_KEPT_BYTES = 8 * 1024 * 1024;
/** The response headers kept with the answer and sent again with it. */
const KEPT_HEADERS = ["content-type", "x-generation-id", "x-receipt-id", "inference-id", "x-anyroute-lane", "x-anyroute-policy-hash", "x-anyroute-disclosure", "x-anyroute-cache", "x-payment-response", "payment-response"];
/** The routes that take a per-call payment themselves. The Responses and Ollama adapters reach them in process. */
const PAID_PATHS = ["/api/v1/chat/completions", "/v1/chat/completions", "/api/v1/completions", "/v1/completions", "/api/v1/embeddings", "/v1/embeddings", "/api/v1/rerank", "/v1/rerank", "/api/v1/characters/:id/chat"];

/** What the payer signs (EIP-191 personal_sign) to have the answer an authorization paid for sent again. */
export const recoveryMessage = (chainId: number, payer: string, nonce: string) => `anyroute:x402-recovery:${chainId}:${payer.toLowerCase()}:${nonce.toLowerCase()}`;

type Kept = { status: number; headers: Record<string, string>; body: string };

/** Sealed answers by body_ref: in Redis (shared by every replica) or this router's memory. */
export class PaidResultStore {
  private mem = new Map<string, { sealed: string; expires: number }>();
  constructor(private secret: string, private redis?: import("ioredis").Redis) {}

  private scope = (s: string) => `${this.secret}:x402paid:${s}`;

  /** Keep a sealed answer, once: a second answer for the same reference is refused. */
  async put(ref: string, scope: string, kept: Kept): Promise<boolean> {
    const sealed = encrypt(this.scope(scope), JSON.stringify(kept));
    if (this.redis) return (await this.redis.set(ref, sealed, "PX", RECOVERY_TTL_MS, "NX")) === "OK";
    this.sweep();
    if (this.mem.has(ref)) return false;
    this.mem.set(ref, { sealed, expires: Date.now() + RECOVERY_TTL_MS });
    return true;
  }
  async get(ref: string, scope: string): Promise<Kept | null> {
    const entry = this.mem.get(ref);
    const sealed = this.redis ? await this.redis.get(ref) : entry && entry.expires > Date.now() ? entry.sealed : null;
    return sealed ? (JSON.parse(decrypt(this.scope(scope), sealed)) as Kept) : null;
  }
  /** The stored ciphertext, as it is at rest. */
  sealedAt = async (ref: string) => (this.redis ? this.redis.get(ref) : (this.mem.get(ref)?.sealed ?? null));
  async del(refs: string[]) {
    if (!refs.length) return;
    if (this.redis) return void (await this.redis.del(...refs));
    for (const r of refs) this.mem.delete(r);
    this.sweep();
  }
  private sweep() {
    for (const [k, v] of this.mem) if (v.expires <= Date.now()) this.mem.delete(k);
  }
}

const stores = new WeakMap<Ctx, PaidResultStore>();
export function paidResultStore(ctx: Ctx) {
  let s = stores.get(ctx);
  if (!s) stores.set(ctx, (s = new PaidResultStore(ctx.cfg.appSecret, ctx.cache.redis)));
  return s;
}

const bodyRef = (payer: string, nonce: string) => `x402paid:${sha256(`${payer}:${nonce}`)}`;
const fresh = (createdAt: Date) => createdAt.getTime() + RECOVERY_TTL_MS > Date.now();

/** The x402 payment a request carries, or null (no payment, a CallPay payment, or one that does not parse). */
function x402Of(c: Context): X402Payment | null {
  const raw = paymentHeaderOf(c);
  if (!raw) return null;
  try {
    const p = parsePaymentHeader(raw);
    return p.kind === "x402" ? p.payment : null;
  } catch {
    return null;
  }
}

/** The payer a settlement header names, or null. */
function settledPayer(header: string): string | null {
  try {
    const payer = JSON.parse(Buffer.from(header, "base64").toString("utf8"))?.payer;
    return typeof payer === "string" ? payer.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** A paid x402 call's response: keep its bytes, sealed, for recovery. A stream is kept once it has ended. */
async function keep(ctx: Ctx, c: Context, payment: X402Payment, res: Response): Promise<Response> {
  const payer = payment.auth.from.toLowerCase();
  const nonce = payment.auth.nonce.toLowerCase();
  const requestSha = requestHash(await readJson(c));
  const headers = Object.fromEntries(KEPT_HEADERS.flatMap((h) => (res.headers.get(h) !== null ? [[h, res.headers.get(h)!]] : [])));
  const store = async (bytes: Uint8Array) => {
    const ref = bodyRef(payer, nonce);
    const claimed = await ctx.db.insert(x402PaidResults).values({ payer, nonce, requestSha256: requestSha, responseSha256: sha256(bytes), bodyRef: ref }).onConflictDoNothing().returning({ ref: x402PaidResults.bodyRef });
    if (claimed.length) await paidResultStore(ctx).put(ref, `${payer}:${nonce}:${requestSha}`, { status: res.status, headers, body: Buffer.from(bytes).toString("base64") });
    sweepHourly(ctx);
  };
  const failed = (e: unknown) => log.warn("x402 answer not kept for recovery", { payer, error: (e as Error).message });
  if (!res.body) return res;
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength <= MAX_KEPT_BYTES) await store(bytes).catch(failed);
    return new Response(bytes, res);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, out) {
      size += chunk.byteLength;
      if (size <= MAX_KEPT_BYTES) chunks.push(chunk);
      out.enqueue(chunk);
    },
    // Only a stream that reached its end is kept: one the caller left halfway is not an answer. The stream closes once
    // the answer is kept, so a caller that read it to the end can always recover it.
    async flush() {
      if (size <= MAX_KEPT_BYTES) await store(Buffer.concat(chunks)).catch(failed);
    },
  });
  return new Response(res.body.pipeThrough(tap), res);
}

/** The recovery itself: check the payer's signature and the request, and send the kept answer again. Never relays. */
async function recover(ctx: Ctx, c: Context, signature: string): Promise<Response> {
  if (!x402Enabled(ctx)) fail(400, "x402 payments are not enabled on this router.", "x402_unavailable");
  const raw = paymentHeaderOf(c);
  const parsed = raw ? parsePaymentHeader(raw) : null;
  if (parsed?.kind !== "x402")
    fail(400, "PAYMENT-RECOVERY recovers an x402 payment: send it with the same X-PAYMENT or PAYMENT-SIGNATURE the paid request carried.", "invalid_payment_recovery");
  const payer = parsed.payment.auth.from.toLowerCase();
  const nonce = parsed.payment.auth.nonce.toLowerCase();
  const sig = signature.trim();
  const signer = /^0x[0-9a-fA-F]{128,130}$/.test(sig) ? await recoverMessageAddress({ message: recoveryMessage(ctx.cfg.chain.id, payer, nonce), signature: sig as Hex }).catch(() => null) : null;
  if (signer?.toLowerCase() !== payer)
    fail(401, `PAYMENT-RECOVERY must be the payer's EIP-191 signature of "${recoveryMessage(ctx.cfg.chain.id, payer, nonce)}".`, "invalid_payment_recovery");
  const requestSha = requestHash(await readJson(c));
  const [row] = await ctx.db.select().from(x402PaidResults).where(and(eq(x402PaidResults.payer, payer), eq(x402PaidResults.nonce, nonce)));
  if (row && fresh(row.createdAt)) {
    if (row.requestSha256 !== requestSha) fail(409, "This payment paid for a different request. Recovery sends an answer again only for the identical request.", "payment_request_mismatch");
    const kept = await paidResultStore(ctx).get(row.bodyRef, `${payer}:${nonce}:${requestSha}`);
    const bytes = kept ? Buffer.from(kept.body, "base64") : null;
    if (kept && bytes && sha256(bytes) === row.responseSha256) return new Response(bytes, { status: kept.status, headers: kept.headers });
  }
  // Nothing to send again. Say whether the authorization was settled: if it was, its value is the payer's change.
  const [claim] = await ctx.db.select().from(quotes).where(eq(quotes.nonce, `x402:${payer}:${nonce}`));
  const settled = claim?.status === "used";
  fail(
    404,
    settled
      ? "No answer is kept for this payment: the call is still running or did not finish, its answer was too large to keep, or 24 hours have passed. Nothing was charged twice; what the call did not use stays as change on your wallet account (spend it with X-Wallet-Auth)."
      : "This router never settled this authorization, so there is no answer to recover. Send the request again without PAYMENT-RECOVERY to pay for it.",
    "payment_recovery_not_found",
    { settled, transaction: settled ? (claim?.txHash ?? null) : null },
  );
}

/** PAYMENT-RECOVERY on the paid routes, and keeping the answers of paid x402 calls. */
export function paymentRecovery(app: Hono, ctx: Ctx) {
  const middleware: MiddlewareHandler = async (c, next) => {
    if (c.req.method !== "POST") return next();
    const signature = c.req.header("payment-recovery");
    if (signature !== undefined) return recover(ctx, c, signature);
    await next();
    const settlement = c.res.headers.get("x-payment-response");
    if (!x402Enabled(ctx) || !settlement) return;
    // Kept only when the settlement on the response is this request's own authorization's.
    const payment = x402Of(c);
    if (payment && settledPayer(settlement) === payment.auth.from.toLowerCase()) c.res = await keep(ctx, c, payment, c.res);
  };
  for (const path of PAID_PATHS) app.use(path, middleware);
}

/** Delete what recovery keeps once its 24 hours have passed: the x402-recovery-expire job, and sweepHourly(). */
export async function expirePaidResults(ctx: Ctx) {
  const gone = await ctx.db.delete(x402PaidResults).where(lt(x402PaidResults.createdAt, new Date(Date.now() - RECOVERY_TTL_MS))).returning({ ref: x402PaidResults.bodyRef });
  await paidResultStore(ctx).del(gone.map((r) => r.ref));
  return { expired: gone.length };
}

const swept = new WeakMap<Ctx, number>();
/** A replica that keeps answers also deletes expired ones, at most once an hour, whether or not a worker runs the job. */
function sweepHourly(ctx: Ctx) {
  if (Date.now() - (swept.get(ctx) ?? 0) < 3_600_000) return;
  swept.set(ctx, Date.now());
  void expirePaidResults(ctx).catch((e) => log.warn("x402 recovery expiry failed", { error: (e as Error).message }));
}
