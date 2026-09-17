import { describe, expect, test } from "bun:test";
import { allocate, mulBps, picoToUsd, picoToUsdString, picoToUsdg, usdToPico } from "../src/lib/money.ts";
import { MerkleTree, spentLeaf } from "../src/receipts/merkle.ts";
import { selectProviders, weightedShuffle, type HealthView } from "../src/router/select.ts";
import type { Candidate } from "../src/catalog/catalog.ts";
import { applyGuardrails, findPii } from "../src/gateway/guardrails.ts";
import { middleOut } from "../src/gateway/transforms.ts";
import { estimatePromptTokens, priceUsage, readUsage } from "../src/router/pricing.ts";
import { classify, fingerprintDistance, type Fingerprint } from "../src/services/canaries.ts";
import { nonceBound, parseTdxQuote } from "../src/services/attestor.ts";
import { lexicalVector } from "../src/gateway/cache.ts";
import { isEmptyCompletion, meaningfulDelta } from "../src/router/execute.ts";
import { deriveKey, generateApiKey, KEY_RE } from "../src/chain/keys.ts";
import { keccak256, encodePacked } from "viem";
import { HealthTracker } from "../src/services/health.ts";

describe("money", () => {
  test("parses decimal USD exactly into pico", () => {
    expect(usdToPico("0.0000001")).toBe(100_000n);
    expect(usdToPico("1")).toBe(1_000_000_000_000n);
    expect(usdToPico(1e-7)).toBe(100_000n);
    expect(usdToPico("0.0000000000001")).toBe(1n); // rounds up below a pico
    expect(usdToPico("0.0000000000001", "floor")).toBe(0n);
    expect(usdToPico("2.5e-3")).toBe(2_500_000_000n);
    expect(() => usdToPico("abc")).toThrow();
  });
  test("renders and converts", () => {
    expect(picoToUsdString(3_880_000n)).toBe("0.00000388");
    expect(picoToUsd(1_500_000_000_000n)).toBe(1.5);
    expect(picoToUsdg(1n)).toBe(1n); // ceil
    expect(picoToUsdg(1n, "floor")).toBe(0n);
    expect(picoToUsdg(2_000_000n)).toBe(2n);
    expect(mulBps(10_000n, 100)).toBe(100n);
    expect(mulBps(1n, 1)).toBe(1n); // ceil
  });
  test("allocate sums exactly and is proportional", () => {
    const parts = allocate(1000n, [1n, 2n, 3n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(1000n);
    expect(parts).toEqual([167n, 333n, 500n]);
    for (let i = 0; i < 200; i++) {
      const w = Array.from({ length: 1 + (i % 7) }, (_, j) => BigInt(((i * 31 + j * 17) % 97) + 1));
      const total = BigInt(i * 1234567 + 1);
      expect(allocate(total, w).reduce((a, b) => a + b, 0n)).toBe(total);
    }
  });
});

describe("merkle (OpenZeppelin-compatible)", () => {
  test("proofs verify for every leaf, odd sizes included", () => {
    for (const n of [1, 2, 3, 5, 8, 13]) {
      const leaves = Array.from({ length: n }, (_, i) => spentLeaf(keccak256(encodePacked(["uint256"], [BigInt(i)])), BigInt(i * 1000)));
      const t = new MerkleTree(leaves);
      for (let i = 0; i < n; i++) expect(MerkleTree.verify(leaves[i], t.proof(i), t.root)).toBe(true);
      expect(MerkleTree.verify(spentLeaf(keccak256("0x01"), 1n), t.proof(0), t.root)).toBe(false);
    }
  });
});

describe("keys", () => {
  test("derivation is deterministic and matches keccak(abi.encodePacked(address))", () => {
    const s = generateApiKey();
    expect(KEY_RE.test(s)).toBe(true);
    const a = deriveKey(s);
    const b = deriveKey(s);
    expect(a.chainKeyHash).toBe(b.chainKeyHash);
    expect(a.chainKeyHash).toBe(keccak256(encodePacked(["address"], [a.keyAddress])));
    expect(a.label.startsWith("sk-ar-v1-")).toBe(true);
  });
});

// ---- routing ----
const provider = (id: string, extra: Partial<Candidate["provider"]> = {}) =>
  ({ id, name: id, status: "live", dataPolicy: { training: false, retains_prompts: false, zdr: true }, attested: false, attestationHash: null, attestedAt: null, teeKind: null, anyrStake: 0n, datacenter: [], ...extra }) as unknown as Candidate["provider"];
const offer = (pid: string, prompt: bigint, completion: bigint, extra: Partial<Candidate> = {}, pextra: Partial<Candidate["provider"]> = {}) =>
  ({ modelId: "m/x", providerId: pid, providerModelId: "x", pricePrompt: prompt, priceCompletion: completion, priceRequest: 0n, priceImage: 0n, priceWebSearch: 0n, priceReasoning: 0n, priceCacheRead: null, priceCacheWrite: null, quant: "bf16", ctx: 100_000, maxOut: 4096, supportedParameters: ["tools", "temperature"], features: {}, isModerated: false, status: "live", updatedAt: new Date(), provider: provider(pid, pextra), ...extra }) as unknown as Candidate;
const healthy = (over: Partial<HealthView> = {}): HealthView => ({ outage: () => false, uptime30d: () => 1, quality: () => 1, stats: () => null, ...over });
const sel = (offers: Candidate[], prefs = {}, extra: Record<string, unknown> = {}) =>
  selectProviders({ modelId: "m/x", offers, prefs, modifiers: new Set(), requestParams: [], estimatedTokens: 100, health: healthy(), production: false, attestationMaxAgeMs: 3_600_000, ...extra } as never);

describe("provider selection", () => {
  const a = offer("a", 100n, 300n);
  const b = offer("b", 200n, 600n);
  const c = offer("c", 400n, 1200n);
  test("weights follow 1/price^2 (2x price -> ~1/4 as often first)", () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const firsts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 20_000; i++) firsts[sel([a, b, c], {}, { rand }).ordered[0].providerId]++;
    // expected shares ∝ 1 : 1/4 : 1/16  -> 76.2% : 19.0% : 4.8%
    expect(firsts.a / 20_000).toBeGreaterThan(0.72);
    expect(firsts.a / 20_000).toBeLessThan(0.8);
    expect(firsts.b / 20_000).toBeGreaterThan(0.16);
    expect(firsts.b / 20_000).toBeLessThan(0.22);
    expect(firsts.c / 20_000).toBeGreaterThan(0.03);
    expect(firsts.c / 20_000).toBeLessThan(0.07);
  });
  test("uptime and quality scale weights", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const same = [offer("p", 100n, 100n), offer("q", 100n, 100n)];
    const health = healthy({ quality: (_m, p) => (p === "q" ? 0.5 : 1) });
    let p = 0;
    for (let i = 0; i < 10_000; i++) if (sel(same, {}, { rand, health }).ordered[0].providerId === "p") p++;
    expect(p / 10_000).toBeGreaterThan(0.63); // 1 : 0.5 -> 66.7%
    expect(p / 10_000).toBeLessThan(0.7);
  });
  test("30s outage excludes", () => {
    const r = sel([a, b], {}, { health: healthy({ outage: (_m, p) => p === "a" }) });
    expect(r.ordered.map((x) => x.providerId)).toEqual(["b"]);
    expect(r.excluded).toContainEqual({ provider: "a", reason: "outage in the last 30s" });
  });
  test("pinned order respected; allow_fallbacks=false restricts", () => {
    expect(sel([a, b, c], { order: ["c", "a"] }).ordered.map((x) => x.providerId).slice(0, 2)).toEqual(["c", "a"]);
    expect(sel([a, b, c], { order: ["c", "a"], allow_fallbacks: false }).ordered.map((x) => x.providerId)).toEqual(["c", "a"]);
    expect(sel([a, b, c], { sort: "price", allow_fallbacks: false }).ordered.map((x) => x.providerId)).toEqual(["a"]);
  });
  test("sort / :floor / :nitro", () => {
    expect(sel([c, a, b], { sort: "price" }).ordered.map((x) => x.providerId)).toEqual(["a", "b", "c"]);
    expect(sel([c, a, b], {}, { modifiers: new Set(["floor"]) }).ordered.map((x) => x.providerId)).toEqual(["a", "b", "c"]);
    const stats = (_m: string, p: string) => ({ latency: { p50: p === "b" ? 50 : 500 }, throughput: { p50: p === "c" ? 300 : 50 } });
    expect(sel([a, b, c], {}, { modifiers: new Set(["nitro"]), health: healthy({ stats }) }).ordered[0].providerId).toBe("c");
    expect(sel([a, b, c], { sort: "latency" }, { health: healthy({ stats }) }).ordered[0].providerId).toBe("b");
  });
  test("filters: only/ignore/data_collection/zdr/quantizations/max_price/require_parameters/context", () => {
    const trains = offer("t", 50n, 50n, {}, { dataPolicy: { training: true } } as never);
    const noZdr = offer("n", 60n, 60n, {}, { dataPolicy: { training: false, zdr: false } } as never);
    const fp8 = offer("f", 70n, 70n, { quant: "fp8" });
    expect(sel([a, b, c], { only: ["b"] }).ordered.map((x) => x.providerId)).toEqual(["b"]);
    expect(sel([a, b, c], { ignore: ["a"], sort: "price" }).ordered.map((x) => x.providerId)).toEqual(["b", "c"]);
    expect(sel([a, trains], { data_collection: "deny" }).ordered.map((x) => x.providerId)).toEqual(["a"]);
    expect(sel([a, noZdr], { zdr: true }).ordered.map((x) => x.providerId)).toEqual(["a"]);
    expect(sel([a, fp8], { quantizations: ["fp8"] }).ordered.map((x) => x.providerId)).toEqual(["f"]);
    expect(sel([a, b, c], { max_price: { prompt: 0.0003, completion: 1 }, sort: "price" }).ordered.map((x) => x.providerId)).toEqual(["a", "b"]);
    const noTools = offer("x", 10n, 10n, { supportedParameters: ["temperature"] });
    expect(sel([a, noTools], { require_parameters: true }, { requestParams: ["tools"] }).ordered.map((x) => x.providerId)).toEqual(["a"]);
    const small = offer("s", 1n, 1n, { ctx: 50 });
    expect(sel([a, small], {}).ordered.map((x) => x.providerId)).toEqual(["a"]);
  });
  test(":free only free offers; free offers hidden otherwise", () => {
    const free = offer("free", 0n, 0n);
    expect(sel([a, free], {}).ordered.map((x) => x.providerId)).toEqual(["a"]);
    expect(sel([a, free], {}, { modifiers: new Set(["free"]) }).ordered.map((x) => x.providerId)).toEqual(["free"]);
  });
  test("private route: only freshly attested, never dev in production", () => {
    const att = offer("tee", 500n, 500n, {}, { attested: true, attestationHash: "0xabc", attestedAt: new Date(), teeKind: "tdx" } as never);
    const stale = offer("old", 500n, 500n, {}, { attested: true, attestationHash: "0xabc", attestedAt: new Date(Date.now() - 86_400_000), teeKind: "tdx" } as never);
    const dev = offer("dev", 500n, 500n, {}, { attested: true, attestationHash: "0xabc", attestedAt: new Date(), teeKind: "dev" } as never);
    expect(sel([a, att, stale, dev], { private: true }).ordered.map((x) => x.providerId).sort()).toEqual(["dev", "tee"]);
    expect(sel([a, att, stale, dev], { private: true }, { production: true }).ordered.map((x) => x.providerId)).toEqual(["tee"]);
    expect(sel([a, att], {}, { modifiers: new Set(["private"]) }).ordered.map((x) => x.providerId)).toEqual(["tee"]);
  });
  test("ANYR stake breaks ties", () => {
    const x = offer("x", 100n, 100n, {}, { anyrStake: 10n } as never);
    const y = offer("y", 100n, 100n, {}, { anyrStake: 99n } as never);
    expect(sel([x, y], { sort: "price" }).ordered.map((o) => o.providerId)).toEqual(["y", "x"]);
  });
  test("weightedShuffle is a permutation", () => {
    const items = [1, 2, 3, 4, 5];
    expect(weightedShuffle(items, () => 1).sort()).toEqual(items);
  });
});

