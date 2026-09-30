import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../lib/api.js";
import {
  ATTESTED_LANE, BatchRunner, LANE_COLUMNS, MAX_ROWS, backoffMs, countFailedClosed, failClosed, laneMismatch, makeSender, modelsOnLane, routesOnLane, rowsOffLane, servedFrom, buildDefaults, checkFunds, classifyError, csvCell, detectFormat, estimateBatch, estimateRow, normalizeRoutes,
  parseBatch, parseCSV, parseRetryAfter, priceIndex, promptChars, restoreStates, resultRecord, retryAfterMs, rowsPerMinute, summarize, toCSV, toJSONL, validateBody,
  SERVER_DISCOUNT_BPS, SERVER_MAX_BYTES, SERVER_MAX_LINES, checkServerBatch, estimateServerBatch, newState, parseServerResults, serverBatchDone, serverInputBytes, serverLineErrors, serverProgress, toServerRequests,
} from "../lib/batch.js";

// ---------------------------------------------------------------- helpers

const flush = async () => {
  for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r));
};

/** A manual clock: timers fire only when the test advances time. */
function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      timers.set(++seq, { at: t + Math.max(0, ms), fn });
      return seq;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await flush();
        let next = null;
        for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
      await flush();
    },
  };
}

const ok = (id, n) => ({ json: { id: "gen-" + id + "-" + n, model: "m/x", choices: [{ message: { role: "assistant", content: "answer " + id }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.001 }, receipt: { id: "gen-" + id + "-" + n } } });
const err = (status, type, extra = {}) => ({ status, json: { error: { code: status, message: `${type} (${status})`, type, ...extra } } });

/**
 * A fake router behind globalThis.fetch. `script(customId, attempt)` returns { status, json, delay, network }.
 * Responses arrive after `delay` fake milliseconds (default 100); an abort rejects like the real fetch.
 */
function fakeRouter(clock, script) {
  const calls = [];
  let active = 0;
  let peak = 0;
  const attempts = {};
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const id = body.messages[0].content;
    const n = (attempts[id] = (attempts[id] || 0) + 1);
    const reply = script(id, n) || ok(id, n);
    active++;
    peak = Math.max(peak, active);
    calls.push({ id, n, at: clock.now(), active, url, init, body });
    try {
      await new Promise((resolve, reject) => {
        const h = clock.setTimeout(resolve, reply.delay ?? 100);
        init.signal?.addEventListener("abort", () => {
          clock.clearTimeout(h);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    } finally {
      active--;
    }
    if (reply.network) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(reply.json ?? ok(id, n).json), { status: reply.status ?? 200, headers: reply.headers });
  };
  return {
    calls,
    get peak() {
      return peak;
    },
    of: (id) => calls.filter((c) => c.id === id),
    install() {
      const real = globalThis.fetch;
      globalThis.fetch = fetch;
      return () => (globalThis.fetch = real);
    },
  };
}

const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ index: i, line: i + 1, custom_id: "r" + i, body: { model: "m/x", messages: [{ role: "user", content: "r" + i }], max_tokens: 16 } }));
const send = (body, { signal }) => api("/api/v1/chat/completions", { key: "test-key", method: "POST", body, signal });

async function harness(t, { rows = 4, concurrency = 2, script = () => null, ...opts } = {}) {
  const clock = fakeClock();
  const router = fakeRouter(clock, script);
  t.after(router.install());
  const changes = [];
  const runner = new BatchRunner({ rows: rowsOf(rows), send, concurrency, clock, random: () => 0.5, onChange: (i) => changes.push(i), ...opts });
  return { clock, router, runner, changes, st: (i) => runner.states[i] };
}

// ---------------------------------------------------------------- parsing

test("format detection prefers the file extension, then the first character", () => {
  assert.equal(detectFormat("prompt\nhi", "rows.jsonl"), "jsonl");
  assert.equal(detectFormat('{"prompt":"hi"}', "rows.CSV"), "csv");
  assert.equal(detectFormat('\ufeff  {"prompt":"hi"}'), "jsonl");
  assert.equal(detectFormat("prompt,custom_id\nhi,a"), "csv");
});

test("CSV parsing handles quotes, escaped quotes, embedded newlines, CRLF, a BOM and blank lines", () => {
  const { records, error } = parseCSV('\ufeffcustom_id,prompt\r\na,"Hello, ""world"""\r\n\r\nb,"two\nlines"\nc,plain\n');
  assert.equal(error, null);
  assert.deepEqual(records.map((r) => r.fields), [["custom_id", "prompt"], ["a", 'Hello, "world"'], ["b", "two\nlines"], ["c", "plain"]]);
  assert.deepEqual(records.map((r) => r.line), [1, 2, 4, 6]);
  assert.match(parseCSV('prompt\n"never closed\n').error.message, /never closed/);
});

test("JSONL accepts OpenAI batch lines and simple prompt lines, and applies defaults only where a row is silent", () => {
  const text = [
    '{"custom_id":"a","method":"POST","url":"/v1/chat/completions","body":{"model":"m/row","messages":[{"role":"user","content":"Hi"}],"max_tokens":9,"stream":true}}',
    "",
    '{"prompt":"Summarize this."}',
    '{"custom_id":7,"prompt":"Seven","model":"m/own"}',
    '{"custom_id":"c","body":{"messages":[{"role":"system","content":"Be brief."},{"role":"user","content":[{"type":"text","text":"Hello"}]}],"max_completion_tokens":5}}',
  ].join("\n");
  const { defaults } = buildDefaults({ model: "m/default", maxTokens: "256", temperature: "0.2", extra: '{"provider":{"private":true}}' });
  const out = parseBatch(text, { defaults });
  assert.equal(out.format, "jsonl");
  assert.deepEqual(out.errors, []);
  assert.equal(out.total, 4);
  const [a, b, seven, c] = out.rows;
  assert.deepEqual([a.custom_id, b.custom_id, seven.custom_id, c.custom_id], ["a", "row-2", "7", "c"]);
  assert.deepEqual([a.line, b.line, seven.line, c.line], [1, 3, 4, 5]);
  assert.equal(a.body.model, "m/row");
  assert.equal(a.body.max_tokens, 9);
  assert.equal(a.body.temperature, 0.2);
  assert.equal("stream" in a.body, false, "rows are always sent without streaming");
  assert.deepEqual(b.body, { model: "m/default", messages: [{ role: "user", content: "Summarize this." }], provider: { private: true }, max_tokens: 256, temperature: 0.2 });
  assert.equal(seven.body.model, "m/own");
  assert.equal(c.body.max_tokens, undefined, "max_completion_tokens already caps the output");
  assert.equal(c.body.model, "m/default");
});

