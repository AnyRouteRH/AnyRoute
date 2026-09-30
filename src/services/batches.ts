import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { batchLines, batches, generations } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { type Pico, picoToUsd, usdToPico } from "../lib/money.ts";
import { decrypt, encrypt, genId, log } from "../lib/util.ts";
import { BATCH_LINE, type BatchLine } from "../router/batch-line.ts";

// Batch API: an OpenAI-compatible batch of chat or embeddings requests, run by the worker in spare capacity at a discount
// (BATCH_DISCOUNT_BPS). Every line goes through the normal handler in process (router/batch-line.ts), so lanes, provider
// preferences, key budgets, key rate limits, holds and signed receipts apply to it exactly as to a direct call.
//
// Postgres keeps only statuses, counts, costs and generation ids (batches, batch_lines). The lines' requests and answers are
// sealed with AES-256-GCM under a key derived from APP_SECRET, the batch id and the submitting key's hash, and kept in Redis
// (or the router's memory without Redis): the requests until the batch finishes, the answers until BATCH_RESULTS_TTL after
// that. Then both, and the line rows, are deleted.

export type BatchRow = typeof batches.$inferSelect;
export type BatchApi = "chat" | "embeddings";
export type Dispatch = (path: string, init: RequestInit, env: unknown) => Response | Promise<Response>;
type LineInput = { custom_id: string; url: string; body: Record<string, unknown> };
type LineResult = { custom_id: string; status_code: number | null; request_id: string | null; body: unknown; error: { code: string; message: string } | null };

export const COMPLETION_WINDOW = "24h";
const WINDOW_MS = 24 * 3_600_000;
const ACTIVE = ["validating", "in_progress", "cancelling"];
const TERMINAL = new Set(["completed", "failed", "expired", "cancelled"]);
const URLS: Record<string, BatchApi> = { "/v1/chat/completions": "chat", "/api/v1/chat/completions": "chat", "/v1/embeddings": "embeddings", "/api/v1/embeddings": "embeddings" };
const PATH: Record<BatchApi, string> = { chat: "/api/v1/chat/completions", embeddings: "/api/v1/embeddings" };
export const ENDPOINT: Record<BatchApi, string> = { chat: "/v1/chat/completions", embeddings: "/v1/embeddings" };
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ---- sealed store --------------------------------------------------------------------------------------------------

/** Requests (`batch:<id>:in`) and answers (`batch:<id>:out`) of a batch, each a hash of line number to sealed JSON. */
export class BatchStore {
  private mem = new Map<string, { fields: Map<string, string>; expires: number }>();
  constructor(private secret: string, private redis?: import("ioredis").Redis) {}

  private scope = (b: Pick<BatchRow, "id" | "keyHash">) => `${this.secret}:batch:${b.id}:${b.keyHash}`;
  private seal = (b: Pick<BatchRow, "id" | "keyHash">, v: unknown) => encrypt(this.scope(b), JSON.stringify(v));
  private open = <T>(b: Pick<BatchRow, "id" | "keyHash">, s: string): T => JSON.parse(decrypt(this.scope(b), s)) as T;

  private async hset(key: string, entries: [string, string][], ttlMs: number) {
    if (this.redis) {
      for (let i = 0; i < entries.length; i += 500) await this.redis.hset(key, Object.fromEntries(entries.slice(i, i + 500)));
      await this.redis.pexpire(key, Math.max(1, ttlMs));
      return;
    }
    const cur = this.mem.get(key);
    const fields = cur && cur.expires > Date.now() ? cur.fields : new Map<string, string>();
    for (const [k, v] of entries) fields.set(k, v);
    this.mem.set(key, { fields, expires: Date.now() + ttlMs });
  }
  private async hget(key: string, field: string) {
    if (this.redis) return this.redis.hget(key, field);
    const cur = this.mem.get(key);
    return cur && cur.expires > Date.now() ? (cur.fields.get(field) ?? null) : null;
  }
  private async hgetall(key: string): Promise<Record<string, string>> {
    if (this.redis) return this.redis.hgetall(key);
    const cur = this.mem.get(key);
    return cur && cur.expires > Date.now() ? Object.fromEntries(cur.fields) : {};
  }
  private async expire(key: string, ttlMs: number) {
    if (this.redis) return void (await this.redis.pexpire(key, Math.max(1, ttlMs)));
    const cur = this.mem.get(key);
    if (cur) cur.expires = Date.now() + ttlMs;
  }
  private async del(...keys: string[]) {
    if (this.redis) return void (await this.redis.del(...keys));
    for (const k of keys) this.mem.delete(k);
    for (const [k, v] of this.mem) if (v.expires <= Date.now()) this.mem.delete(k); // sweep entries that outlived their batch
  }