describe("pricing", () => {
  const o = offer("a", usdToPico("0.000001"), usdToPico("0.000002"), { priceCacheRead: usdToPico("0.0000001") });
  const model = { id: "m/x", royaltyBps: 500, creator: "0xcreator", ctx: 1000, maxOut: 100 } as never;
  const fees = { royaltyBps: 500, perCallMarginBps: 100, byokFeeBps: 0 };
  test("royalty == upstream x bps; margin only per-call and <= 1%", () => {
    const u = readUsage({ prompt_tokens: 1000, completion_tokens: 500 });
    const pre = priceUsage(o, model, u, "prepaid", fees, false);
    expect(pre.upstream).toBe(usdToPico("0.002"));
    expect(pre.royalty).toBe(usdToPico("0.0001"));
    expect(pre.margin).toBe(0n);
    const per = priceUsage(o, model, u, "per_call", fees, false);
    expect(per.margin).toBe(mulBps(per.upstream + per.royalty, 100));
    expect(Number(per.margin) / Number(per.upstream + per.royalty)).toBeLessThanOrEqual(0.01);
  });
  test("cached prompt tokens use the cache-read price", () => {
    const u = readUsage({ prompt_tokens: 1000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 800 } });
    const c = priceUsage(o, model, u, "prepaid", fees, false);
    expect(c.upstream).toBe(usdToPico("0.0002") + usdToPico("0.00008"));
    expect(c.cacheDiscount).toBe(usdToPico("0.00072"));
  });
  test("BYOK: provider cost not charged, royalty still applies", () => {
    const c = priceUsage(o, model, readUsage({ prompt_tokens: 1000, completion_tokens: 0 }), "byok", fees, true);
    expect(c.upstream).toBe(0n);
    expect(c.royalty).toBe(mulBps(usdToPico("0.001"), 500));
  });
  test("estimates count images and tools", () => {
    expect(estimatePromptTokens({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] })).toBeGreaterThan(1600);
  });
});

