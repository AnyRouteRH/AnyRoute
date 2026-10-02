import { expect, test } from "bun:test";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import type { Candidate, ModelRow } from "../src/catalog/catalog.ts";
import { selectProviders, type HealthView, type ProviderPrefs } from "../src/router/select.ts";
import { MAINSTREAM } from "../src/router/lane.ts";
import { profileOf, UNDECLARED } from "../src/router/disclosure.ts";
import { explainedStream, inheritRoutePlan, rememberRoutePlan, rememberRouteResult, routeReceiptFields, routeResponseHeaders, skipClass } from "../src/router/explain.ts";
import type { Attempt, RouteSuccess } from "../src/router/execute.ts";
import { buildClaimsV2, coseSign1, encodeClaims } from "../src/receipts/v2.ts";
import { canonicalJson, sha256 } from "../src/lib/util.ts";
import { verifyReceipt as sdkV1, verifyReceiptV2 as sdkV2 } from "../packages/client/src/index.ts";
import { verifyReceipt as webVerify } from "../web/lib/verify.js";
import { validRouteExplanation } from "../web/lib/route-explanation.js";
import { MODELS, startRouter } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";

const provider = (id: string, price = 10n, extra = {}): Candidate => ({ modelId: "m/x", providerId: id, providerModelId: "x", pricePrompt: price, priceCompletion: price, priceRequest: 0n, status: "live", supportedParameters: ["tools", "temperature", "seed"], ctx: 4096, provider: { id, status: "live", baseUrl: "https://private.example/secret", apiKeyEnc: "secret-key", name: "Sensitive label", dataPolicy: {}, anyrStake: 0n, ...extra } } as unknown as Candidate);
const health: HealthView = { outage: () => false, uptime30d: () => 1, quality: () => 1, stats: (_m, p) => ({ latency: { p50: p === "alpha" ? 10 : 20 }, throughput: { p50: p === "alpha" ? 100 : 50 } }) };
const model = { id: "m/x" } as ModelRow;
const profile = profileOf({ retention: "attested", jurisdiction: "", legalHold: false, legalHoldNote: null, trainingUse: "none", claims: {}, updatedAt: new Date() });
function plan(offers = [provider("alpha"), provider("beta", 20n)], prefs: ProviderPrefs = {}, opts: { enabled?: boolean; params?: string[]; modifiers?: Set<string>; health?: HealthView; byok?: Map<string, string> } = {}) {
  const params = opts.params ?? [], modifiers = opts.modifiers ?? new Set();
  const selection = selectProviders({ modelId: model.id, offers, prefs, modifiers: modifiers as never, requestParams: params, estimatedTokens: 20, production: true, attestationMaxAgeMs: 60000, modelLane: MAINSTREAM, health: opts.health ?? health, rand: () => .5, disclosure: id => offers.find(c => c.providerId === id)?.provider.attested ? profile : UNDECLARED });
  const ordered = [...selection.ordered];
  rememberRoutePlan(opts.enabled !== false, selection, ordered, selection.excluded, prefs, modifiers, params, opts.byok ?? new Map());
  return { model, ordered };
}
function result(target: ReturnType<typeof plan>, index = 0, attempts: Attempt[] = []) {
  const r: RouteSuccess = { ok: true, kind: "json", model, candidate: target.ordered[index], json: { choices: [] }, latencyMs: 10, attempts: [...attempts, { model: model.id, provider: target.ordered[index].providerId, ok: true, latency_ms: 10 }], dropped: [] };
  expect(rememberRouteResult(r, [target])).toBe(r);
  return r;
}
const explanation = (target: ReturnType<typeof plan>) => routeReceiptFields(true, result(target)).route!;

test("selection evidence: price, health, lane, parameter support and a network host", () => {
  expect(explanation(plan(undefined, { sort: "price" }))).toMatchObject({ reason: "lowest_price", provider: "alpha", eligible: 2, skipped: {} });
  expect(explanation(plan(undefined, {}, { health: { ...health, outage: (_m, p) => p === "beta" } }))).toMatchObject({ reason: "only_eligible", skipped: { health: 1 } });
  const tee = provider("enclave", 20n, { attested: true, attestationHash: "abcdef", attestedAt: new Date(), teeKind: "tdx" });
  expect(explanation(plan([provider("alpha"), tee], { lane: "attested" }))).toMatchObject({ lane: "attested", provider: "enclave", skipped: { lane: 1 } });
  const limited = { ...provider("beta"), supportedParameters: ["temperature"] };
  expect(explanation(plan([provider("alpha"), limited], { require_parameters: true }, { params: ["tools"] }))).toMatchObject({ reason: "only_parameter_support", parameters: ["tools"], skipped: { parameters: 1 } });
  expect(explanation(plan([provider("network-host", 10n, { networkHost: true })]))).toMatchObject({ provider: "network-host", network_host: true });
});