test("each invalid JSONL row gets a clear error with its line, and valid rows still load", () => {
  const lines = [
    "{not json",
    "[1,2]",
    '{"custom_id":"x"}',
    '{"custom_id":"y","prompt":"p","body":{}}',
    '{"prompt":"p","temperature":1}',
    '{"body":{"model":"m","messages":[{"role":"user","content":"x"}]},"url":"/v1/embeddings"}',
    '{"body":{"model":"m","messages":[{"role":"user","content":"x"}]},"method":"GET"}',
    '{"prompt":"   "}',
    '{"custom_id":"dup","prompt":"one","model":"m"}',
    '{"custom_id":"dup","prompt":"two","model":"m"}',
    '{"body":{"model":"m","messages":[{"role":"robot","content":"x"}]}}',
    '{"body":{"model":"m","messages":[]}}',
    '{"body":{"model":"m","messages":[{"role":"user","content":"x"}],"max_tokens":0}}',
    '{"body":{"model":"m","messages":[{"role":"user","content":"x"}],"temperature":3}}',
    '{"prompt":"no model anywhere"}',
    '{"custom_id":"","prompt":"x"}',
    '{"custom_id":"good","prompt":"fine","model":"m/x"}',
  ];
  const out = parseBatch(lines.join("\n"));
  const byLine = Object.fromEntries(out.errors.map((e) => [e.line, e.message]));
  assert.match(byLine[1], /^Not valid JSON/);
  assert.match(byLine[2], /must be a JSON object/);
  assert.match(byLine[3], /Needs "body".*or "prompt"/);
  assert.match(byLine[4], /either "body".*not both/);
  assert.match(byLine[5], /Unknown field "temperature"/);
  assert.match(byLine[6], /Only chat completions/);
  assert.match(byLine[7], /"method" must be "POST"/);
  assert.match(byLine[8], /prompt is empty/);
  assert.equal(byLine[9], undefined);
  assert.match(byLine[10], /Duplicate custom_id "dup" \(first used on line 9\)/);
  assert.match(byLine[11], /role must be one of/);
  assert.match(byLine[12], /non-empty array/);
  assert.match(byLine[13], /max_tokens" must be a positive integer/);
  assert.match(byLine[14], /temperature/);
  assert.match(byLine[15], /No model/);
  assert.match(byLine[16], /custom_id" must be a non-empty string/);
  assert.equal(byLine[17], undefined);
  assert.equal(out.invalid, 15);
  assert.deepEqual(out.rows.map((r) => r.custom_id), ["dup", "good"]);
  assert.equal(out.errors.find((e) => e.line === 1).custom_id, null, "generated ids are not shown as the row's id");
  assert.match(parseBatch('[{"prompt":"x"}]').errors[0].message, /JSON array/);
});

test("generated custom_ids never collide with explicit ones", () => {
  const out = parseBatch('{"prompt":"a","model":"m"}\n{"custom_id":"row-1","prompt":"b","model":"m"}');
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.rows.map((r) => r.custom_id), ["row-1-1", "row-1"]);
});

test("CSV needs a prompt column; custom_id and model are optional and other columns are ignored", () => {
  const { defaults } = buildDefaults({ model: "m/default", maxTokens: "64" });
  const out = parseBatch('Prompt,custom_id,Model,notes\n"Hello, there",a,m/csv,x\nSecond,,,\n"",c,,\ntoo,many,m,x,extra\n', { format: "auto", defaults });
  assert.equal(out.format, "csv");
  assert.deepEqual(out.ignoredColumns, ["notes"]);
  assert.deepEqual(out.rows.map((r) => [r.custom_id, r.body.model, r.body.messages[0].content, r.body.max_tokens]), [["a", "m/csv", "Hello, there", 64], ["row-2", "m/default", "Second", 64]]);
  assert.deepEqual(out.errors.map((e) => [e.line, e.custom_id]), [[4, "c"], [5, "many"]]);
  assert.match(out.errors[0].message, /prompt is empty/);
  assert.match(out.errors[1].message, /Has 5 values but the header has 4 columns/);
  assert.match(parseBatch("question,answer\nwhy,because").errors[0].message, /"prompt" column/);
});

test(`a batch holds at most ${MAX_ROWS} rows`, () => {
  const line = '{"prompt":"x","model":"m"}';
  const max = parseBatch(Array(MAX_ROWS).fill(line).join("\n"));
  assert.equal(max.rows.length, MAX_ROWS);
  assert.equal(max.tooMany, false);
  const over = parseBatch(Array(MAX_ROWS + 1).fill(line).join("\n"));
  assert.equal(over.tooMany, true);
  assert.equal(over.rows.length, 0);
  assert.match(over.errors[0].message, /5,001 rows.*at most 5,000/);
});

test("default parameters are validated before they are applied", () => {
  assert.deepEqual(buildDefaults({ model: " m/x ", maxTokens: "", temperature: "" }), { defaults: { model: "m/x", params: {} }, error: null });
  assert.match(buildDefaults({ maxTokens: "1.5" }).error, /Max tokens/);
  assert.match(buildDefaults({ temperature: "9" }).error, /Temperature/);
  assert.match(buildDefaults({ extra: "[1]" }).error, /JSON object/);
  assert.match(buildDefaults({ extra: '{"model":"x"}' }).error, /"model" per row/);
  assert.equal(validateBody({ model: "m", messages: [{ role: "assistant", content: null, tool_calls: [{ id: "t" }] }, { role: "tool", content: "42" }] }), null);
});

test("saved routes load from any envelope and tolerate an empty or missing list", () => {
  assert.deepEqual(normalizeRoutes({ data: [{ slug: "cheap", name: "Cheap", config: { models: ["m/a", { id: "m/b" }] } }, { name: "no slug" }] }), [{ slug: "cheap", name: "Cheap", models: ["m/a", "m/b"] }]);
  assert.deepEqual(normalizeRoutes({ data: { routes: [{ slug: "x", model: "m/a" }] } }), [{ slug: "x", name: "x", models: ["m/a"] }]);
  assert.deepEqual(normalizeRoutes(null), []);
  assert.deepEqual(normalizeRoutes({ data: [] }), []);
});

// ---------------------------------------------------------------- estimates

test("estimates use chars/4 for the prompt and max_tokens for the output, priced from the catalog", () => {
  const body = { model: "m/a", messages: [{ role: "system", content: "12345678" }, { role: "user", content: [{ type: "text", text: "abcd" }, { type: "image_url", image_url: { url: "x" } }] }], max_tokens: 100 };
  assert.equal(promptChars(body), 12);
  const priceOf = priceIndex(
    [{ id: "m/a", price: 1, output: 2, contextLength: 8192 }, { id: "m/b", price: 3, output: 4, royaltyBps: 500 }],
    [{ slug: "both", models: ["m/a", "m/b"] }, { slug: "unknown", models: ["m/a", "m/zzz"] }],
  );
  const e = estimateRow(body, priceOf("m/a"));
  assert.deepEqual([e.input, e.output], [3, 100]);
  assert.ok(Math.abs(e.maxCost - (3 * 1 + 100 * 2) / 1e6) < 1e-15);
  assert.equal(estimateRow({ ...body, max_tokens: undefined }, priceOf("m/a")).output, 2048, "the router reserves a quarter of the context");
  assert.equal(estimateRow({ ...body, max_tokens: undefined }, null).output, 4096);
  const route = priceOf("@route/both");
  assert.ok(Math.abs(route.prompt - 3.15e-6) < 1e-15 && Math.abs(route.completion - 4.2e-6) < 1e-15, "a route costs at most its priciest model, royalty included");
  assert.equal(priceOf("@route/unknown"), null);
  const rows = [{ body }, { body: { ...body, model: "m/zzz" } }, { body: { ...body, models: ["m/b"] } }];
  const est = estimateBatch(rows, priceOf);
  assert.deepEqual([est.rows, est.priced, est.unpriced, est.unpricedModels, est.input, est.output], [3, 2, 1, ["m/zzz"], 9, 300]);
  assert.ok(Math.abs(est.maxCost - (203e-6 + (3 * 3.15 + 100 * 4.2) / 1e6)) < 1e-12);
});

test("the funds check compares the estimate with the tighter of balance and key budget", () => {
  assert.deepEqual(checkFunds(1, { available: 5, budgetRemaining: null }), { known: true, enough: true, limit: 5, source: "balance", shortfall: 0 });
  const tight = checkFunds(3, { available: 5, budgetRemaining: 2 });
  assert.equal(tight.enough, false);
  assert.equal(tight.source, "budget");
  assert.equal(tight.shortfall, 1);
  assert.equal(checkFunds(1, {}).known, false);
});

// ---------------------------------------------------------------- retry policy

test("Retry-After is read as seconds or an HTTP date, falling back to the router's retry_after_ms", () => {
  assert.equal(parseRetryAfter("3"), 3000);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6000);
  assert.equal(parseRetryAfter("soon"), null);
  assert.equal(retryAfterMs({ status: 429, metadata: { retry_after_ms: 1234 } }), 1234);
  assert.equal(retryAfterMs({ status: 429, retryAfter: "2", metadata: { retry_after_ms: 1234 } }), 2000);
  assert.equal(retryAfterMs({ status: 429, headers: new Headers({ "retry-after": "4" }) }), 4000);
  assert.equal(retryAfterMs({ status: 429 }), null);
  assert.deepEqual([1, 2, 3, 10].map((n) => backoffMs(n, { random: () => 0 })), [500, 1000, 2000, 15000]);
  assert.deepEqual([1, 2, 3].map((n) => backoffMs(n, { random: () => 1 })), [1000, 2000, 4000]);
  assert.deepEqual(
    [{ name: "AbortError" }, { status: 429 }, { status: 402 }, { status: 401 }, { status: 0 }, { status: 503 }, { status: 408 }, { status: 400 }, { status: 404 }].map(classifyError),
    ["aborted", "rate_limit", "funds", "auth", "transient", "transient", "transient", "fatal", "fatal"],
  );
});

