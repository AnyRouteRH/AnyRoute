import type { Context, Hono } from "hono";
import type { Ctx } from "../context.ts";
import { bearer } from "../api/auth.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsdString, usdToPico } from "../lib/money.ts";
import { checkText, MAX_OUTPUT_BYTES, schemaIssues, type Check } from "./validator.ts";
import type { JsonCheckMode } from "./options.ts";
import { noteUnparseableRepair } from "../services/makegood.ts"; // V6 R

const HEADER = "x-anyroute-json-check";
type State = { mode: JsonCheckMode; body: Record<string, any>; format: Record<string, any> };
const states = new WeakMap<Request, State>();
const retries = new WeakMap<Request, { model: string; provider: string }>();

/** V83: capture resolved presets/preferences before routing; nothing changes when disabled or absent. */
export function captureStructuredOutput(ctx: Ctx, c: Context, kind: string, body: Record<string, any>) {
  const pin = retries.get(c.req.raw);
  if (pin) {
    // Apply after key aliases and presets, so neither can redirect a correction to another model.
    body.model = pin.model;
    body.models = [pin.model];
    body.provider = { ...body.provider, only: [pin.provider], allow_fallbacks: false };
    return;
  }
  if (!ctx.cfg.structuredOutputCheckEnabled || body.anyroute?.json_check == null) return;
  if (!["/api/v1/chat/completions", "/v1/chat/completions"].includes(new URL(c.req.url).pathname)) fail(400, "JSON checking is supported only on chat completions endpoints.", "invalid_request");
  const mode = body.anyroute.json_check;
  if (mode !== "validate" && mode !== "repair") fail(400, "anyroute.json_check must be validate or repair.", "invalid_request");
  if (kind !== "chat" || body.model === "anyroute/council" || body.verify != null || (body.n ?? 1) !== 1)
    fail(400, "JSON checking requires a single chat answer; council, dual verification and n > 1 are not supported.", "invalid_request");
  const format = body.response_format;
  if (!format || !["json_object", "json_schema"].includes(format.type)) fail(400, "JSON checking requires response_format json_object or json_schema.", "invalid_request");
  if (format.type === "json_schema") {
    const errors = schemaIssues(format.json_schema?.schema);
    if (errors.length) fail(400, "JSON checking cannot validate this schema.", "invalid_request", { errors });
  }
  // Streams validate only. A blind token or a single payment cannot authorize two independent charges.
  if (mode === "repair" && body.stream !== true && !bearer(c.req.header("authorization")))
    fail(400, "JSON repair requires a bearer API key because each call is charged separately.", "invalid_request");
  states.set(c.req.raw, { mode, body, format });
  if (mode === "repair" && body.stream !== true) body.cache = { mode: "off" };
  const { json_check: _check, ...other } = body.anyroute;
  if (Object.keys(other).length) body.anyroute = other;
  else delete body.anyroute;
}

type Call = { attempt: number; cost: string; receipt: Record<string, any> };
const callOf = (json: Record<string, any>, attempt: number): Call => ({ attempt, cost: json.receipt.payload.cost, receipt: json.receipt });
const total = (calls: Call[]) => picoToUsdString(calls.reduce((sum, call) => sum + usdToPico(call.cost), 0n));
const report = (state: State, check: Check, calls: Call[], extra: Record<string, unknown> = {}) => ({ mode: state.mode, ...check, retry_attempted: calls.length > 1, calls, total_cost: total(calls), ...extra });
function jsonResponse(res: Response, json: Record<string, any>, check: Check, details: Record<string, unknown>) {
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.set(HEADER, check.valid ? "valid" : "invalid");
  // Supplemental response metadata. The original payload/sig and v2 bytes stay intact.
  return new Response(JSON.stringify({ ...json, receipt: { ...json.receipt, structured_output: details } }), { status: res.status, headers });
}

