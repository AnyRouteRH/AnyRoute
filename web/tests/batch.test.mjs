import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../lib/api.js";
import {
  BatchRunner, MAX_ROWS, backoffMs, buildDefaults, checkFunds, classifyError, csvCell, detectFormat, estimateBatch, estimateRow, normalizeRoutes,
  parseBatch, parseCSV, parseRetryAfter, priceIndex, promptChars, restoreStates, resultRecord, retryAfterMs, rowsPerMinute, summarize, toCSV, toJSONL, validateBody,
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
