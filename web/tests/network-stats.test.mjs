import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fetchNetworkStats, networkStatCards, validNetworkStats } from "../lib/network-stats.js";

const transpile = 'process.stdout.write(new Bun.Transpiler({ loader: "jsx", target: "node", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "React.createElement", jsxFragmentFactory: "React.Fragment" } } }).transformSync(await Bun.stdin.text()));';
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && context.parentURL) for (const ext of [".jsx", ".js"]) {
      const url = new URL(specifier + ext, context.parentURL);
      if (fs.existsSync(url)) return next(url.href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith(".css")) return { format: "module", shortCircuit: true, source: 'export default new Proxy({}, { get: (_, name) => name });' };
    if (url.endsWith(".jsx")) return { format: "module", shortCircuit: true, source: 'import React from "react";\n' + execFileSync("bun", ["-e", transpile], { input: fs.readFileSync(fileURLToPath(url), "utf8"), encoding: "utf8" }) };
    return next(url, context);
  },
});
const { default: NetworkStats } = await import("../app/network/NetworkStats.jsx");
hook.deregister();
const snapshot = () => ({ as_of: "2026-09-30T12:00:00.000Z", hosts: { total: 3, probation: 1, live: 1, rejected: 1 }, attested_hosts: 2, capacity: { model_count: 1 }, interest: { total: 4 }, tokens: { public_lane: { days_7: { lower: "100000", upper_exclusive: "200000" }, days_30: null } }, bonds: { total_units: "5000500000", active_units: "4000000000", asset: "USDG", decimals: 6, fresh: true }, policy_version: 1 });

test("API client is relative, read-only and omits credentials; absence and malformed results produce no data", async () => {
  let call;
  assert.deepEqual(await fetchNetworkStats(async (path, options) => { call = { path, options }; return { ok: true, json: async () => ({ data: snapshot() }) }; }), snapshot());
  assert.equal(call.path, "/api/v1/network/stats"); assert.equal(call.options.credentials, "omit"); assert.equal(call.options.method, undefined);
  for (const fetcher of [async () => { throw Error("offline"); }, async () => ({ ok: false }), async () => ({ ok: true, json: async () => ({ data: {} }) })]) assert.equal(await fetchNetworkStats(fetcher), null);
  assert.equal(validNetworkStats({ ...snapshot(), attested_hosts: -1 }), false);
  const broken = snapshot(); broken.tokens.public_lane.days_7.lower = "not-a-number"; assert.equal(validNetworkStats(broken), false);
});

test("static render needs no API and shows no invented counts", () => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => { throw Error("static render must not fetch"); };
  try {
    const html = renderToStaticMarkup(createElement(NetworkStats));
    assert.match(html, /No data yet/); assert.match(html, /Network statistics/);
    assert.doesNotMatch(html, /data-count=/);
    assert.equal(networkStatCards(null).every(c => c.text === "No data yet"), true);
  } finally { globalThis.fetch = previous; }
});

test("real snapshot reuses stat/count-up markup, shows buckets, bond units and host statuses", () => {
  const html = renderToStaticMarkup(createElement(NetworkStats, { initialData: snapshot() }));
  assert.match(html, /data-count="3"/); assert.match(html, /100,000–199,999/); assert.match(html, /5,000\.5/);
  assert.match(html, /1 on probation/); assert.match(html, /1 live/); assert.match(html, /1 rejected/); assert.match(html, /v1/);
  assert.match(html, /not differential privacy/); assert.match(html, /Private-lane host totals are unavailable/);
  const stale = snapshot(); stale.bonds.fresh = false;
  assert.equal(networkStatCards(stale).slice(-2).every(c => c.text === "No data yet"), true);
  assert.match(renderToStaticMarkup(createElement(NetworkStats, { initialData: stale })), /bond index is not current/);
});

test("empty snapshot retains honest zero status counts and missing-history states", () => {
  const empty = snapshot(); empty.hosts = { total: 0, probation: 0, live: 0, rejected: 0 }; empty.attested_hosts = 0; empty.capacity.model_count = 0; empty.tokens.public_lane.days_7 = null; empty.bonds = null; empty.policy_version = null;
  const html = renderToStaticMarkup(createElement(NetworkStats, { initialData: empty }));
  assert.match(html, /data-count="0"/); assert.match(html, /No data yet from network hosts/);
});

test("OpenAPI and docs describe the flag, definitions, freshness and privacy limits", () => {
  const api = JSON.parse(fs.readFileSync(new URL("../public/openapi.json", import.meta.url), "utf8"));
  const route = api.paths["/api/v1/network/stats"].get;
  assert.deepEqual(route.security, []); assert.ok(route.responses["404"]); assert.ok(route.responses["503"]);
  assert.equal(api.components.schemas.NetworkStats.properties.tokens.properties.private_lanes.type, "null");
  const docs = fs.readFileSync(new URL("../components/NetworkStatsDocs.jsx", import.meta.url), "utf8");
  assert.match(docs, /NETWORK_STATS_ENABLED/); assert.match(docs, /default false/); assert.match(docs, /100,000-token/);
  assert.match(docs, /router still reads ordinary inference request text in memory/);
  assert.doesNotMatch(docs, /\b(demo|test|mock|simulated|placeholder)\b|local.build/i);
});
