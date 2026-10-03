import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COMMERCE_PATH, EXCLUSIONS, describeWindow, fetchCommerceStats, formatUsdg, pairs, segments, validCommerceStats } from "../lib/commerce-stats.js";
import { TASKS } from "../lib/site-map.js";

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
const { default: CommerceLedger } = await import("../app/commerce/CommerceLedger.jsx");
hook.deregister();
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const fig = (o = {}) => ({ settlements: 0, payers: 0, payees: 0, volume_usdg: "0", median_price_usdg: null, refunds: 0, refund_rate: null, ...o });
const none = { unanchored: 0, same_owner: 0, round_trip: 0, funding_link: 0 };
const empty = () => ({ gross: fig(), filtered: fig(), excluded: { ...none } });
const kinds = [{ kind: "model.call", label: "Model calls (x402)", wired: true }, { kind: "tool.call", label: "Tool calls", wired: false }, { kind: "facilitator.settle", label: "Facilitator settlements", wired: false }, { kind: "job.release", label: "Job releases", wired: false }];
const snapshot = (block = empty()) => {
  const w = { from: "2026-10-01T12:00:00.000Z", to: "2026-10-02T12:00:00.000Z", total: block, kinds: Object.fromEntries(kinds.map(k => [k.kind, k.kind === "model.call" ? block : empty()])) };
  return { as_of: "2026-10-02T12:00:00.000Z", cache_seconds: 60, currency: { asset: "USDG", decimals: 6 }, kinds, methodology_url: "/docs/#commerce-stats", dune_query: "integrations/dune/commerce.sql",
    filters: { anchored_only: true, same_owner: true, round_trip_hours: 24, funding: { available: false, hops: 2, min_units: "1000000", hub_fanout: 25, from_block: null, indexed_block: null, indexed_at: null } },
    windows: { "24h": w, "7d": w, "30d": w } };
};
const busy = () => ({
  gross: fig({ settlements: 10, payers: 9, payees: 1, volume_usdg: "40000000", median_price_usdg: "3500000", refunds: 1, refund_rate: 0.1 }),
  filtered: fig({ settlements: 4, payers: 3, payees: 1, volume_usdg: "7000000", median_price_usdg: "1750000", refunds: 1, refund_rate: 0.25 }),
  excluded: { unanchored: 1, same_owner: 1, round_trip: 1, funding_link: 3 },
});

test("client reads the public endpoint without credentials and tells off, error and data apart", async () => {
  let call;
  const ok = await fetchCommerceStats("https://router.example", async (url, options) => { call = { url, options }; return { ok: true, status: 200, json: async () => ({ data: snapshot(busy()) }) }; });
  assert.equal(ok.state, "ok");
  assert.equal(call.url, "https://router.example" + COMMERCE_PATH);
  assert.equal(call.options.credentials, "omit");
  assert.equal(call.options.method, undefined);
  assert.deepEqual(await fetchCommerceStats("", async () => ({ ok: false, status: 404 })), { state: "off" });
  for (const fetcher of [async () => { throw Error("offline"); }, async () => ({ ok: false, status: 503 }), async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) })])
    assert.deepEqual(await fetchCommerceStats("", fetcher), { state: "error" });
  await assert.rejects(fetchCommerceStats("", async () => { throw Object.assign(Error("aborted"), { name: "AbortError" }); }), /aborted/);
});

test("a snapshot is shown only when every block has gross and filtered figures that add up", () => {
  assert.equal(validCommerceStats(snapshot()), true);
  assert.equal(validCommerceStats(snapshot(busy())), true);
  const noGross = snapshot(busy()); delete noGross.windows["24h"].total.gross; assert.equal(validCommerceStats(noGross), false);
  const noFiltered = snapshot(busy()); delete noFiltered.windows["7d"].kinds["model.call"].filtered; assert.equal(validCommerceStats(noFiltered), false);
  const off = busy(); off.excluded.funding_link = 2; assert.equal(validCommerceStats(snapshot(off)), false); // 4 + 5 is not 10
  const more = busy(); more.filtered.settlements = 11; assert.equal(validCommerceStats(snapshot(more)), false);
  const missingKind = snapshot(); delete missingKind.windows["30d"].kinds["job.release"]; assert.equal(validCommerceStats(missingKind), false);
  const bad = busy(); bad.gross.volume_usdg = "1.5"; assert.equal(validCommerceStats(snapshot(bad)), false);
});

test("amounts are exact USDG, and every measure pairs the filtered figure with the gross one", () => {
  assert.equal(formatUsdg("0"), "0");
  assert.equal(formatUsdg("1750000"), "1.75");
  assert.equal(formatUsdg("1234500000"), "1,234.5");
  assert.equal(formatUsdg("9007199254740993000001"), "9,007,199,254,740,993.000001");
  assert.equal(formatUsdg(null), null);
  const p = pairs(busy());
  assert.deepEqual(p.map(x => x.key), ["settlements", "payers", "payees", "volume", "median", "refunds"]);
  for (const x of p) { assert.ok(x.filtered); assert.ok(x.gross); }
  assert.deepEqual(p.find(x => x.key === "median"), { key: "median", label: "Median price", filtered: "1.75 USDG", gross: "3.5 USDG" });
  assert.deepEqual(p.find(x => x.key === "refunds"), { key: "refunds", label: "Refund rate", filtered: "25%", gross: "10%" });
  assert.equal(pairs(empty()).find(x => x.key === "median").filtered, "none");
  const seg = segments(busy());
  assert.deepEqual(seg.map(g => [g.key, g.n]), [["filtered", 4], ["unanchored", 1], ["same_owner", 1], ["round_trip", 1], ["funding_link", 3]]);
  assert.equal(seg.reduce((a, g) => a + g.share, 0), 1);
  assert.deepEqual(segments(empty()), []);
});