test("weighted selection never claims cheapest or healthiest; effective ordering overrides price", () => {
  expect(explanation(plan()).reason).toBe("weighted_choice");
  expect(explanation(plan(undefined, { sort: "latency" })).reason).toBe("lowest_latency");
  expect(explanation(plan(undefined, { sort: "throughput" })).reason).toBe("highest_throughput");
  expect(explanation(plan(undefined, { sort: "price", order: ["beta"] }))).toMatchObject({ provider: "beta", reason: "provider_order" });
  expect(explanation(plan(undefined, { sort: "price", preferred_max_latency: 5 })).reason).toBe("preferred_performance");
  expect(explanation(plan(undefined, { sort: "latency" }, { modifiers: new Set(["floor"]) })).reason).toBe("lowest_price");
  expect(explanation(plan([provider("alpha")], { allow_fallbacks: false })).eligible).toBe(1);
});

test("fallback uses actual attempts, aggregate classes only, including an earlier model", () => {
  const target = plan(undefined, { sort: "price" });
  const r = result(target, 1, [{ provider: "secret-provider", model: "earlier/model", ok: false, error_kind: "timeout", latency_ms: 1, message: "https://internal.example/key secret account address" }]);
  const route = routeReceiptFields(true, r).route!;
  expect(route).toMatchObject({ provider: "beta", reason: "fallback", eligible: 2, fallback: { timeout: 1 } });
  expect(Object.keys(route).sort()).toEqual(["v", "provider", "reason", "eligible", "skipped", "lane", "parameters", "network_host", "fallback"].sort());
  expect(Object.keys(route.fallback!)).toEqual(["timeout"]);
  expect(JSON.stringify(route)).not.toMatch(/secret|internal|earlier|Sensitive|address|apiKey|baseUrl/);
  expect(JSON.parse(routeResponseHeaders(true, r)["x-anyroute-route"])).toEqual(route);
  expect(validRouteExplanation(route, "beta")).toBe(true);
});

test("arbitrary skip strings cannot leak; allowlist includes only fixed names and counts", () => {
  const target = plan();
  rememberRoutePlan(true, { ordered: target.ordered, excluded: [] }, target.ordered, [{ reason: "secret https://internal.example/query address" }, { reason: "quantization secret-value not allowed" }], {}, new Set(), ["secret-parameter", "tools"], new Map());
  const route = explanation(target);
  expect(route.skipped).toEqual({ other: 1, preferences: 1 });
  expect(route.parameters).toEqual(["tools"]);
  expect(Object.keys(route).sort()).toEqual(["v", "provider", "reason", "eligible", "skipped", "lane", "parameters", "network_host"].sort());
  expect(JSON.stringify(route)).not.toMatch(/secret|internal|Sensitive|baseUrl|apiKey/);
  expect(skipClass("above max_price.prompt")).toBe("price");
  expect(skipClass("private route requires a fresh TEE attestation")).toBe("attestation");
  expect(skipClass("context length exceeded")).toBe("context");
  expect(skipClass("disclosure ceiling requires retention")).toBe("disclosure");
  expect(routeReceiptFields(true, result(plan([provider("https://internal.example")])))).toEqual({});
});

test("plans are request-scoped when catalog candidates are shared, and partitions inherit safely", () => {
  const shared = [provider("alpha"), provider("beta", 20n)];
  const price = plan(shared, { sort: "price" });
  const weighted = plan(shared);
  expect(explanation(price).reason).toBe("lowest_price");
  expect(explanation(weighted).reason).toBe("weighted_choice");
  const partition = { model, ordered: inheritRoutePlan(price.ordered, [price.ordered[1]]) };
  expect(explanation(partition)).toMatchObject({ provider: "beta", eligible: 1 });
});