  saveInputs = (b: BatchRow, lines: LineInput[], ttlMs: number) => this.hset(`batch:${b.id}:in`, lines.map((l, i) => [String(i), this.seal(b, l)]), ttlMs);
  async input(b: BatchRow, idx: number): Promise<LineInput | null> {
    const raw = await this.hget(`batch:${b.id}:in`, String(idx));
    return raw ? this.open<LineInput>(b, raw) : null;
  }
  saveResults = (b: BatchRow, results: [number, LineResult][], ttlMs: number) => this.hset(`batch:${b.id}:out`, results.map(([i, r]) => [String(i), this.seal(b, r)]), ttlMs);
  async results(b: BatchRow): Promise<Map<number, LineResult>> {
    const all = await this.hgetall(`batch:${b.id}:out`);
    return new Map(Object.entries(all).map(([k, v]) => [Number(k), this.open<LineResult>(b, v)]));
  }
  /** The batch finished: its requests are no longer needed, and its answers live BATCH_RESULTS_TTL from now. */
  async finish(b: BatchRow, resultsTtlMs: number) {
    await this.del(`batch:${b.id}:in`);
    await this.expire(`batch:${b.id}:out`, resultsTtlMs);
  }
  purge = (b: BatchRow) => this.del(`batch:${b.id}:in`, `batch:${b.id}:out`);
}

const stores = new WeakMap<Ctx, BatchStore>();
export function batchStore(ctx: Ctx) {
  let s = stores.get(ctx);
  if (!s) stores.set(ctx, (s = new BatchStore(ctx.cfg.appSecret, ctx.cache.redis)));
  return s;
}

/** How long a batch's sealed data may live at most: the rest of its window plus the results time-to-live. */
const storeTtl = (ctx: Ctx, b: BatchRow) => Math.max(0, b.expiresAt.getTime() - Date.now()) + ctx.cfg.batch.resultsTtlS * 1000;

// ---- submit --------------------------------------------------------------------------------------------------------

type LineError = { line: number; code: string; message: string };