describe("empty-200 detection", () => {
  test("null/empty content without tools and finish != length is empty", () => {
    expect(isEmptyCompletion({ choices: [{ message: { content: null }, finish_reason: "stop" }] })).toBe(true);
    expect(isEmptyCompletion({ choices: [{ message: { content: "" }, finish_reason: "stop" }] })).toBe(true);
    expect(isEmptyCompletion({ choices: [{ message: { content: "" }, finish_reason: "length" }] })).toBe(false);
    expect(isEmptyCompletion({ choices: [{ message: { content: null, tool_calls: [{ id: "1" }] }, finish_reason: "tool_calls" }] })).toBe(false);
    expect(isEmptyCompletion({ choices: [] })).toBe(true);
    expect(meaningfulDelta({ choices: [{ delta: { role: "assistant", content: "" } }] })).toBe(false);
    expect(meaningfulDelta({ choices: [{ delta: { content: "x" } }] })).toBe(true);
  });
});

describe("guardrails & transforms", () => {
  test("PII detection, redaction and blocking", () => {
    expect(findPii("mail me at a.b@example.com or 4111 1111 1111 1111").map((h) => h.type).sort()).toEqual(["CARD", "EMAIL"]);
    expect(findPii("order 1234 5678 9012 3456").length).toBe(0); // fails Luhn
    const body: Record<string, unknown> = { messages: [{ role: "user", content: "ssn 123-45-6789, key sk-abcdefghijklmnopqrstuv" }] };
    const r = applyGuardrails(body, { pii: "redact" });
    expect(r?.redactions).toBe(2);
    expect((body.messages as any)[0].content).toBe("ssn [REDACTED_SSN], key [REDACTED_API_KEY]");
    expect(() => applyGuardrails({ messages: [{ role: "user", content: "me@x.io" }] }, { pii: "block" })).toThrow();
    expect(() => applyGuardrails({ messages: [{ role: "user", content: "please DROP TABLE users" }] }, { deny_patterns: ["drop table"] })).toThrow();
    // Patterns are literal substrings: a catastrophic-backtracking regex is inert text, and fast.
    const t0 = performance.now();
    applyGuardrails({ messages: [{ role: "user", content: "a".repeat(50_000) }] }, { deny_patterns: ["(.*a){12}x", "(a+)+$"] });
    expect(performance.now() - t0).toBeLessThan(50);
  });
  test("middle-out keeps system + latest turns", () => {
    const messages = [{ role: "system", content: "sys" }, ...Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} ` + "x".repeat(300) })), { role: "user", content: "latest question" }];
    const body: Record<string, unknown> = { messages };
    const r = middleOut(body, 2000, 500);
    const out = body.messages as any[];
    expect(r.removed).toBeGreaterThan(0);
    expect(out[0].content).toBe("sys");
    expect(out.at(-1).content).toBe("latest question");
    expect(estimatePromptTokens(body)).toBeLessThanOrEqual(1500);
  });
  test("lexical vectors: near-duplicates score higher than unrelated", () => {
    const dot = (x: Float32Array, y: Float32Array) => x.reduce((s, v, i) => s + v * y[i], 0);
    const a = lexicalVector("what is the capital of france");
    const b = lexicalVector("what is the capital of france?");
    const c = lexicalVector("write a haiku about octopuses");
    expect(dot(a, b)).toBeGreaterThan(0.99);
    expect(dot(a, c)).toBeLessThan(0.3);
  });
});

describe("canary fingerprints", () => {
  const fp = (noise: number): Fingerprint =>
    Array.from({ length: 10 }, (_, i) => ({ token: "t" + i, logprob: -0.1 - i * 0.02 + Math.sin(i * 7.3) * noise, top: [{ token: "t" + i, logprob: -0.1 - i * 0.02 + Math.sin(i * 7.3) * noise }, { token: "alt" + i, logprob: -3 - Math.sin(i * 7.3) * noise }] }));
  test("distance grows with quantization noise and classification picks nearest", () => {
    expect(fingerprintDistance(fp(0), fp(0))).toBe(0);
    expect(fingerprintDistance(fp(0), fp(0.8))).toBeGreaterThan(fingerprintDistance(fp(0), fp(0.1)));
    expect(classify(fp(0.9), [{ quant: "bf16", fingerprint: fp(0) }], 0.35).guess).toBe("lower");
    expect(classify(fp(0.02), [{ quant: "bf16", fingerprint: fp(0) }], 0.35).guess).toBe("bf16");
    expect(classify(fp(0.5), [{ quant: "bf16", fingerprint: fp(0) }, { quant: "int4", fingerprint: fp(0.5) }], 0.35).guess).toBe("int4");
  });
});

describe("attestation parsing", () => {
  test("TDX v4 quote fields and nonce binding", () => {
    const q = Buffer.alloc(700);
    q.writeUInt16LE(4, 0);
    Buffer.from("aa".repeat(48), "hex").copy(q, 48 + 136);
    const nonce = "ab".repeat(32);
    Buffer.from("00".repeat(32) + nonce, "hex").copy(q, 48 + 520);
    const f = parseTdxQuote(q.toString("hex"));
    expect(f.mrtd).toBe("aa".repeat(48));
    expect(nonceBound(f.reportData, nonce)).toBe(true);
    expect(nonceBound(f.reportData, "cd".repeat(32))).toBe(false);
    expect(() => parseTdxQuote("00")).toThrow();
  });
});

describe("measured uptime", () => {
  test("null until observed; client rejections and rate limits never count against a provider", () => {
    const h = new HealthTracker();
    expect(h.observedUptime("m/x", "p")).toBeNull();
    for (let i = 0; i < 3; i++) h.record({ modelId: "m/x", providerId: "p", ok: true });
    h.record({ modelId: "m/x", providerId: "p", ok: false, errorKind: "http_5xx" });
    h.record({ modelId: "m/x", providerId: "p", ok: false, errorKind: "rejected" });
    h.record({ modelId: "m/x", providerId: "p", ok: false, errorKind: "rate_limited" });
    expect(h.observedUptime("m/x", "p")).toEqual({ rate: 0.75, events: 4 });
    expect(h.observedUptime("m/x", "other")).toBeNull();
  });
});

describe("dev faucet guard", () => {
  const key = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e";
  test("off by default; refused in production, against a remote RPC, or without a key", async () => {
    const { loadConfig } = await import("../src/config.ts");
    expect(loadConfig({ ANYROUTE_ENV: "test" }).chain.faucetKey).toBeUndefined();
    expect(loadConfig({ ANYROUTE_ENV: "test", DEV_FAUCET: "true", RHC_RPC_URL: "http://127.0.0.1:8546", DEV_FAUCET_PRIVATE_KEY: key }).chain.faucetKey).toBe(key);
    expect(() => loadConfig({ ANYROUTE_ENV: "test", DEV_FAUCET: "true", RHC_RPC_URL: "https://rpc.mainnet.chain.robinhood.com", DEV_FAUCET_PRIVATE_KEY: key })).toThrow(/local chain/);
    expect(() => loadConfig({ ANYROUTE_ENV: "test", DEV_FAUCET: "true", RHC_RPC_URL: "http://localhost:8546" })).toThrow(/DEV_FAUCET_PRIVATE_KEY/);
    expect(() =>
      loadConfig({ ANYROUTE_ENV: "production", APP_SECRET: "x".repeat(40), ADMIN_TOKEN: "y".repeat(30), PUBLIC_BASE_URL: "https://a.example", DATABASE_URL: "postgres://x", DEV_FAUCET: "true", RHC_RPC_URL: "http://127.0.0.1:8546", DEV_FAUCET_PRIVATE_KEY: key }),
    ).toThrow(/production/);
  });
});