// ---------------------------------------------------------------- scheduler (fake clock + fake fetch)

test("the runner keeps at most `concurrency` requests in flight and records every response", async (t) => {
  const { clock, router, runner } = await harness(t, { rows: 7, concurrency: 3 });
  runner.start();
  await clock.advance(1000);
  assert.equal(runner.status, "completed");
  assert.equal(router.peak, 3);
  assert.equal(router.calls.length, 7);
  assert.equal(router.calls[0].url, "/api/v1/chat/completions");
  assert.equal(router.calls[0].init.headers.authorization, "Bearer test-key");
  assert.equal(router.calls[0].init.method, "POST");
  const s = summarize(runner.states);
  assert.deepEqual([s.done, s.failed, s.promptTokens, s.completionTokens], [7, 0, 21, 14]);
  assert.ok(Math.abs(s.cost - 0.007) < 1e-12);
  assert.equal(await runner.settled(), "completed");
});

test("a 429 holds every new request until Retry-After, then retries the row", async (t) => {
  const { clock, router, runner, st } = await harness(t, {
    rows: 4,
    concurrency: 2,
    script: (id, n) => (id === "r0" && n === 1 ? { ...err(429, "rate_limited", { metadata: { retry_after_ms: 5000 } }), headers: { "retry-after": "5" } } : null),
  });
  runner.start();
  await clock.advance(150);
  assert.equal(st(0).status, "waiting");
  assert.equal(st(0).nextAt, 5100);
  assert.equal(st(1).status, "done");
  assert.equal(router.calls.length, 2, "no new request starts while rate limited, even with a free slot");
  await clock.advance(4900); // t = 5050
  assert.equal(router.calls.length, 2);
  await clock.advance(100); // t = 5150
  assert.deepEqual(router.calls.slice(2).map((c) => [c.id, c.at]), [["r0", 5100], ["r2", 5100]]);
  await clock.advance(1000);
  assert.equal(runner.status, "completed");
  assert.deepEqual([st(0).status, st(0).attempts, st(0).rateLimits], ["done", 2, 1]);
});

test("a 429 without a retry hint backs off exponentially, and a row fails after too many", async (t) => {
  const { clock, router, runner, st } = await harness(t, { rows: 1, concurrency: 1, maxRateLimitWaits: 2, script: () => err(429, "rate_limited") });
  runner.start();
  await clock.advance(20_000);
  // Waits of 1.5 s then 3 s (base 2 s, equal jitter at 0.5) after each 100 ms response.
  assert.deepEqual(router.calls.map((c) => c.at), [0, 1600, 4700]);
  assert.deepEqual([st(0).status, st(0).rateLimits, st(0).error.status], ["failed", 3, 429]);
});

test("5xx and network errors are retried twice with back-off before the row fails", async (t) => {
  const { clock, router, runner, st } = await harness(t, {
    rows: 2,
    concurrency: 1,
    script: (id, n) => (id === "r0" ? err(503, "providers_unavailable") : n === 1 ? { network: true } : null),
  });
  runner.start();
  await clock.advance(10_000);
  assert.deepEqual(router.of("r0").map((c) => c.at), [0, 850, 2450], "back-off of 0.75 s then 1.5 s");
  assert.deepEqual([st(0).status, st(0).attempts, st(0).retries, st(0).error.status, st(0).error.type], ["failed", 3, 3, 503, "providers_unavailable"]);
  assert.deepEqual([st(1).status, st(1).attempts], ["done", 2], "the network error was retried and succeeded");
  assert.equal(runner.status, "completed");
});