async function checkedResponse(app: Hono, ctx: Ctx, c: Context, first: Response, state: State): Promise<Response> {
  if (!first.ok) return first;
  if (state.body.stream === true) return checkedStream(first, state);
  const json: Record<string, any> = await first.json() as Record<string, any>;
  const initial = checkText(json.choices?.[0]?.message?.content, state.format);
  const calls = [callOf(json, 1)];
  if (initial.valid || state.mode === "validate") return jsonResponse(first, json, initial, report(state, initial, calls));
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES)
    return jsonResponse(first, json, initial, report(state, initial, calls, { retry_error: { reason: "repair requires text within the 1 MiB limit" } }));
  // Preserve the serving model's routing modifiers, including :private restrictions.
  const pinnedModel = [state.body.model, ...(state.body.models ?? [])].find(id => typeof id === "string" && ctx.catalog.resolve(id)?.model.id === json.model) ?? json.model;
  const body = {
    ...state.body,
    model: pinnedModel,
    models: [pinnedModel],
    // No model/provider fallback on the correction. The core's MUST_SUPPORT check is untouched.
    provider: { ...state.body.provider, only: [json.receipt.payload.provider], allow_fallbacks: false },
    cache: undefined,
    transforms: undefined,
    messages: [...state.body.messages, { role: "assistant", content: text }, { role: "user", content: `Correct the previous output. Return corrected JSON only, with no markdown or explanation, matching the original response_format. Validation errors (JSON Pointer path and reason): ${JSON.stringify(initial.errors)}` }],
  };
  const headers = new Headers(c.req.raw.headers);
  headers.delete("content-length");
  headers.delete("x-anyroute-cache");
  headers.delete("x-agent-approval"); // An approval authorizes one call, never two.
  const request = new Request(c.req.url, { method: "POST", headers, body: JSON.stringify(body), signal: c.req.raw.signal });
  retries.set(request, { model: pinnedModel, provider: json.receipt.payload.provider });
  let second: Response;
  try { second = await app.request(request, undefined, c.env); }
  catch { return jsonResponse(first, json, initial, report(state, initial, calls, { retry_attempted: true, retry_error: { reason: "repair request failed" } })); }
  if (!second.ok) {
    // Attestation refusals may follow settlement: never hide a signed charge on an error response.
    const denied = await second.json().catch(() => null) as Record<string, any> | null;
    if (typeof denied?.receipt?.payload?.cost === "string") calls.push(callOf(denied, 2));
    return jsonResponse(first, json, initial, report(state, initial, calls, { retry_attempted: true, retry_error: { status: second.status, reason: "repair did not return a usable answer; all signed charges are listed" } }));
  }
  const fixed: Record<string, any> = await second.json() as Record<string, any>;
  calls.push(callOf(fixed, 2));
  const check = checkText(fixed.choices?.[0]?.message?.content, state.format);
  if (!check.valid) await noteUnparseableRepair(ctx, fixed.id, fixed.choices?.[0]?.message?.content, json.id ?? null).catch(() => undefined); // V6 R
  return jsonResponse(second, fixed, check, report(state, check, calls, { initial_errors: initial.errors }));
}

/** Only the terminal, unchained receipt event is augmented; all content and chain comments pass unchanged. */
function checkedStream(res: Response, state: State): Response {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "", text = "", overLimit = false, complete = false, interrupted = false;
  const headers = new Headers(res.headers);
  headers.set(HEADER, state.mode === "repair" ? "pending; repair-unsupported" : "pending");
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n\n")) !== -1) {
        let frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (frame.startsWith("data: ") && frame !== "data: [DONE]") {
          const ev = JSON.parse(frame.slice(6));
          if (ev.error) interrupted = true;
          for (const choice of ev.choices ?? []) {
            const delta = choice.delta?.content;
            if (!overLimit && typeof delta === "string") {
              text += delta;
              if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) { text = ""; overLimit = true; }
            }
            if (choice.finish_reason) { complete = true; if (choice.finish_reason === "error") interrupted = true; }
          }
          if (ev.receipt) {
            const check: Check = overLimit ? { valid: false, errors: [{ path: "", reason: "output exceeds the 1 MiB validation limit" }] } : interrupted || !complete ? { valid: false, errors: [{ path: "", reason: "stream did not complete" }] } : checkText(text, state.format);
            frame = `data: ${JSON.stringify({ ...ev, receipt: { ...ev.receipt, structured_output: report(state, check, [callOf(ev, 1)], { ...(state.mode === "repair" ? { repair_supported: false, note: "streams validate only; no repair call was made" } : {}) }) } })}`;
          }
        }
        controller.enqueue(encoder.encode(frame + "\n\n"));
      }
    },
    flush(controller) { pending += decoder.decode(); if (pending) controller.enqueue(encoder.encode(pending)); },
  });
  return new Response(res.body!.pipeThrough(transform), { status: res.status, headers });
}

/** V83: uses the ordinary route for every charged call, preserving auth, lanes, billing and signed receipts. */
export function structuredOutputMiddleware(app: Hono, ctx: Ctx) {
  const middleware = async (c: Context, next: () => Promise<void>) => {
    await next();
    const state = states.get(c.req.raw);
    if (ctx.cfg.structuredOutputCheckEnabled && state) {
      const previous = c.res;
      const checked = await checkedResponse(app, ctx, c, previous, state);
      if (checked !== previous) {
        // Hono merges old headers into replacements. Use the returned call's receipt/lane headers.
        for (const key of [...previous.headers.keys()]) previous.headers.delete(key);
        c.res = checked;
      }
    }
  };
  app.use("/api/v1/chat/completions", middleware);
  app.use("/v1/chat/completions", middleware);
}
