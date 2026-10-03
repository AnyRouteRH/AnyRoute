import type { Context, Hono } from "hono";
import type { Ctx } from "../context.ts";
import { ApiError } from "../lib/errors.ts";
import { ONION_HEADER } from "../lib/onion.ts";
import { clientIp, EXPOSED_RESPONSE_HEADERS, readJson } from "./common.ts";
import { chatRequestFrom, refuse, responseFromChat, translateChatStream, type Meta } from "./responses-map.ts";

// OpenAI Responses API compatible endpoint: POST /v1/responses (and /api/v1/responses), so the OpenAI Agents SDK, the
// Codex CLI and other Responses clients can use AnyRoute. It is an adapter: the request is translated and sent to
// /api/v1/chat/completions in-process with the caller's own credentials and routing headers, so keys, balance, limits,
// lanes, disclosure ceilings, signed receipts and the X-Receipt-Id / Inference-Id / X-Anyroute-Lane /
// X-Anyroute-Policy-Hash headers are exactly those of a chat call. It is stateless by design: nothing is stored, so
// `store: true`, `previous_response_id` and the calls that would read stored responses are refused.

const CHAT = "/api/v1/chat/completions";

/** Request headers the chat route reads: credentials, payment, routing (lane, disclosure) and tracing. */
const FORWARD = ["authorization", "x-pay-with", "x-payment", "payment-signature", "payment-recovery", "x-wallet-auth", "x-anyroute-lane", "x-anyroute-lane-downgrade", "x-anyroute-disclosure-max", "x-anyroute-cache", "http-referer", "x-title", "traceparent", ONION_HEADER, "x-anyroute-decision-tag" /* B */];
/** Response headers passed on: the receipt, lane and policy headers, the payment headers and what a client needs to retry. */
const PASS = [...EXPOSED_RESPONSE_HEADERS, "www-authenticate"];

const NOT_STORED =
  "AnyRoute is stateless: it stores no responses, conversations or input items, so there is nothing to retrieve, list, cancel or delete. A response is returned by the call that creates it. Each call has a signed receipt, which holds no prompt or answer: GET /api/v1/receipts/{id}, with the id from the X-Receipt-Id header or the response metadata (anyroute_receipt_id).";

export function responsesRoutes(app: Hono, ctx: Ctx) {
  const passHeaders = (res: Response) => {
    const out: Record<string, string> = {};
    for (const name of PASS) {
      const v = res.headers.get(name);
      if (v !== null) out[name] = v;
    }
    return out;
  };

  const create = async (c: Context): Promise<Response> => {
    const createdAt = Math.floor(Date.now() / 1000);
    const { chat, echo, stream } = chatRequestFrom(await readJson(c));
    const headers: Record<string, string> = { "content-type": "application/json" };
    for (const name of FORWARD) {
      const v = c.req.header(name);
      if (v !== undefined) headers[name] = v;
    }
    // The inner request has no socket of its own: hand it the caller's address so per-address limits count the caller.
    const from = clientIp(c, ctx.cfg.trustProxy);
    const res = await app.request(CHAT, { method: "POST", headers, body: JSON.stringify(chat), signal: c.req.raw.signal }, { requestIP: () => ({ address: from }) });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") throw new ApiError(res.status, `The router answered ${res.status}.`, "upstream_error");
      return c.json(body, res.status as never, passHeaders(res));
    }

    const meta: Meta = {
      receiptId: res.headers.get("x-receipt-id"),
      lane: res.headers.get("x-anyroute-lane"),
      disclosure: res.headers.get("x-anyroute-disclosure"),
      policyHash: res.headers.get("x-anyroute-policy-hash"),
    };
    if (stream && res.body && (res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      return new Response(translateChatStream(res.body, echo, meta, createdAt), {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no", ...passHeaders(res) },
      });
    }
    const out = (await res.json()) as Record<string, unknown>;
    return c.json(responseFromChat(out, echo, meta, createdAt), 200, passHeaders(res));
  };

  for (const base of ["/v1/responses", "/api/v1/responses"]) {
    app.post(base, create);
    // Everything else under /responses reads or changes stored state, which does not exist.
    app.all(`${base}/*`, () => {
      throw refuse(NOT_STORED, "responses_not_stored", null, 404);
    });
  }
}