test("other 4xx responses fail the row at once", async (t) => {
  const { clock, router, runner, st } = await harness(t, { rows: 2, concurrency: 1, script: (id) => (id === "r0" ? err(400, "invalid_request") : null) });
  runner.start();
  await clock.advance(1000);
  assert.equal(router.of("r0").length, 1);
  assert.deepEqual([st(0).status, st(0).error.message], ["failed", "invalid_request (400)"]);
  assert.equal(st(1).status, "done");
});

test("a 402 on a request sent alone pauses the run; resume continues after a deposit", async (t) => {
  let funded = false;
  const { clock, router, runner, st } = await harness(t, { rows: 3, concurrency: 1, script: (id) => (id === "r1" && !funded ? err(402, "insufficient_credits") : null) });
  runner.start();
  await clock.advance(1000);
  assert.equal(runner.status, "paused");
  assert.deepEqual([runner.reason.kind, runner.reason.type], ["funds", "insufficient_credits"]);
  assert.deepEqual([st(0).status, st(1).status, st(1).attempts, st(2).status], ["done", "pending", 0, "pending"]);
  assert.equal(await runner.settled(), "paused");
  assert.equal(router.calls.length, 2);
  funded = true;
  runner.resume();
  await clock.advance(1000);
  assert.equal(runner.status, "completed");
  assert.deepEqual(runner.states.map((s) => s.status), ["done", "done", "done"]);
});

test("a 402 while other requests are in flight retries that row on its own before pausing", async (t) => {
  const { clock, router, runner, st } = await harness(t, { rows: 6, concurrency: 3, script: (id) => (id === "r0" ? { ...err(402, "insufficient_credits"), delay: 50 } : null) });
  runner.start();
  await clock.advance(1000);
  const r0 = router.of("r0");
  assert.equal(r0.length, 2);
  assert.equal(r0[1].active, 1, "the second try was the only request in flight");
  assert.equal(runner.status, "paused");
  assert.deepEqual(runner.states.map((s) => s.status), ["pending", "done", "done", "pending", "pending", "pending"]);
});

test("after a solo request succeeds, the run returns to full concurrency", async (t) => {
  const { clock, router, runner } = await harness(t, { rows: 6, concurrency: 3, script: (id, n) => (id === "r0" && n === 1 ? { ...err(402, "insufficient_credits"), delay: 50 } : null) });
  runner.start();
  await clock.advance(2000);
  assert.equal(runner.status, "completed");
  const solo = router.of("r0")[1];
  assert.deepEqual([solo.at, solo.active], [100, 1]);
  assert.deepEqual(router.calls.filter((c) => c.at === 200).map((c) => c.id), ["r3", "r4", "r5"]);
});

test("a 401 pauses the run instead of failing every row", async (t) => {
  const { clock, runner, st } = await harness(t, { rows: 3, concurrency: 1, script: () => err(401, "key_disabled") });
  runner.start();
  await clock.advance(1000);
  assert.deepEqual([runner.status, runner.reason.kind, st(0).status], ["paused", "auth", "pending"]);
});

test("pause lets in-flight requests finish and starts none; resume picks up the rest", async (t) => {
  const { clock, router, runner } = await harness(t, { rows: 5, concurrency: 2 });
  runner.start();
  await clock.advance(50);
  runner.pause();
  assert.equal(runner.status, "paused");
  await clock.advance(1000);
  assert.equal(router.calls.length, 2);
  assert.deepEqual(runner.states.map((s) => s.status), ["done", "done", "pending", "pending", "pending"]);
  assert.equal(await runner.settled(), "paused");
  runner.resume();
  await clock.advance(1000);
  assert.equal(runner.status, "completed");
  assert.equal(router.calls.length, 5);
});

test("cancel aborts in-flight requests and marks every unfinished row cancelled", async (t) => {
  const { clock, router, runner } = await harness(t, { rows: 4, concurrency: 2, script: () => ({ ...ok("x", 1), delay: 1000 }) });
  runner.start();
  await clock.advance(100);
  const done = runner.settled();
  runner.cancel();
  assert.equal(await done, "cancelled");
  assert.equal(router.calls.length, 2);
  assert.ok(router.calls.every((c) => c.init.signal.aborted));
  assert.deepEqual(runner.states.map((s) => s.status), ["cancelled", "cancelled", "cancelled", "cancelled"]);
  await clock.advance(5000);
  assert.equal(router.calls.length, 2, "nothing starts after cancel");
});

test("concurrency can change mid-run", async (t) => {
  const { clock, router, runner } = await harness(t, { rows: 8, concurrency: 1 });
  runner.start();
  await clock.advance(10);
  runner.setConcurrency(3);
  await clock.advance(10);
  assert.equal(router.calls.length, 3);
  runner.setConcurrency(99);
  assert.equal(runner.concurrency, 8);
  runner.setConcurrency(0);
  assert.equal(runner.concurrency, 1);
});

test("retry reruns only failed and cancelled rows", async (t) => {
  let fixed = false;
  const { clock, router, runner, st } = await harness(t, { rows: 3, concurrency: 3, script: (id) => (id === "r1" && !fixed ? err(400, "invalid_request") : null) });
  runner.start();
  await clock.advance(500);
  assert.deepEqual(runner.states.map((s) => s.status), ["done", "failed", "done"]);
  fixed = true;
  assert.equal(runner.retry(), 1);
  await clock.advance(500);
  assert.equal(runner.status, "completed");
  assert.deepEqual([st(1).status, st(1).attempts, st(0).attempts], ["done", 1, 1]);
  assert.equal(router.calls.length, 4);
});

test("rows per minute counts the last minute of the current session", () => {
  assert.equal(rowsPerMinute([], 500, 0), null);
  assert.equal(rowsPerMinute([1000, 2000, 3000], 30_000, 0), 6);
  assert.equal(rowsPerMinute([1000, 70_000, 80_000, 90_000], 120_000, 0), 3);
  assert.equal(rowsPerMinute([1000], 5000, null), null);
});

test("a reload never resends a row that was in flight", () => {
  const states = restoreStates([
    { status: "done", attempts: 1, response: { status_code: 200, body: {} } },
    { status: "running", attempts: 1, startedAt: 42 },
    { status: "waiting", attempts: 1, nextAt: 99 },
    { status: "pending" },
  ]);
  assert.deepEqual(states.map((s) => s.status), ["done", "failed", "pending", "pending"]);
  assert.equal(states[1].error.type, "interrupted");
  assert.match(states[1].error.message, /may have completed and been billed/);
  assert.equal(states[2].nextAt, 0);
});

// ---------------------------------------------------------------- results