/** Parse and check a submission. Throws 400 with every problem found (up to 20), so nothing half-valid is ever queued. */
export function parseSubmission(ctx: Ctx, body: Record<string, unknown>): { api: BatchApi; lines: LineInput[] } {
  const { maxLines, maxBytes } = ctx.cfg.batch;
  if (body.input_file_id != null)
    fail(400, "This router has no files endpoint: send the lines inline, as `requests` (an array) or `input_jsonl` (JSONL text).", "invalid_request");
  if (body.completion_window != null && body.completion_window !== COMPLETION_WINDOW) fail(400, "`completion_window` must be \"24h\".", "invalid_request");
  let raw: { line: number; value: unknown; error?: string }[];
  if (Array.isArray(body.requests)) {
    if (Buffer.byteLength(JSON.stringify(body.requests)) > maxBytes) fail(413, `A batch may hold at most ${maxBytes} bytes of input.`, "payload_too_large");
    raw = body.requests.map((value, i) => ({ line: i + 1, value }));
  } else if (typeof body.input_jsonl === "string") {
    if (Buffer.byteLength(body.input_jsonl) > maxBytes) fail(413, `A batch may hold at most ${maxBytes} bytes of input.`, "payload_too_large");
    raw = [];
    body.input_jsonl.split(/\r?\n/).forEach((text, i) => {
      if (!text.trim()) return;
      try {
        raw.push({ line: i + 1, value: JSON.parse(text) });
      } catch {
        raw.push({ line: i + 1, value: null, error: "This line is not valid JSON." });
      }
    });
  } else fail(400, "Send the batch as `requests` (an array of request objects) or `input_jsonl` (JSONL text, one request object per line).", "invalid_request");
  if (!raw.length) fail(400, "The batch has no lines.", "invalid_request");
  if (raw.length > maxLines) fail(413, `A batch may hold at most ${maxLines} lines; this one has ${raw.length}.`, "payload_too_large");

  const wanted = body.endpoint == null ? null : URLS[String(body.endpoint)];
  if (body.endpoint != null && !wanted) fail(400, "`endpoint` must be /v1/chat/completions or /v1/embeddings.", "invalid_request");
  const errors: LineError[] = [];
  const seen = new Set<string>();
  const lines: LineInput[] = [];
  let api: BatchApi | null = wanted;
  const bad = (line: number, code: string, message: string) => void (errors.length < 20 && errors.push({ line, code, message }));
  for (const r of raw) {
    if (r.error) { bad(r.line, "invalid_json_line", r.error); continue; }
    const v = r.value;
    if (!plain(v)) { bad(r.line, "invalid_request", "Each line must be a JSON object."); continue; }
    const id = v.custom_id;
    if (typeof id !== "string" || !id || id.length > 64) { bad(r.line, "invalid_custom_id", "`custom_id` must be a string of 1 to 64 characters."); continue; }
    if (seen.has(id)) { bad(r.line, "duplicate_custom_id", `\`custom_id\` ${JSON.stringify(id)} is used by an earlier line.`); continue; }
    seen.add(id);
    if (v.method != null && v.method !== "POST") { bad(r.line, "invalid_method", "`method` must be POST."); continue; }
    const lineApi = URLS[String(v.url)];
    if (!lineApi) { bad(r.line, "invalid_url", "`url` must be /v1/chat/completions or /v1/embeddings."); continue; }
    if (api && lineApi !== api) { bad(r.line, "mismatched_url", `Every line in a batch must use the same url (${ENDPOINT[api]}).`); continue; }
    api = lineApi;
    const b = v.body;
    if (!plain(b)) { bad(r.line, "invalid_body", "`body` must be a JSON object."); continue; }
    if (typeof b.model !== "string" || !b.model) { bad(r.line, "invalid_body", "`body.model` is required."); continue; }
    if (b.stream === true) { bad(r.line, "invalid_body", "Batch lines cannot stream."); continue; }
    if (lineApi === "chat") {
      if (b.verify != null || b.model === "anyroute/council") { bad(r.line, "invalid_body", "Council mode and dual verification cannot run in a batch."); continue; }
      if (!Array.isArray(b.messages) || !b.messages.length) { bad(r.line, "invalid_body", "`body.messages` must be a non-empty array."); continue; }
    } else if (b.input == null) { bad(r.line, "invalid_body", "`body.input` is required."); continue; }
    lines.push({ custom_id: id, url: ENDPOINT[lineApi], body: b });
  }
  if (errors.length) fail(400, `The batch has ${errors.length === 20 ? "20 or more" : errors.length} invalid line${errors.length === 1 ? "" : "s"}; nothing was queued.`, "invalid_request", { errors });
  return { api: api!, lines };
}

export async function createBatch(ctx: Ctx, key: { keyHash: string; accountId: string }, body: Record<string, unknown>) {
  const { api, lines } = parseSubmission(ctx, body);
  const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(batches).where(and(eq(batches.keyHash, key.keyHash), inArray(batches.status, ACTIVE)));
  if (n >= ctx.cfg.batch.maxActive)
    fail(429, `This key already has ${n} unfinished batch${n === 1 ? "" : "es"} (at most ${ctx.cfg.batch.maxActive}). Wait for one to finish or cancel one.`, "batch_limit");
  const now = new Date();
  const row: BatchRow = {
    id: `batch_${randomBytes(12).toString("hex")}`,
    accountId: key.accountId,
    keyHash: key.keyHash,
    api,
    status: "validating",
    total: lines.length,
    completed: 0,
    failed: 0,
    cost: 0n,
    listCost: 0n,
    discountBps: ctx.cfg.batch.discountBps,
    createdAt: now,
    startedAt: null,
    cancellingAt: null,
    finishedAt: null,
    expiresAt: new Date(now.getTime() + WINDOW_MS),
    resultsExpireAt: null,
    purgedAt: null,
  };
  await batchStore(ctx).saveInputs(row, lines, storeTtl(ctx, row));
  await ctx.db.transaction(async (tx) => {
    await tx.insert(batches).values(row);
    for (let i = 0; i < lines.length; i += 500)
      await tx.insert(batchLines).values(lines.slice(i, i + 500).map((_, j) => ({ batchId: row.id, idx: i + j, api })));
  });
  return row;
}

