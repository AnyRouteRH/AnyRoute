import type { Context, Hono } from "hono";
import type { Ctx } from "../context.ts";
import { requireKey, requireRole } from "./auth.ts";
import { readJson } from "./common.ts";
import { batchFor, batchJson, batchResults, cancelBatch, createBatch, listBatches } from "../services/batches.ts";

// OpenAI-compatible Batch API (services/batches.ts). A prepaid key submits up to BATCH_MAX_LINES chat or embeddings requests
// inline (`requests`, or `input_jsonl` text: this router has no files endpoint); the worker runs them in spare capacity at
// BATCH_DISCOUNT_BPS off, each with its own hold, charge and signed receipt. A batch is visible only to the key that sent it.
//
//   POST /api/v1/batches                  submit            GET /api/v1/batches/:id          status and counts
//   GET  /api/v1/batches                  list (newest)     POST /api/v1/batches/:id/cancel  cancel queued lines
//   GET  /api/v1/batches/:id/output       JSONL answers     GET  /api/v1/batches/:id/errors  JSONL failures
export function batchesRoutes(app: Hono, ctx: Ctx) {
  const caller = async (c: Context) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, key, ["owner", "admin", "member"]);
    return key;
  };
  const jsonl = (c: Context, text: string) => c.body(text, 200, { "content-type": "application/jsonl; charset=utf-8", "cache-control": "no-store" });

  for (const base of ["/api/v1/batches", "/v1/batches"]) {
    app.post(base, async (c) => {
      const key = await caller(c);
      const body = await readJson(c); // the lines are sealed out of Postgres at once (services/batches.ts)
      return c.json(batchJson(await createBatch(ctx, key, body)));
    });
    app.get(base, async (c) => {
      const key = await caller(c);
      const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20) || 20));
      const { rows, hasMore } = await listBatches(ctx, key.keyHash, { limit, after: c.req.query("after") || undefined });
      const data = rows.map(batchJson);
      return c.json({ object: "list", data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null, has_more: hasMore });
    });
    app.get(`${base}/:id`, async (c) => c.json(batchJson(await batchFor(ctx, (await caller(c)).keyHash, c.req.param("id")))));
    app.post(`${base}/:id/cancel`, async (c) => c.json(batchJson(await cancelBatch(ctx, await batchFor(ctx, (await caller(c)).keyHash, c.req.param("id"))))));
    app.get(`${base}/:id/output`, async (c) => jsonl(c, await batchResults(ctx, await batchFor(ctx, (await caller(c)).keyHash, c.req.param("id")), "output")));
    app.get(`${base}/:id/errors`, async (c) => jsonl(c, await batchResults(ctx, await batchFor(ctx, (await caller(c)).keyHash, c.req.param("id")), "errors")));
  }
}