test("results serialize like OpenAI batch output, with usage, cost and receipt id", async (t) => {
  const { clock, runner } = await harness(t, { rows: 4, concurrency: 1, script: (id) => (id === "r1" ? err(404, "model_not_found") : id === "r2" ? { network: true } : id === "r3" ? { ...ok(id, 1), delay: 1000 } : null) });
  runner.start();
  await clock.advance(700);
  runner.cancel();
  await runner.settled();
  const rows = runner.rows;
  const [done, notFound] = [resultRecord(rows[0], runner.states[0]), resultRecord(rows[1], runner.states[1])];
  assert.deepEqual(Object.keys(done), ["custom_id", "response", "error", "usage", "cost", "receipt_id"]);
  assert.equal(done.response.status_code, 200);
  assert.equal(done.response.body.choices[0].message.content, "answer r0");
  assert.deepEqual([done.error, done.cost, done.receipt_id, done.usage.total_tokens], [null, 0.001, "gen-r0-1", 5]);
  assert.deepEqual(notFound.response, { status_code: 404, body: { error: { code: 404, message: "model_not_found (404)", type: "model_not_found" } } });
  assert.deepEqual([notFound.error.code, notFound.usage, notFound.cost, notFound.receipt_id], ["model_not_found", null, null, null]);
  const lines = toJSONL(rows, runner.states).trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.custom_id), ["r0", "r1", "r2", "r3"]);
  assert.deepEqual(lines.map((l) => l.error?.code ?? null), [null, "model_not_found", "cancelled", "cancelled"]);
  assert.deepEqual(lines[2].error, { code: "cancelled", message: "Cancelled before it ran." }, "a row waiting to retry was never answered");
  assert.match(lines[3].error.message, /Cancelled before a response arrived/);
  assert.equal(resultRecord({ custom_id: "later" }, { status: "pending" }).error.code, "not_run");
});