test("a window view covers every kind, says which are not connected, and states the funding filter plainly", () => {
  const v = describeWindow(snapshot(busy()), "24h");
  assert.equal(v.label, "24 hours");
  assert.deepEqual(v.kinds.map(k => [k.kind, k.wired, k.empty]), [["model.call", true, false], ["tool.call", false, true], ["facilitator.settle", false, true], ["job.release", false, true]]);
  assert.match(v.funding, /Funding links are not checked on this router/);
  const on = snapshot(busy()); on.filters.funding = { ...on.filters.funding, available: true, from_block: "100", indexed_block: "250", indexed_at: "2026-10-02T11:59:00.000Z" };
  assert.equal(describeWindow(on, "7d").funding, "Funding links are checked within 2 transfers of at least 1 USDG, from block 100, read up to block 250.");
  assert.deepEqual(v.excluded.map(e => e.key), EXCLUSIONS.map(e => e.key));
});

test("static render invents nothing; a snapshot renders filtered figures beside gross ones", () => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => { throw Error("static render must not fetch"); };
  try {
    assert.match(renderToStaticMarkup(createElement(CommerceLedger)), /Reading the ledger/);
  } finally { globalThis.fetch = previous; }
  const html = renderToStaticMarkup(createElement(CommerceLedger, { initial: snapshot(busy()) }));
  for (const text of ["Large figures count only what passed every rule", "gross 10", "gross 40 USDG", "1.75 USDG", "gross 3.5 USDG", "Not anchored on chain", "Linked by funding", "not connected yet", "Nothing reports these settlements to the ledger yet.", "/docs/#commerce-stats", "integrations/dune/commerce.sql"]) assert.ok(html.includes(text), text);
  assert.match(html, /<strong>4<\/strong><span>gross 10<\/span>/);
  assert.doesNotMatch(html, /0x[0-9a-f]{40}/i);
  const zero = renderToStaticMarkup(createElement(CommerceLedger, { initial: snapshot() }));
  assert.match(zero, /No settlements in the last 7 days yet/);
  assert.match(zero, /<strong>0<\/strong><span>gross 0<\/span>/);
});

test("the page uses existing tokens only: no new colours, no outlines or borders, solid bars", () => {
  const css = read("app/commerce/commerce.module.css");
  // Only resets are allowed (a button's default border set to 0); nothing draws a line.
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/border: 0;/g, ""), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\bborder\b|\boutline\b|box-shadow|gradient/i);
  for (const kind of ["filtered", ...EXCLUSIONS.map(e => e.key)]) assert.match(css, new RegExp(`\\[data-kind="${kind}"\\] \\{ background: var\\(--[a-z0-9-]+\\); \\}`));
  const page = read("app/commerce/page.jsx");
  assert.match(page, /The gross figure always sits next to the filtered one/);
  assert.ok(TASKS.some(t => t.href === "/commerce/" && t.menu === false));
});

test("methodology, OpenAPI and copy say what is off, what is counted and how to check it", () => {
  const docs = read("components/CommerceStatsDocs.jsx");
  for (const phrase of ["COMMERCE_STATS_ENABLED", "defaults to false and is not switched on at anyroute.tech yet", "ReceiptAnchor", "within 24 hours", "COMMERCE_FUNDING_HOPS", "COMMERCE_HUB_FANOUT", "integrations/dune/commerce.sql", "never splits figures by privacy lane", "60 seconds"]) assert.ok(docs.includes(phrase), phrase);
  const api = JSON.parse(read("public/openapi.json"));
  const route = api.paths["/api/v1/commerce/stats"].get;
  assert.deepEqual(route.security, []);
  assert.ok(route.responses["404"] && route.responses["503"]);
  assert.deepEqual(api.components.schemas.CommerceBlock.required, ["gross", "filtered", "excluded"]);
  assert.match(route.description, /not switched on at anyroute.tech yet/);
  const copy = [docs, read("app/commerce/page.jsx"), read("app/commerce/CommerceLedger.jsx"), read("lib/commerce-stats.js"), route.description, fs.readFileSync(new URL("../../integrations/dune/README.md", import.meta.url), "utf8"), fs.readFileSync(new URL("../../integrations/dune/commerce.sql", import.meta.url), "utf8")].join("\n");
  assert.doesNotMatch(copy, /\u2014|\blargest\b|\bleading\b/i);
  assert.doesNotMatch(copy, /\b(demo|mock|simulated|placeholder text)\b/i);
});