const claimsInput = { rid: "gen-fixture", issuedAt: new Date("2026-01-01T00:00:00Z"), router: "https://router.example", modelId: "m/x", providerId: "alpha", attestation: null, policyHash: null, requestSha256: "a".repeat(64), responseSha256: "b".repeat(64), tokensIn: 10, tokensOut: 5, finish: "stop", stream: false, complete: true, lane: "public", disclosure: "vendor-forwarded", mode: "prepaid", chargedPico: 1000000n };
const priv = createPrivateKey({ key: Buffer.from("302e020100300506032b657004220420" + "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"), format: "der", type: "pkcs8" });
const pub = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x!, "base64url");
const kid = sha256(pub).slice(0, 16);
const cose = (claims: ReturnType<typeof buildClaimsV2>) => coseSign1(encodeClaims(claims), Buffer.from(kid, "hex"), bytes => sign(null, bytes, priv));
const envelope = (payload: object) => ({ payload, sig: sign(null, Buffer.from(canonicalJson(payload)), priv).toString("base64"), key_id: kid, alg: "Ed25519" });

test("flag-off preserves response, canonical JSON, signature and COSE bytes against fixed legacy claims", () => {
  const r = result(plan());
  expect(routeReceiptFields(false, r)).toEqual({});
  expect(routeResponseHeaders(false, r)).toEqual({});
  expect(routeReceiptFields(true, result(plan(undefined, {}, { enabled: false })))).toEqual({});
  const legacyClaims = { v: 2 as const, rid: "gen-fixture", iat: 1767225600, iss: "https://router.example", model: { id: "m/x" }, node: { provider: "alpha" }, req: { h: "sha256:" + "a".repeat(64), n_in_bucket: "8-16" }, resp: { h: "sha256:" + "b".repeat(64), n_out_bucket: "4-8", finish: "stop", stream: false, complete: true }, lane: "public", disclosure: "vendor-forwarded", credit: { mode: "prepaid", cost_units: 1 } };
  const disabledClaims = buildClaimsV2({ ...claimsInput, ...routeReceiptFields(false, r) });
  expect(Buffer.from(encodeClaims(disabledClaims))).toEqual(Buffer.from(encodeClaims(legacyClaims)));
  expect(Buffer.from(cose(disabledClaims))).toEqual(Buffer.from(cose(legacyClaims)));
  const legacyPayload = { v: 1, id: "gen-fixture", provider: "alpha" };
  const disabledPayload = { ...legacyPayload, ...routeReceiptFields(false, r) };
  expect(canonicalJson(disabledPayload)).toBe(canonicalJson(legacyPayload));
  expect(JSON.stringify({ choices: [], receipt: envelope(disabledPayload) })).toBe(JSON.stringify({ choices: [], receipt: envelope(legacyPayload) }));
  expect(JSON.stringify({ "x-receipt-id": "gen-fixture", ...routeResponseHeaders(false, r) })).toBe('{"x-receipt-id":"gen-fixture"}');
});

test("route is covered by both signatures and independent SDK/browser verifiers; tampering fails", async () => {
  const route = explanation(plan(undefined, { sort: "price" }));
  const v2 = { cose: Buffer.from(cose(buildClaimsV2({ ...claimsInput, route }))).toString("base64") };
  const receipt = { ...envelope({ v: 1, provider: "alpha", route }), v2 };
  const options = { publicKeyHex: pub.toString("hex") };
  expect((await sdkV1(receipt, options)).valid).toBe(true);
  expect((await sdkV2(v2.cose, options)).valid).toBe(true);
  expect((await webVerify(receipt, options)).valid).toBe(true);
  const changed = { ...receipt, payload: { ...receipt.payload, route: { ...route, eligible: 999 } } };
  expect((await sdkV1(changed, options)).valid).toBe(false);
  expect((await webVerify(changed, options)).valid).toBe(false);
  // A valid signature must not promote a malformed or mismatched versioned claim.
  for (const bad of [{ ...route, v: 2 }, { ...route, provider: "wrong" }, { ...route, url: "secret" }]) {
    expect((await sdkV1(envelope({ provider: "alpha", route: bad }), options)).valid).toBe(false);
    expect((await sdkV2(cose(buildClaimsV2({ ...claimsInput, route: bad as never })), options)).valid).toBe(false);
  }
});