test("CSV output is quoted, spreadsheet-safe and starts with a BOM", async (t) => {
  assert.equal(csvCell('say "hi", then\nleave'), '"say ""hi"", then\nleave"');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("-1"), "'-1");
  assert.equal(csvCell(-1), "-1");
  assert.equal(csvCell(null), "");
  const rows = [{ custom_id: "a,b", body: { model: "m/x" } }, { custom_id: "c", body: { model: "m/y" } }];
  const states = [
    { status: "done", response: { status_code: 200, body: { model: "m/x", choices: [{ message: { content: "=1+1" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cost: 0.5 }, receipt: { id: "gen-1" } } } },
    { status: "failed", error: { status: 500, type: "error", message: "Boom, again" } },
  ];
  const csv = toCSV(rows, states);
  assert.ok(csv.startsWith("\ufeffcustom_id,status,status_code,model,content,finish_reason,prompt_tokens,completion_tokens,total_tokens,cost,receipt_id,error\r\n"));
  const body = csv.slice(1).split("\r\n");
  assert.equal(body[1], "\"a,b\",succeeded,200,m/x,'=1+1,stop,1,2,3,0.5,gen-1,");
  assert.equal(body[2], 'c,failed,500,m/y,,,,,,,,"Boom, again"');
});

// ---------------------------------------------------------------- the attested lane

const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const QWEN = "qwen/qwen3-32b";
const laneHeaders = (extra = {}) => ({ "x-anyroute-lane": "attested", "x-receipt-id": "gen-attested", ...extra });
const laneSend = (lane = ATTESTED_LANE) => makeSender((body, opts) => api("/api/v1/chat/completions", { key: "test-key", method: "POST", body, ...opts }), { lane });
const closedErr = (status, type, headers) => ({ ...err(status, type), headers });

test("the attested lane is asked for on every row, whatever the row says, and 'unlinkable' is refused up front", () => {
  const { defaults, error } = buildDefaults({ model: LLAMA, lane: ATTESTED_LANE, extra: '{"provider":{"only":["alpha"],"lane":"public"}}' });
  assert.equal(error, null);
  assert.equal(defaults.lane, ATTESTED_LANE);
  const text = [
    JSON.stringify({ custom_id: "simple", prompt: "hello" }),
    JSON.stringify({ custom_id: "own", body: { model: QWEN, messages: [{ role: "user", content: "hi" }], provider: { lane: "public", zdr: true } } }),
    JSON.stringify({ custom_id: "bare", body: { messages: [{ role: "user", content: "hi" }] } }),
    JSON.stringify({ custom_id: "unlinkable", body: { model: QWEN, messages: [{ role: "user", content: "hi" }], provider: { lane: "unlinkable" } } }),
  ].join("\n");
  const out = parseBatch(text, { defaults });
  assert.deepEqual(out.rows.map((r) => r.custom_id), ["simple", "own", "bare"]);
  assert.deepEqual(out.rows.map((r) => r.body.provider.lane), ["attested", "attested", "attested"]);
  assert.deepEqual(out.rows[0].body.provider, { only: ["alpha"], lane: "attested" }, "default provider fields stay, the lane is raised");
  assert.deepEqual(out.rows[1].body.provider, { lane: "attested", zdr: true });
  assert.notEqual(out.rows[0].body.provider, out.rows[2].body.provider, "rows never share one provider object");
  assert.equal(out.invalid, 1);
  assert.match(out.errors[0].message, /"unlinkable"/);
  assert.match(buildDefaults({ lane: ATTESTED_LANE, extra: '{"provider":{"lane":"unlinkable"}}' }).error, /"unlinkable"/);
  // Without the option nothing is added and nothing is refused.
  const plain = parseBatch(text, { defaults: buildDefaults({ model: LLAMA }).defaults });
  assert.equal(plain.invalid, 0);
  assert.equal(plain.rows[0].body.provider, undefined);
  assert.equal(plain.rows[1].body.provider.lane, "public");
  assert.equal(buildDefaults({ model: LLAMA, lane: "public" }).defaults.lane, undefined);
});

test("headers name the lane and the receipt; a lane that is not the one asked for is not accepted", () => {
  assert.deepEqual(servedFrom(new Headers({ "x-anyroute-lane": "attested", "x-receipt-id": "gen-1", "x-anyroute-policy-hash": "sha256:" + "a".repeat(64), "x-anyroute-disclosure": "attested" })), { lane: "attested", receipt_id: "gen-1", policy_hash: "sha256:" + "a".repeat(64), disclosure: "attested" });
  assert.deepEqual(servedFrom(new Headers({ "inference-id": "gen-2" })), { lane: null, receipt_id: "gen-2", policy_hash: null, disclosure: null });
  assert.deepEqual(servedFrom(null), { lane: null, receipt_id: null, policy_hash: null, disclosure: null });
  assert.equal(laneMismatch(null, { lane: "public" }), null, "a batch without a lane accepts what it gets");
  assert.equal(laneMismatch("attested", { lane: "attested" }), null);
  assert.equal(laneMismatch("attested", { lane: "ATTESTED" }), null);
  assert.match(laneMismatch("attested", { lane: "public" }), /"public" lane, not "attested"\. The answer was discarded/);
  assert.match(laneMismatch("attested", { lane: null }), /did not state its lane/);
  assert.match(laneMismatch("attested", null), /could not be confirmed/);
});

test("on the attested lane each row keeps its lane and receipt id, and a refused or withheld row fails closed without being sent again", async (t) => {
  const script = (id) =>
    ({
      r0: { ...ok("r0", 1), headers: laneHeaders({ "x-receipt-id": "rcpt-0" }) },
      r1: closedErr(409, "lane_unavailable", {}),
      r2: closedErr(502, "upstream_not_attested", laneHeaders({ "x-receipt-id": "rcpt-2" })),
      r3: { ...ok("r3", 1), headers: laneHeaders({ "x-anyroute-lane": "public", "x-receipt-id": "rcpt-3" }) },
      r4: ok("r4", 1),
      r5: closedErr(503, "disclosure_provider_unavailable", { "retry-after": "30" }),
      r6: closedErr(500, "internal_error", {}),
    })[id] || null;
  const { clock, router, runner } = await harness(t, { rows: 7, concurrency: 7, script, send: laneSend() });
  runner.start();
  await clock.advance(20_000);
  await runner.settled();
  assert.equal(runner.status, "completed");
  const [r0, r1, r2, r3, r4, r5, r6] = runner.states;
  assert.deepEqual([r0.status, r0.served.lane, r0.served.receipt_id], ["done", "attested", "rcpt-0"]);
  assert.deepEqual([r1.status, failClosed(r1), r1.error.type, router.of("r1").length], ["failed", "refused", "lane_unavailable", 1]);
  assert.deepEqual([r2.status, failClosed(r2), r2.served.receipt_id, r2.served.lane, router.of("r2").length], ["failed", "withheld", "rcpt-2", "attested", 1]);
  assert.deepEqual([r3.status, failClosed(r3), r3.error.type, r3.response, router.of("r3").length], ["failed", "withheld", "lane_not_confirmed", null, 1]);
  assert.equal(r3.served.receipt_id, "rcpt-3", "the receipt of a discarded answer is still recorded");
  assert.deepEqual(r3.error.metadata, { lane: "public", receipt_id: "rcpt-3" });
  assert.deepEqual([r4.status, failClosed(r4), r4.error.type, r4.response, router.of("r4").length], ["failed", "withheld", "lane_not_confirmed", null, 1], "no lane header is not a confirmation");
  assert.deepEqual([r5.status, failClosed(r5), router.of("r5").length], ["failed", "refused", 3], "nothing was charged for a temporary refusal, so it is retried, then reported");
  assert.deepEqual([r6.status, failClosed(r6)], ["failed", null], "an ordinary failure is not failed closed");
  assert.equal(countFailedClosed(runner.states), 5);
  assert.equal(countFailedClosed([{ status: "done" }, { status: "cancelled", error: { type: "lane_unavailable" } }, {}]), 0);
});

test("every row of an attested batch carries provider.lane on the wire", async (t) => {
  const clock = fakeClock();
  const router = fakeRouter(clock, () => ({ ...ok("x", 1), headers: laneHeaders() }));
  t.after(router.install());
  const { defaults } = buildDefaults({ model: LLAMA, lane: ATTESTED_LANE });
  const { rows } = parseBatch('{"prompt":"r0"}\n{"prompt":"r1","model":"' + QWEN + '"}\n{"custom_id":"b","body":{"model":"' + LLAMA + '","messages":[{"role":"user","content":"r2"}],"provider":{"lane":"public"}}}', { defaults });
  const runner = new BatchRunner({ rows, send: laneSend(), concurrency: 3, clock, random: () => 0.5 });
  runner.start();
  await clock.advance(1000);
  assert.deepEqual(router.calls.map((c) => [c.id, c.body.provider]), [["r0", { lane: "attested" }], ["r1", { lane: "attested" }], ["r2", { lane: "attested" }]]);
  assert.deepEqual(runner.states.map((s) => s.status), ["done", "done", "done"]);
});

test("a batch without a lane records nothing extra and accepts any answer", async (t) => {
  const { clock, runner } = await harness(t, { rows: 2, script: () => ({ ...ok("x", 1), headers: { "x-anyroute-lane": "public", "x-receipt-id": "gen-1" } }), send: laneSend(null) });
  runner.start();
  await clock.advance(1000);
  assert.deepEqual(runner.states.map((s) => s.status), ["done", "done"]);
  assert.equal(runner.states.some((s) => "served" in s), false);
});

test("a network failure on the attested lane is a plain failure, not failed closed", async (t) => {
  const { clock, runner } = await harness(t, { rows: 1, script: () => ({ network: true }), send: laneSend() });
  runner.start();
  await clock.advance(30_000);
  assert.equal(runner.states[0].status, "failed");
  assert.equal(failClosed(runner.states[0]), null);
  assert.equal(runner.states[0].served, undefined);
});

test("lane results: JSONL and CSV add lane and fail_closed, and the receipt id comes from the header", async (t) => {
  const script = (id) => (id === "r1" ? closedErr(409, "lane_unavailable", {}) : id === "r2" ? closedErr(502, "upstream_not_attested", laneHeaders({ "x-receipt-id": "rcpt-2" })) : { ...ok(id, 1), headers: laneHeaders({ "x-receipt-id": "rcpt-" + id }) });
  const { clock, runner } = await harness(t, { rows: 3, concurrency: 3, script, send: laneSend() });
  runner.start();
  await clock.advance(1000);
  const lane = { lane: true };
  const [done, refused, withheld] = runner.rows.map((row, i) => resultRecord(row, runner.states[i], lane));
  assert.deepEqual(Object.keys(done), ["custom_id", "response", "error", "usage", "cost", "receipt_id", "lane", "fail_closed"]);
  assert.deepEqual([done.lane, done.receipt_id, done.fail_closed], ["attested", "rcpt-r0", null]);
  assert.deepEqual([refused.lane, refused.receipt_id, refused.fail_closed, refused.error.code], [null, null, "refused", "lane_unavailable"]);
  assert.deepEqual([withheld.lane, withheld.receipt_id, withheld.fail_closed], ["attested", "rcpt-2", "withheld"]);
  assert.deepEqual(Object.keys(resultRecord(runner.rows[0], runner.states[0])), ["custom_id", "response", "error", "usage", "cost", "receipt_id"], "results without the option are unchanged");
  const lines = toJSONL(runner.rows, runner.states, lane).trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.fail_closed), [null, "refused", "withheld"]);
  assert.equal(toJSONL(runner.rows, runner.states).includes("fail_closed"), false);
  const csv = toCSV(runner.rows, runner.states, lane).slice(1).split("\r\n");
  assert.ok(csv[0].endsWith(",error,lane,fail_closed"));
  assert.deepEqual(LANE_COLUMNS, ["lane", "fail_closed"]);
  assert.match(csv[1], /^r0,succeeded,200,.*,rcpt-r0,,attested,$/);
  assert.match(csv[2], /^r1,failed_closed,409,.*,lane_unavailable \(409\),,refused$/);
  assert.match(csv[3], /^r2,failed_closed,502,.*,rcpt-2,.*,attested,withheld$/);
  assert.equal(toCSV(runner.rows, runner.states).slice(1).split("\r\n")[2].startsWith("r1,failed,409"), true, "without the option a refused row is just failed");
});

