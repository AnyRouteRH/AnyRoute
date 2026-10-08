import type { Hono, MiddlewareHandler } from "hono";
import type { Ctx } from "../context.ts";
import { KEY_RE } from "../chain/keys.ts";
import { bearer, requireKey, requireRole } from "../api/auth.ts";
import { EXPOSED_RESPONSE_HEADERS, readJson } from "../api/common.ts";
import { fail } from "../lib/errors.ts";
import { canonicalJson, sha256 } from "../lib/util.ts";
import { idempotencyStore, type Result } from "./store.ts";

export const IDEMPOTENCY_PATH = /^\/(?:api\/v1|v1)\/(chat\/completions|completions|messages|responses|embeddings|rerank)$/;
const KEPT_HEADERS = [...EXPOSED_RESPONSE_HEADERS, "content-type", "request-id", "x-anyroute-json-check", "x-anyroute-route"];

// D145: runs outside adapters, so each format keeps its own final JSON; inner calls have no header.
export function idempotencyMiddleware(app: Hono, ctx: Ctx) {
  app.use("*", async (c, next) => {
    const id = c.req.header("idempotency-key");
    const path = c.req.path.match(IDEMPOTENCY_PATH);
    if (id === undefined || c.req.method !== "POST" || !path) return next();
    if (!/^[\x21-\x7e]{1,128}$/.test(id)) fail(400, "Idempotency-Key must contain 1–128 visible ASCII characters.", "invalid_idempotency_key");
    let auth = c.req.header("authorization");
    if (path[1] === "messages") {
      const credentials = [c.req.header("x-api-key"), bearer(auth)].map(v => v?.trim()).filter((v): v is string => !!v);
      const credential = credentials.find(v => KEY_RE.test(v)) ?? credentials[0];
      auth = credential ? `Bearer ${credential}` : undefined;
    }
    const key = await requireKey(ctx, auth);
    await requireRole(ctx, key, ["owner", "admin", "member"]);
    const body = await readJson(c);
    const hash = sha256(path[1] + "\0" + canonicalJson(body));
    const store = idempotencyStore(ctx);
    const ref = store.ref(key.accountId, key.keyHash, id);
    const claim = await store.claim(ref, hash).catch(() => fail(503, "Retry protection is unavailable. Retry later with the same key.", "idempotency_unavailable"));
    if (!claim.first) {
      if (claim.entry.hash !== hash) fail(422, "This Idempotency-Key was already used for a different request.", "idempotency_key_reused");
      const result = claim.entry.result;
      if (!result) fail(409, "The first request is still running or its final result could not be kept.", "idempotency_in_progress");
      if (result.body === undefined) fail(409, "The reply was not kept. Use the original receipt to check this call.", "idempotency_result_not_kept", { receipt_id: result.headers["x-receipt-id"] ?? null }, result.headers["x-receipt-id"] ? { "x-receipt-id": result.headers["x-receipt-id"] } : undefined);
      return new Response(result.body, { status: result.status, headers: { ...result.headers, "idempotent-replay": "true" } });
    }
    await next();
    const response = c.res;
    const result: Result = { status: response.status, headers: Object.fromEntries(KEPT_HEADERS.flatMap(h => response.headers.has(h) ? [[h, response.headers.get(h)!]] : [])) };
    if (response.headers.get("content-type")?.includes("text/event-stream") && response.body) {
      const reader = response.body.getReader();
      const finish = () => store.finish(ref, claim, result).catch(() => undefined); // A failed write leaves the guard in progress, never reruns billing.
      c.res = new Response(new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { await finish(); controller.close(); }
            else controller.enqueue(chunk.value);
          } catch (error) { await finish(); controller.error(error); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { await finish(); } },
      }), { status: response.status, headers: response.headers });
      return;
    }
    result.body = await response.clone().text();
    await store.finish(ref, claim, result).catch(() => undefined);
  });
}

// Leave headerless responses/preflights byte-identical, including existing origin-lock refusals.
export const idempotencyCors: MiddlewareHandler = async (c, next) => {
  await next();
  if (!IDEMPOTENCY_PATH.test(c.req.path)) return;
  if (c.req.method === "OPTIONS") {
    const allowed = c.res.headers.get("access-control-allow-headers");
    if (allowed && c.req.header("access-control-request-headers")?.toLowerCase().split(",").some(h => h.trim() === "idempotency-key")) c.header("access-control-allow-headers", allowed + ",idempotency-key");
  } else if (c.req.header("idempotency-key") !== undefined && c.res.headers.has("access-control-expose-headers")) {
    c.header("access-control-expose-headers", c.res.headers.get("access-control-expose-headers") + ",idempotent-replay");
  }
};