test("real config loader accepts feature-on production without changing any guards", () => {
  expect(loadConfig({ ROUTE_EXPLAIN_ENABLED: "false" }).routeExplain).toBe(false);
  expect(loadConfig({}).routeExplain).toBe(false);
  const address = "0x" + "1".repeat(40);
  const cfg = loadConfig({ NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/fixture", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64), ROUTE_EXPLAIN_ENABLED: "true" });
  expect(cfg.production).toBe(true);
  expect(cfg.routeExplain).toBe(true);
});

test("JSON header and SSE final receipts use actual route; flag-off omits both, with unchanged CORS", async () => {
  for (const enabled of [false, true]) {
    const h = await startRouter({ env: { ROUTE_EXPLAIN_ENABLED: String(enabled) } });
    try {
      const k = await h.fundedKey();
      const headers = { ...k.auth, origin: "https://client.example" };
      const jsonBody = { model: "meta-llama/llama-3.3-70b-instruct", messages: [{ role: "user", content: "Route this" }], provider: { sort: "price" } };
      const res = await h.request("/api/v1/chat/completions", { method: "POST", headers, json: jsonBody });
      expect(res.status).toBe(200);
      const out = await res.json();
      if (enabled) {
        const route = out.receipt.payload.route;
        expect(route).toMatchObject({ provider: "alpha", reason: "lowest_price", eligible: 2 });
        expect(JSON.parse(res.headers.get("x-anyroute-route")!)).toEqual(route);
        expect(out.receipt.v2.claims.route).toEqual(route);
        expect(await h.ctx.signer.verify(out.receipt.payload, out.receipt.sig, out.receipt.key_id)).toBe(true);
        expect(res.headers.get("access-control-expose-headers")).toContain("x-anyroute-route");
      } else {
        expect(res.headers.get("x-anyroute-route")).toBeNull();
        expect(out.receipt.payload).not.toHaveProperty("route");
        expect(out.receipt.v2.claims).not.toHaveProperty("route");
        expect(res.headers.get("access-control-expose-headers")).not.toContain("x-anyroute-route");
      }
      const stream = await h.request("/api/v1/chat/completions", { method: "POST", headers, json: { ...jsonBody, stream: true } });
      expect(!!stream.headers.get("x-anyroute-route")).toBe(enabled);
      const frames = (await stream.text()).split("\n\n").filter(s => s.startsWith("data: {")).map(s => JSON.parse(s.slice(6)));
      const receipt = frames.find(f => f.receipt)?.receipt;
      expect(!!receipt?.payload?.route).toBe(enabled);
      if (enabled) {
        expect(receipt.v2.claims.route).toEqual(receipt.payload.route);
        expect(JSON.parse(stream.headers.get("x-anyroute-route")!)).toEqual(receipt.payload.route);
      }
    } finally { await h.close(); }
  }
});


test("executed fallback reports only the failure class, and embeddings reuse their existing selection", async () => {
  const h = await startRouter({ env: { ROUTE_EXPLAIN_ENABLED: "true" }, providers: [
    { id: "alpha", name: "Alpha", behaviour: "error500", models: [MODELS.llama] },
    { id: "beta", name: "Beta", models: [MODELS.llamaPricey, MODELS.embed] },
  ] });
  try {
    const k = await h.fundedKey();
    const response = await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "Route this" }], provider: { sort: "price" } } });
    expect(response.status).toBe(200);
    const out = await response.json();
    expect(out.receipt.payload.route).toMatchObject({ reason: "fallback", provider: "beta", fallback: { http_5xx: 1 } });
    expect(JSON.parse(response.headers.get("x-anyroute-route")!)).toEqual(out.receipt.payload.route);
    const embed = await h.request("/api/v1/embeddings", { method: "POST", headers: k.auth, json: { model: MODELS.embed.slug, input: "Route this" } });
    expect(embed.status).toBe(200);
    const embedded = await embed.json();
    expect(embedded.receipt.payload.route).toMatchObject({ provider: "beta", reason: "only_eligible", eligible: 1 });
    expect(JSON.parse(embed.headers.get("x-anyroute-route")!)).toEqual(embedded.receipt.payload.route);
    expect(await h.ctx.signer.verify(embedded.receipt.payload, embedded.receipt.sig, embedded.receipt.key_id)).toBe(true);
  } finally { await h.close(); }
});


test("stream delivery runs routing once and preserves failure handling and disabled immediacy", async () => {
  let calls = 0;
  const r = result(plan());
  const run = async () => { calls++; return r; };
  const response = await explainedStream(true, run, (saved, headers) => {
    void saved().then(value => expect(value).toBe(r));
    return new Response("stream", { headers });
  });
  expect(calls).toBe(1);
  expect(JSON.parse(response.headers.get("x-anyroute-route")!)).toEqual(routeReceiptFields(true, r).route);
  calls = 0;
  await explainedStream(false, run, actual => { expect(actual).toBe(run); return new Response("stream"); });
  expect(calls).toBe(0);
  const failure = new Error("private error");
  let returnedRun: (() => ReturnType<typeof run>) | undefined;
  await explainedStream(true, async () => { throw failure; }, actual => { returnedRun = actual as typeof run; return new Response("stream"); });
  await expect(returnedRun!()).rejects.toBe(failure);
});