test("saved lane state survives a reload, and a retry of a failed closed row starts clean", async (t) => {
  const { clock, runner } = await harness(t, { rows: 2, concurrency: 2, script: (id) => (id === "r1" ? closedErr(409, "lane_unavailable", {}) : { ...ok(id, 1), headers: laneHeaders() }), send: laneSend() });
  runner.start();
  await clock.advance(1000);
  const restored = restoreStates(JSON.parse(JSON.stringify(runner.states)));
  assert.equal(restored[0].served.lane, "attested");
  assert.equal(failClosed(restored[1]), "refused");
  assert.equal(runner.retry(["failed"]), 1);
  assert.equal(runner.states[1].served, undefined);
  assert.equal(failClosed(runner.states[1]), null);
});

test("the pickers of an attested batch list only what has an attested provider", () => {
  const ids = new Set([LLAMA]);
  const models = [{ id: LLAMA }, { id: QWEN }];
  assert.deepEqual(modelsOnLane(models, ids), [{ id: LLAMA }]);
  assert.deepEqual(modelsOnLane(undefined, ids), []);
  const routes = [{ slug: "private", models: [QWEN, LLAMA + ":floor"] }, { slug: "open", models: [QWEN] }, { slug: "empty", models: [] }];
  assert.deepEqual(routesOnLane(routes, ids).map((r) => r.slug), ["private"], "a route can run when any of its models can");
  const rows = [
    { body: { model: LLAMA } },
    { body: { model: QWEN } },
    { body: { model: QWEN + ":nitro" } },
    { body: { model: QWEN, models: [QWEN, LLAMA] } },
    { body: { model: "@route/private" } },
    { body: { model: "@route/open" } },
    { body: { model: "@route/not-loaded" } },
    { body: {} },
  ];
  assert.deepEqual(rowsOffLane(rows, ids, routes), { count: 3, models: [QWEN, QWEN + ":nitro", "@route/open"] });
  assert.deepEqual(rowsOffLane(rows, ids, routes, 1), { count: 3, models: [QWEN] });
  assert.deepEqual(rowsOffLane([], ids, routes), { count: 0, models: [] });
});

test("answers the router withheld or this page could not confirm are never retried: the work was already billed", () => {
  assert.equal(classifyError({ status: 502, type: "upstream_not_attested" }), "fatal");
  assert.equal(classifyError({ status: 502, type: "lane_not_confirmed" }), "fatal");
  assert.equal(classifyError({ status: 502, type: "all_providers_failed" }), "transient");
  assert.equal(classifyError({ status: 409, type: "lane_unavailable" }), "fatal");
  assert.equal(classifyError({ status: 503, type: "disclosure_provider_unavailable" }), "transient");
});

// ---------------------------------------------------------------- server batches

const serverRows = () => parseBatch(['{"custom_id": "a", "prompt": "one"}', '{"prompt": "two"}', '{"custom_id": "c", "prompt": "three"}', '{"custom_id": "d", "prompt": "four"}'].join("\n"), { defaults: { model: "m/x", params: { max_tokens: 10 } } }).rows;

test("server batch requests are one chat completion line per parsed row, with the row's custom_id", () => {
  const rows = serverRows();
  const req = toServerRequests(rows);
  assert.deepEqual(
    req.map((r) => [r.custom_id, r.method, r.url]),
    [
      ["a", "POST", "/v1/chat/completions"],
      ["row-2", "POST", "/v1/chat/completions"],
      ["c", "POST", "/v1/chat/completions"],
      ["d", "POST", "/v1/chat/completions"],
    ],
  );
  assert.deepEqual(req[0].body, { model: "m/x", messages: [{ role: "user", content: "one" }], max_tokens: 10 });
  assert.equal(toServerRequests([{ body: { model: "m/x" } }])[0].custom_id, "row-1", "a row without an id is numbered");
  assert.equal(serverInputBytes(req), req.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)) + 1, 0));
  assert.deepEqual(toServerRequests(parseBatch('{"prompt": "x"}', { defaults: { model: "m/x", lane: ATTESTED_LANE } }).rows)[0].body.provider, { lane: ATTESTED_LANE }, "the lane goes on every line");
});

test("rules of the Batch API block a server batch; the router's default limits only warn", () => {
  const line = (body, id = "x") => ({ custom_id: id, method: "POST", url: "/v1/chat/completions", body: { model: "m/x", messages: [{ role: "user", content: "hi" }], ...body } });
  assert.deepEqual(checkServerBatch([line({})]), { error: null, warnings: [] });
  assert.match(checkServerBatch([line({}, "i".repeat(65))]).error, /longer than 64 characters/);
  assert.equal(checkServerBatch([line({}, "i".repeat(64))]).error, null);
  assert.match(checkServerBatch([line({ model: "anyroute/council" })]).error, /Council mode/);
  assert.match(checkServerBatch([line({ verify: true })]).error, /"verify"/);
  const many = Array.from({ length: 3 }, (_, i) => line({}, "r" + i));
  const { error, warnings } = checkServerBatch(many, { maxLines: 2, maxBytes: 100 });
  assert.equal(error, null);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /3 rows is more than the 2/);
  assert.match(warnings[1], /MB/);
  assert.equal(SERVER_MAX_LINES, 1000);
  assert.equal(SERVER_MAX_BYTES, 8 * 1024 * 1024);
});

test("line errors of a refused batch point at the rows' own lines", () => {
  const rows = serverRows();
  const e = { status: 400, type: "invalid_request", metadata: { errors: [{ line: 2, code: "invalid_body", message: "Bad body." }, { line: 9, code: "x", message: "Out of range." }] } };
  assert.deepEqual(serverLineErrors(e, rows), [
    { line: rows[1].line, custom_id: "row-2", message: "Bad body." },
    { line: 9, custom_id: null, message: "Out of range." },
  ]);
  assert.deepEqual(serverLineErrors({ status: 429, type: "batch_limit" }, rows), []);
});