// ---- read ----------------------------------------------------------------------------------------------------------

export async function batchFor(ctx: Ctx, keyHash: string, id: string) {
  const [b] = await ctx.db.select().from(batches).where(and(eq(batches.id, id), eq(batches.keyHash, keyHash)));
  if (!b) fail(404, `No batch ${id} for this key.`, "batch_not_found");
  return b;
}

export async function listBatches(ctx: Ctx, keyHash: string, opts: { limit: number; after?: string }) {
  let before: Date | null = null;
  if (opts.after) before = (await batchFor(ctx, keyHash, opts.after)).createdAt;
  const rows = await ctx.db
    .select()
    .from(batches)
    .where(and(eq(batches.keyHash, keyHash), before ? lt(batches.createdAt, before) : undefined))
    .orderBy(desc(batches.createdAt), desc(batches.id))
    .limit(opts.limit + 1);
  return { rows: rows.slice(0, opts.limit), hasMore: rows.length > opts.limit };
}

const unix = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : null);

/** The OpenAI Batch object, plus where to fetch the results and what the batch cost. */
export function batchJson(b: BatchRow) {
  const at = (status: string) => (b.status === status ? unix(b.finishedAt) : null);
  return {
    id: b.id,
    object: "batch",
    endpoint: ENDPOINT[b.api as BatchApi],
    errors: null,
    input_file_id: null,
    completion_window: COMPLETION_WINDOW,
    status: b.status,
    output_file_id: null,
    error_file_id: null,
    output_url: `/api/v1/batches/${b.id}/output`,
    errors_url: `/api/v1/batches/${b.id}/errors`,
    created_at: unix(b.createdAt),
    in_progress_at: unix(b.startedAt),
    expires_at: unix(b.expiresAt),
    finalizing_at: TERMINAL.has(b.status) ? unix(b.finishedAt) : null,
    completed_at: at("completed"),
    failed_at: at("failed"),
    expired_at: at("expired"),
    cancelling_at: unix(b.cancellingAt),
    cancelled_at: at("cancelled"),
    request_counts: { total: b.total, completed: b.completed, failed: b.failed },
    cost: { usd: picoToUsd(b.cost), list_usd: picoToUsd(b.listCost), discount_bps: b.discountBps },
    results_expire_at: unix(b.resultsExpireAt),
    metadata: null,
  };
}

/** The output (successful lines) or errors (failed, cancelled and expired lines) of a batch, as OpenAI batch JSONL. */
export async function batchResults(ctx: Ctx, b: BatchRow, which: "output" | "errors") {
  if (b.purgedAt) fail(410, `The results of batch ${b.id} were deleted when they expired.`, "batch_results_expired");
  const statuses = which === "output" ? ["succeeded"] : ["failed", "cancelled", "expired"];
  const rows = await ctx.db.select().from(batchLines).where(and(eq(batchLines.batchId, b.id), inArray(batchLines.status, statuses))).orderBy(batchLines.idx);
  const stored = await batchStore(ctx).results(b);
  return rows
    .map((l) => {
      const r = stored.get(l.idx);
      const id = `batch_req_${b.id.slice(6)}_${l.idx}`;
      if (!r) return { id, custom_id: null, response: null, error: { code: l.failureCode ?? "result_unavailable", message: "The result of this line is no longer available." } };
      return { id, custom_id: r.custom_id, response: r.status_code == null ? null : { status_code: r.status_code, request_id: r.request_id, body: r.body }, error: r.error };
    })
    .map((line) => JSON.stringify(line) + "\n")
    .join("");
}

// ---- cancel --------------------------------------------------------------------------------------------------------

