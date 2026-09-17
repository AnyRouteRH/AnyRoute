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