test("a server batch is done only in a terminal status, and its progress reads the counts and the cost", () => {
  for (const s of ["validating", "in_progress", "cancelling"]) assert.equal(serverBatchDone({ status: s }), false, s);
  for (const s of ["completed", "failed", "expired", "cancelled"]) assert.equal(serverBatchDone({ status: s }), true, s);
  assert.equal(serverBatchDone(null), false);
  const p = serverProgress({ status: "in_progress", request_counts: { total: 10, completed: 6, failed: 1 }, cost: { usd: 0.002, discount_bps: 5000, list_usd: 0.004 } });
  assert.deepEqual(
    [p.status, p.done, p.total, p.completed, p.failed, p.finished, p.remaining, p.pct, p.cost, p.listCost, p.saved, p.discountBps],
    ["in_progress", false, 10, 6, 1, 7, 3, 70, 0.002, 0.004, 0.002, 5000],
  );
  const empty = serverProgress({ status: "validating" });
  assert.deepEqual([empty.total, empty.finished, empty.pct, empty.cost, empty.saved], [0, 0, 0, 0, 0]);
  assert.equal(serverProgress({ status: "weird" }).status, "validating");
});

test("the server estimate is the browser estimate at the batch discount", () => {
  const rows = serverRows();
  const priceOf = priceIndex([{ id: "m/x", price: 1, output: 2 }]);
  const full = estimateBatch(rows, priceOf);
  const half = estimateServerBatch(rows, priceOf);
  assert.equal(SERVER_DISCOUNT_BPS, 5000);
  assert.deepEqual([half.rows, half.input, half.output, half.priced], [full.rows, full.input, full.output, full.priced]);
  assert.ok(Math.abs(half.maxCost - full.maxCost / 2) < 1e-15);
  assert.ok(Math.abs(half.maxRowCost - full.maxRowCost / 2) < 1e-15);
  assert.equal(half.listMaxCost, full.maxCost);
  assert.ok(Math.abs(estimateServerBatch(rows, priceOf, 2500).maxCost - full.maxCost * 0.75) < 1e-15);
});

test("the output and errors files map back onto the rows and export like a browser batch", () => {
  const rows = serverRows();
  const body = { id: "gen-a", model: "m/x", choices: [{ message: { role: "assistant", content: "answer a" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.0005 }, receipt: { id: "gen-a" } };
  const output = [JSON.stringify({ id: "batch_req_1", custom_id: "a", response: { status_code: 200, request_id: "gen-a", body }, error: null }), "", "not json", JSON.stringify({ id: "batch_req_9", custom_id: "nobody", response: { status_code: 200, body }, error: null })].join("\n");
  const errors = [
    JSON.stringify({ id: "batch_req_2", custom_id: "row-2", response: { status_code: 402, request_id: null, body: { error: { code: 402, type: "insufficient_credits", message: "Not enough credits.", metadata: { needed: 1 } } } }, error: { code: "insufficient_credits", message: "Not enough credits." } }),
    JSON.stringify({ id: "batch_req_3", custom_id: "c", response: null, error: { code: "batch_cancelled", message: "The batch was cancelled before this line ran." } }),
  ].join("\r\n");
  const { states, unmatched } = parseServerResults(output, errors, rows);
  assert.equal(unmatched, 2, "a line that is not JSON and a line naming no row");
  assert.deepEqual(states.map((s) => s.status), ["done", "failed", "cancelled", "failed"]);
  assert.deepEqual(states[0].response, { status_code: 200, body });
  assert.equal(states[0].request_id, "gen-a");
  assert.deepEqual(states[1].error, { status: 402, type: "insufficient_credits", message: "Not enough credits.", metadata: { needed: 1 } });
  assert.deepEqual(states[2].error, { status: 0, type: "cancelled", message: "The batch was cancelled before this line ran." });
  assert.deepEqual(states[3].error, { status: 0, type: "no_result", message: "The router returned no result for this row." }, "a row in neither file");
  for (const st of states) for (const k of Object.keys(newState())) assert.ok(k in st, `${k} is kept`);

  const s = summarize(states);
  assert.deepEqual([s.done, s.failed, s.cancelled, s.cost, s.promptTokens], [1, 2, 1, 0.0005, 3]);
  const lines = toJSONL(rows, states).trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.error?.code ?? null), [null, "insufficient_credits", "cancelled", "no_result"]);
  assert.deepEqual([lines[0].receipt_id, lines[0].cost], ["gen-a", 0.0005]);
  assert.equal(lines[1].response.status_code, 402);
  assert.equal(lines[2].response, null, "a line that never ran has no response");
  const csv = toCSV(rows, states).slice(1).split("\r\n");
  assert.equal(csv[1], "a,succeeded,200,m/x,answer a,stop,3,2,5,0.0005,gen-a,");
  assert.equal(csv[3], "c,cancelled,,m/x,,,,,,,,The batch was cancelled before this line ran.");

  const both = parseServerResults(output + "\n" + JSON.stringify({ custom_id: "a", response: null, error: { code: "x", message: "y" } }), "", rows);
  assert.equal(both.states[0].status, "done", "an answered row is never overwritten by an error line");
  assert.deepEqual(parseServerResults("", "", []), { states: [], unmatched: 0 });
});

test("on the attested lane a server row keeps its receipt id and the lane its receipt states, and a refusal fails closed", () => {
  const rows = serverRows().slice(0, 3);
  const body = { id: "gen-a", choices: [{ message: { content: "ok" } }], usage: { cost: 0.1 }, receipt: { id: "gen-a", payload: { lane: "attested" } } };
  const output = [JSON.stringify({ custom_id: "a", response: { status_code: 200, request_id: "gen-a", body }, error: null }), JSON.stringify({ custom_id: "c", response: { status_code: 200, request_id: "gen-c", body: { ...body, receipt: { id: "gen-c" } } }, error: null })].join("\n");
  const errors = JSON.stringify({ custom_id: "row-2", response: { status_code: 503, request_id: null, body: { error: { code: 503, type: "no_attested_endpoint", message: "No attested endpoint." } } }, error: { code: "no_attested_endpoint", message: "No attested endpoint." } });
  const { states } = parseServerResults(output, errors, rows, { lane: true });
  assert.deepEqual(states[0].served, { lane: "attested", receipt_id: "gen-a", policy_hash: null, disclosure: null });
  assert.equal(states[2].served.lane, null, "a receipt that states no lane is not taken as attested");
  assert.equal(failClosed(states[1]), "refused");
  const rec = resultRecord(rows[0], states[0], { lane: true });
  assert.deepEqual([rec.lane, rec.receipt_id, rec.fail_closed], ["attested", "gen-a", null]);
  assert.equal(parseServerResults(output, errors, rows).states[0].served, undefined, "nothing extra without a lane");
});