/** Queued lines are never run or billed; lines already running finish and are billed as usual. */
export async function cancelBatch(ctx: Ctx, b: BatchRow) {
  if (TERMINAL.has(b.status) || b.status === "cancelling") return b;
  await ctx.db.update(batches).set({ status: "cancelling", cancellingAt: new Date() }).where(and(eq(batches.id, b.id), inArray(batches.status, ["validating", "in_progress"])));
  await closeQueued(ctx, b, "cancelled", "batch_cancelled", "The batch was cancelled before this line ran. It was not billed.");
  await finishIfDone(ctx, b.id);
  return (await ctx.db.select().from(batches).where(eq(batches.id, b.id)))[0];
}

async function closeQueued(ctx: Ctx, b: BatchRow, status: "cancelled" | "expired", code: string, message: string) {
  const closed = await ctx.db
    .update(batchLines)
    .set({ status, failureCode: code, finishedAt: new Date() })
    .where(and(eq(batchLines.batchId, b.id), eq(batchLines.status, "queued")))
    .returning({ idx: batchLines.idx });
  if (!closed.length) return;
  const store = batchStore(ctx);
  const results: [number, LineResult][] = [];
  for (const { idx } of closed) results.push([idx, { custom_id: (await store.input(b, idx))?.custom_id ?? "", status_code: null, request_id: null, body: null, error: { code, message } }]);
  await store.saveResults(b, results, storeTtl(ctx, b));
}

/** A batch whose lines have all ended gets its final status, and its answers their BATCH_RESULTS_TTL. */
async function finishIfDone(ctx: Ctx, id: string) {
  const [{ open }] = await ctx.db.select({ open: sql<number>`count(*)::int` }).from(batchLines).where(and(eq(batchLines.batchId, id), inArray(batchLines.status, ["queued", "running"])));
  if (open > 0) return;
  const [b] = await ctx.db.select().from(batches).where(eq(batches.id, id));
  if (!b || TERMINAL.has(b.status)) return;
  const [{ expired }] = await ctx.db.select({ expired: sql<number>`count(*)::int` }).from(batchLines).where(and(eq(batchLines.batchId, id), eq(batchLines.status, "expired")));
  const status = b.status === "cancelling" ? "cancelled" : expired > 0 ? "expired" : b.completed === 0 && b.failed > 0 ? "failed" : "completed";
  const now = new Date();
  const resultsExpireAt = new Date(now.getTime() + ctx.cfg.batch.resultsTtlS * 1000);
  const [done] = await ctx.db
    .update(batches)
    .set({ status, finishedAt: now, resultsExpireAt })
    .where(and(eq(batches.id, id), inArray(batches.status, ACTIVE)))
    .returning();
  if (done) await batchStore(ctx).finish(done, ctx.cfg.batch.resultsTtlS * 1000);
}

// ---- the worker ------------------------------------------------------------------------------------------------------

/** What a finished line charged, read from its generation row (the receipt carries the batch discount exactly). */
async function chargeOf(ctx: Ctx, generationId: string): Promise<{ cost: Pico; list: Pico } | null> {
  const [g] = await ctx.db.select({ cost: generations.cost, receipt: generations.receipt }).from(generations).where(eq(generations.id, generationId));
  if (!g) return null;
  const discount = (g.receipt as { cost_details?: { batch_discount?: string } } | null)?.cost_details?.batch_discount;
  return { cost: g.cost, list: g.cost + (discount ? usdToPico(discount) : 0n) };
}

/**
 * One drain: expire and purge what is due, start waiting batches, then run up to BATCH_LINES_PER_TICK queued lines,
 * BATCH_CONCURRENCY at a time. A line that hits the key's rate limit, or finds every provider unavailable (and so was not
 * billed), goes back in the queue for later; any other answer is final.
 */
export async function runBatches(ctx: Ctx, dispatch: Dispatch) {
  const { linesPerTick, concurrency, maxAttempts } = ctx.cfg.batch;
  const now = new Date();
  // Lines whose runner vanished (a crash mid-line) end as interrupted, with whatever their generation charged: never re-run.
  const stale = await ctx.db.update(batchLines).set({ status: "failed", failureCode: "interrupted", finishedAt: now }).where(and(eq(batchLines.status, "running"), lt(batchLines.notBefore, now))).returning();
  for (const l of stale) await recordLine(ctx, l.batchId, l.idx, { status: "failed", statusCode: null, generationId: l.generationId, code: "interrupted", message: "The worker stopped while this line was running.", body: null });

  // Past the completion window: queued lines expire unbilled.
  for (const b of await ctx.db.select().from(batches).where(and(inArray(batches.status, ACTIVE), lt(batches.expiresAt, now)))) {
    await closeQueued(ctx, b, "expired", "batch_expired", "The batch's 24h completion window ended before this line ran. It was not billed.");
    await finishIfDone(ctx, b.id);
  }
  // Results past BATCH_RESULTS_TTL: the sealed answers and the line rows are deleted; the batch row keeps its totals.
  for (const b of await ctx.db.select().from(batches).where(and(isNull(batches.purgedAt), lt(batches.resultsExpireAt, now)))) {
    await batchStore(ctx).purge(b);
    await ctx.db.delete(batchLines).where(eq(batchLines.batchId, b.id));
    await ctx.db.update(batches).set({ purgedAt: now }).where(eq(batches.id, b.id));
  }
  await ctx.db.update(batches).set({ status: "in_progress", startedAt: now }).where(eq(batches.status, "validating"));

  // Claim lines: status running, and a lease (not_before) after which a line still running is treated as interrupted.
  const lease = new Date(now.getTime() + ctx.cfg.routing.providerTimeoutMs * (ctx.cfg.routing.maxAttempts + 1) + 60_000);
  const picked = await ctx.db
    .select({ batchId: batchLines.batchId, idx: batchLines.idx })
    .from(batchLines)
    .innerJoin(batches, eq(batches.id, batchLines.batchId))
    .where(and(eq(batchLines.status, "queued"), sql`${batchLines.notBefore} <= now()`, eq(batches.status, "in_progress")))
    .orderBy(batches.createdAt, batchLines.idx)
    .limit(linesPerTick);
  const claimed: { batchId: string; idx: number; attempts: number; generationId: string }[] = [];
  for (const p of picked) {
    const generationId = genId();
    const [row] = await ctx.db
      .update(batchLines)
      .set({ status: "running", attempts: sql`${batchLines.attempts} + 1`, notBefore: lease, generationId })
      .where(and(eq(batchLines.batchId, p.batchId), eq(batchLines.idx, p.idx), eq(batchLines.status, "queued")))
      .returning({ attempts: batchLines.attempts });
    if (row) claimed.push({ ...p, attempts: row.attempts, generationId });
  }
  if (!claimed.length) return { ran: 0 };
  const rows = new Map((await ctx.db.select().from(batches).where(inArray(batches.id, [...new Set(claimed.map((c) => c.batchId))]))).map((b) => [b.id, b]));
  const throttled = new Map<string, Date>(); // key hash -> when its rate limit frees up

  let ran = 0;
  const queue = [...claimed];
  const requeue = (l: (typeof claimed)[number], at: Date, countAttempt: boolean) =>
    ctx.db
      .update(batchLines)
      .set({ status: "queued", notBefore: at, generationId: null, ...(countAttempt ? {} : { attempts: sql`${batchLines.attempts} - 1` }) })
      .where(and(eq(batchLines.batchId, l.batchId), eq(batchLines.idx, l.idx)));
  const worker = async () => {
    for (let l = queue.shift(); l; l = queue.shift()) {
      const b = rows.get(l.batchId)!;
      const [{ status: now } = { status: "gone" }] = await ctx.db.select({ status: batches.status }).from(batches).where(eq(batches.id, b.id));
      if (now !== "in_progress") {
        // Cancelled (or expired) while this line waited its turn in the drain: it ends unrun and unbilled.
        await ctx.db.update(batchLines).set({ status: "queued", generationId: null }).where(and(eq(batchLines.batchId, l.batchId), eq(batchLines.idx, l.idx)));
        await closeQueued(ctx, b, now === "cancelling" ? "cancelled" : "expired", now === "cancelling" ? "batch_cancelled" : "batch_expired", "The batch ended before this line ran. It was not billed.");
        continue;
      }
      const wait = throttled.get(b.keyHash);
      if (wait) {
        await requeue(l, wait, false);
        continue;
      }
      const input = await batchStore(ctx).input(b, l.idx);
      if (!input) {
        await recordLine(ctx, b.id, l.idx, { status: "failed", statusCode: null, generationId: null, code: "input_unavailable", message: "The request for this line is no longer available. It was not run or billed.", body: null });
        continue;
      }
      const marker: BatchLine = { batchId: b.id, idx: l.idx, keyHash: b.keyHash, discountBps: b.discountBps, generationId: l.generationId };
      let status = 0;
      let json: any = null;
      let retryAfter = 0;
      try {
        const res = await dispatch(PATH[b.api as BatchApi], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input.body) }, { [BATCH_LINE]: marker });
        status = res.status;
        retryAfter = Number(res.headers.get("retry-after") ?? 0);
        const text = await res.text();
        try { json = JSON.parse(text); } catch { json = { error: { message: "The router returned an unreadable answer.", type: "internal" } }; }
      } catch (e) {
        status = 500;
        json = { error: { message: "The router could not run this line.", type: "internal" } };
        log.error("batch line dispatch failed", { batch: b.id, line: l.idx, error: (e as Error).message });
      }
      ran++;
      const charge = await chargeOf(ctx, l.generationId);
      if (status === 429 && json?.error?.type === "rate_limited") {
        const at = new Date(Date.now() + Math.max(1, retryAfter || 5) * 1000);
        throttled.set(b.keyHash, at);
        await requeue(l, at, false); // the key's own rate limit: wait, do not count it against the line
        continue;
      }
      if (status >= 500 && !charge && l.attempts < maxAttempts) {
        await requeue(l, new Date(Date.now() + 15_000 * l.attempts), true); // nothing was served or billed: try again later
        continue;
      }
      const ok = status === 200;
      await recordLine(ctx, b.id, l.idx, {
        status: ok ? "succeeded" : "failed",
        statusCode: status,
        generationId: charge ? l.generationId : ok ? (json?.id ?? null) : null,
        code: ok ? null : String(json?.error?.type ?? "error"),
        message: ok ? null : String(json?.error?.message ?? "The line failed."),
        body: json,
        customId: input.custom_id,
        charge,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, claimed.length) }, worker));
  for (const id of rows.keys()) await finishIfDone(ctx, id);
  return { ran, claimed: claimed.length };
}

/** Store a line's sealed result and end its row, adding its charge to the batch's totals. */
async function recordLine(
  ctx: Ctx,
  batchId: string,
  idx: number,
  r: { status: "succeeded" | "failed"; statusCode: number | null; generationId: string | null; code: string | null; message: string | null; body: unknown; customId?: string; charge?: { cost: Pico; list: Pico } | null },
) {
  const [b] = await ctx.db.select().from(batches).where(eq(batches.id, batchId));
  if (!b) return;
  const store = batchStore(ctx);
  const charge = r.charge !== undefined ? r.charge : r.generationId ? await chargeOf(ctx, r.generationId) : null;
  const customId = r.customId ?? (await store.input(b, idx))?.custom_id ?? "";
  const result: LineResult = {
    custom_id: customId,
    status_code: r.statusCode,
    request_id: r.generationId,
    body: r.body,
    error: r.code ? { code: r.code, message: r.message ?? "" } : null,
  };
  await store.saveResults(b, [[idx, result]], storeTtl(ctx, b));
  const cost = charge?.cost ?? 0n;
  const list = charge?.list ?? 0n;
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(batchLines)
      .set({ status: r.status, statusCode: r.statusCode, generationId: r.generationId, cost, listCost: list, failureCode: r.code, finishedAt: new Date() })
      .where(and(eq(batchLines.batchId, batchId), eq(batchLines.idx, idx)));
    await tx
      .update(batches)
      .set({
        ...(r.status === "succeeded" ? { completed: sql`${batches.completed} + 1` } : { failed: sql`${batches.failed} + 1` }),
        cost: sql`${batches.cost} + ${cost}`,
        listCost: sql`${batches.listCost} + ${list}`,
      })
      .where(eq(batches.id, batchId));
  });
}
