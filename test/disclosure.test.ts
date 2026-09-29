import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { MODELS, ADMIN, sse, startRouter, type Harness } from "./helpers.ts";
import { keys as keysTable, providers } from "../src/db/schema.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { balanceOf } from "../src/ledger/ledger.ts";
import { selectProviders, type HealthView } from "../src/router/select.ts";
import type { Candidate } from "../src/catalog/catalog.ts";
import { UNDECLARED, classAllowed, disclosureClass, profileOf, resolveDisclosureRequest } from "../src/router/disclosure.ts";

const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const QWEN = "qwen/qwen3-32b";
const EMBED = "acme/embed-small";
const OLD = "2025-01-15";

// ---- pure pieces ---------------------------------------------------------------------------------

const claim = (source = "https://provider.example/terms") => ({ source, as_of: OLD });
const row = (over: Record<string, unknown> = {}) => ({ retention: "logs", jurisdiction: "unknown", legalHold: null, legalHoldNote: null, trainingUse: "unknown", claims: {}, updatedAt: new Date("2026-01-01T00:00:00Z"), ...over });

describe("disclosure profiles and classes", () => {
  test("a provider without a profile gets the conservative defaults", () => {
    expect(profileOf(undefined)).toBe(UNDECLARED);
    expect(UNDECLARED).toMatchObject({ declared: false, retention: "logs", jurisdiction: "unknown", training_use: "unknown", legal_hold: { active: null, note: null } });
    expect(Object.values(UNDECLARED.claims).every((c) => c === null)).toBe(true);
    expect(disclosureClass(UNDECLARED, true)).toBe("vendor-forwarded");
  });

  test("unrecognised stored values fall back to the conservative ones", () => {
    const p = profileOf(row({ retention: "zero-ish", trainingUse: "maybe", claims: { retention: { source: 1 }, jurisdiction: claim() } }) as never);
    expect(p).toMatchObject({ declared: true, retention: "logs", training_use: "unknown" });
    expect(p.claims.retention).toBeNull();
    expect(p.claims.jurisdiction).toEqual(claim());
  });

  test("class: attested needs declared attested retention AND a fresh attestation; a policy is void under (or without a statement on) a legal hold", () => {
    const attested = profileOf(row({ retention: "attested", legalHold: false }) as never);
    expect(disclosureClass(attested, true)).toBe("attested");
    expect(disclosureClass(attested, false)).toBe("policy"); // attestation lapsed: only the documented policy remains
    const policy = profileOf(row({ retention: "policy", legalHold: false }) as never);
    expect(disclosureClass(policy, true)).toBe("policy"); // a policy provider is never "attested", whatever its TEE says
    expect(disclosureClass(profileOf(row({ retention: "policy", legalHold: true }) as never), false)).toBe("vendor-forwarded");
    expect(disclosureClass(profileOf(row({ retention: "policy", legalHold: null }) as never), false)).toBe("vendor-forwarded");
    expect(disclosureClass(profileOf(row({ retention: "logs", legalHold: false }) as never), true)).toBe("vendor-forwarded");
    // A fresh attestation on a provider that declared nothing does not make it attested.
    expect(disclosureClass(UNDECLARED, true)).toBe("vendor-forwarded");
  });

  test("ceilings", () => {
    expect(classAllowed("vendor-forwarded", "any")).toBe(true);
    expect(classAllowed("vendor-forwarded", "policy")).toBe(false);
    expect(classAllowed("policy", "policy")).toBe(true);
    expect(classAllowed("policy", "none")).toBe(false);
    expect(classAllowed("attested", "none")).toBe(true);
  });

  test("request options: defaults, stricter-of-two, lane attested implies none, unlinkable refused, junk rejected", () => {
    expect(resolveDisclosureRequest(undefined, {})).toEqual({ max: "any", lane: "public" });
    expect(resolveDisclosureRequest({ disclosure: "any", lane: "public" }, {})).toEqual({ max: "any", lane: "public" });
    expect(resolveDisclosureRequest({ disclosure: "policy" }, { disclosureMax: "none" })).toEqual({ max: "none", lane: "public" });
    expect(resolveDisclosureRequest({ disclosure: "none" }, { disclosureMax: "any" })).toEqual({ max: "none", lane: "public" }); // never relaxed
    expect(resolveDisclosureRequest({ lane: "attested" }, {})).toEqual({ max: "none", lane: "attested" });
    expect(resolveDisclosureRequest({}, { lane: " ATTESTED " })).toEqual({ max: "none", lane: "attested" });
    expect(() => resolveDisclosureRequest({ lane: "unlinkable" }, {})).toThrow(/not available yet/);
    expect(() => resolveDisclosureRequest({ lane: "public" }, { lane: "unlinkable" })).toThrow(/not available yet/);
    expect(() => resolveDisclosureRequest({ disclosure: "sometimes" }, {})).toThrow(/must be one of/);
    expect(() => resolveDisclosureRequest({}, { lane: "fast" })).toThrow(/must be one of/);
  });
});

// ---- selection -----------------------------------------------------------------------------------

const provider = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, status: "live", dataPolicy: { training: false, retains_prompts: false, zdr: true }, attested: false, attestationHash: null, attestedAt: null, teeKind: null, anyrStake: 0n, datacenter: [], ...extra }) as unknown as Candidate["provider"];
const offer = (pid: string, prompt: bigint, pextra: Record<string, unknown> = {}) =>
  ({ modelId: "m/x", providerId: pid, providerModelId: "x", pricePrompt: prompt, priceCompletion: prompt * 3n, priceRequest: 0n, priceImage: 0n, priceWebSearch: 0n, priceReasoning: 0n, priceCacheRead: null, priceCacheWrite: null, quant: "bf16", ctx: 100_000, maxOut: 4096, supportedParameters: [], features: {}, isModerated: false, status: "live", updatedAt: new Date(), provider: provider(pid, pextra) }) as unknown as Candidate;
const healthy: HealthView = { outage: () => false, uptime30d: () => 1, quality: () => 1, stats: () => null };
const tee = { attested: true, attestationHash: "0xabc", attestedAt: new Date(), teeKind: "tdx" };
const profiles: Record<string, ReturnType<typeof profileOf>> = {
  vendor: UNDECLARED,
  pol: profileOf(row({ retention: "policy", legalHold: false }) as never),
  held: profileOf(row({ retention: "policy", legalHold: true }) as never),
  enc: profileOf(row({ retention: "attested", legalHold: false }) as never),
  unproven: profileOf(row({ retention: "attested", legalHold: false }) as never), // declared attested, no TEE report
  devtee: profileOf(row({ retention: "attested", legalHold: false }) as never),
  teeUndeclared: UNDECLARED,
};
const offers = [
  offer("vendor", 100n),
  offer("pol", 110n),
  offer("held", 120n),
  offer("enc", 130n, tee),
  offer("unproven", 140n),
  offer("devtee", 150n, { ...tee, teeKind: "dev" }),
  offer("teeUndeclared", 160n, tee),
];
const sel = (prefs: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  selectProviders({ modelId: "m/x", offers, prefs, modifiers: new Set(), requestParams: [], estimatedTokens: 100, health: healthy, production: false, attestationMaxAgeMs: 3_600_000, disclosure: (id: string) => profiles[id], ...extra } as never);
const ids = (s: ReturnType<typeof sel>) => s.ordered.map((o) => o.providerId).sort();

describe("routing filters", () => {
  test("no options: every provider is a candidate, exactly as before", () => {
    const all = ["devtee", "enc", "held", "pol", "teeUndeclared", "unproven", "vendor"];
    expect(ids(sel({}))).toEqual(all);
    expect(ids(sel({ disclosure: "any", lane: "public" }))).toEqual(all);
    // Not even wiring the profile lookup changes the default result.
    expect(ids(sel({}, { disclosure: undefined }))).toEqual(all);
    const seq = (extra: Record<string, unknown>) => {
      let seed = 7;
      return selectProviders({ modelId: "m/x", offers, prefs: {}, modifiers: new Set(), requestParams: [], estimatedTokens: 100, health: healthy, production: false, attestationMaxAgeMs: 3_600_000, rand: () => ((seed = (seed * 16807) % 2147483647) / 2147483647), ...extra } as never).ordered.map((o) => o.providerId);
    };
    expect(seq({ disclosure: (id: string) => profiles[id] })).toEqual(seq({}));
  });

  test('"none" and lane "attested": attested retention with a fresh attestation only', () => {
    expect(ids(sel({ disclosure: "none" }))).toEqual(["devtee", "enc"]); // dev attestation counts only outside production
    expect(ids(sel({ lane: "attested" }))).toEqual(["devtee", "enc"]);
    expect(ids(sel({ disclosure: "none" }, { production: true }))).toEqual(["enc"]);
    const excluded = Object.fromEntries(sel({ disclosure: "none" }).excluded.map((e) => [e.provider, e.reason]));
    expect(excluded.vendor).toContain("attested retention");
    expect(excluded.pol).toContain("attested retention");
    expect(excluded.unproven).toContain("attested retention"); // declared attested, but no verified report
    expect(excluded.teeUndeclared).toBeDefined(); // a fresh TEE report without a declared profile is not enough
  });

  test('"policy": attested or a documented no-retention policy, never logs or a legal hold', () => {
    expect(ids(sel({ disclosure: "policy" }))).toEqual(["devtee", "enc", "pol", "unproven"]);
    // A stale attestation degrades "attested" to "policy", it does not disappear.
    expect(ids(sel({ disclosure: "policy" }, { attestationMaxAgeMs: 1 }))).toEqual(["devtee", "enc", "pol", "unproven"]);
    expect(ids(sel({ disclosure: "none" }, { attestationMaxAgeMs: 1 }))).toEqual([]);
  });

  test("other filters still apply on top of the ceiling", () => {
    expect(ids(sel({ disclosure: "none", ignore: ["enc"] }))).toEqual(["devtee"]);
    expect(ids(sel({ disclosure: "none" }, { health: { ...healthy, outage: (_m: string, p: string) => p === "enc" } }))).toEqual(["devtee"]);
  });

  test("unrecognised option values at this layer read as the strictest setting", () => {
    expect(ids(sel({ disclosure: "sometimes" }))).toEqual(["devtee", "enc"]);
    expect(ids(sel({ lane: "unlinkable" }))).toEqual(["devtee", "enc"]);
  });
});

// ---- end to end ----------------------------------------------------------------------------------

let h: Harness;
const auth = { current: {} as Record<string, string> };
const chat = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  h.request("/api/v1/chat/completions", { method: "POST", headers: { ...auth.current, ...headers }, json: { model: LLAMA, messages: [{ role: "user", content: "hello" }], ...body } });
const admin = { "x-admin-token": ADMIN };
const put = (id: string, json: unknown, headers: Record<string, string> = admin) => h.request(`/api/v1/disclosure/${id}`, { method: "PUT", headers, json });
const balance = async () => {
  const [k] = await h.ctx.db.select().from(keysTable);
  return (await balanceOf(h.ctx.db, k.accountId)).balance;
};

beforeAll(async () => {
  h = await startRouter({
    providers: [
      { id: "vendor", name: "Vendor", models: [MODELS.llama, MODELS.qwen, MODELS.embed] },
      { id: "policy", name: "Policy", models: [MODELS.llamaPricey] },
      { id: "enclave", name: "Enclave", models: [MODELS.llamaPricey, MODELS.embed], tee: "dev" },
      { id: "pending", name: "Pending", models: [MODELS.llama], live: false },
    ],
  });
  auth.current = (await h.fundedKey(20n)).auth;
});
afterAll(async () => h.close());

describe("disclosure profile API", () => {
  test("GET is public and reports the conservative defaults for a provider with no profile", async () => {
    const r = await h.request("/api/v1/disclosure/vendor");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toMatchObject({
      provider: "vendor",
      declared: false,
      retention: "logs",
      jurisdiction: "unknown",
      training_use: "unknown",
      legal_hold: { active: null, note: null },
      claims: { retention: null, jurisdiction: null, legal_hold: null, training_use: null },
      updated_at: null,
      current: { class: "vendor-forwarded", attestation_fresh: false, simulated: false },
    });
  });

  test("unknown and pending providers are 404", async () => {
    expect((await h.request("/api/v1/disclosure/nobody")).status).toBe(404);
    expect((await h.request("/api/v1/disclosure/pending")).status).toBe(404);
  });

  test("writes need the operator token", async () => {
    const body = { retention: { value: "policy", ...claim() }, legal_hold: { active: false, ...claim() } };
    expect((await put("policy", body, {})).status).toBe(401);
    expect((await put("policy", body, { "x-admin-token": "wrong-token" })).status).toBe(401);
    expect((await put("policy", body, auth.current)).status).toBe(401); // an API key is not an operator
    expect((await h.request("/api/v1/disclosure/policy")).status).toBe(200);
    expect((await (await h.request("/api/v1/disclosure/policy")).json()).data.declared).toBe(false);
    // The admin panel's procedure is guarded the same way.
    const viaTrpc = (headers: Record<string, string>) => h.request("/trpc/providers.setDisclosure", { method: "POST", headers, json: { id: "policy", ...body } });
    expect((await viaTrpc({})).status).toBe(401);
    expect((await viaTrpc(auth.current)).status).toBe(401);
    expect((await (await h.request("/api/v1/disclosure/policy")).json()).data.declared).toBe(false);
  });

  test("writes are validated: sources and dates are required, holds must be declared, attestation needs a TEE", async () => {
    const bad = async (body: unknown, status: number, needle?: RegExp) => {
      const r = await put("policy", body);
      expect(r.status).toBe(status);
      if (needle) expect((await r.json()).error.message).toMatch(needle);
    };
    await bad({ retention: { value: "policy" } }, 400); // no source or date
    await bad({ retention: { value: "policy", source: "ok", as_of: OLD } }, 400); // source too short
    await bad({ retention: { value: "policy", source: "https://provider.example/t", as_of: "2999-01-01" } }, 400, /date/);
    await bad({ retention: { value: "policy", source: "https://provider.example/t", as_of: "2025-02-30" } }, 400);
    await bad({ retention: { value: "forever", ...claim() } }, 400);
    await bad({ retention: { value: "policy", ...claim() }, extra: 1 }, 400); // unknown keys
    await bad({ retention: { value: "policy", ...claim() } }, 400, /legal_hold/); // a policy claim needs a stated hold status
    await bad({ retention: { value: "attested", ...claim() }, legal_hold: { active: false, ...claim() } }, 409, /TEE/); // no TEE on this provider
    expect((await put("nobody", { retention: { value: "logs", ...claim() } })).status).toBe(404);
    expect((await (await h.request("/api/v1/disclosure/policy")).json()).data.declared).toBe(false);
  });

  test("a valid write is stored with its sources and dates and read back publicly", async () => {
    const r = await put("policy", {
      retention: { value: "policy", source: "https://policy.example/data-terms", as_of: OLD },
      jurisdiction: { value: "CH", source: "https://policy.example/imprint", as_of: OLD },
      legal_hold: { active: false, note: "No orders received as of the date above.", source: "https://policy.example/transparency", as_of: OLD },
      training_use: { value: "none", source: "https://policy.example/data-terms", as_of: OLD },
    });
    expect(r.status).toBe(200);
    const j = (await (await h.request("/api/v1/disclosure/policy")).json()).data;
    expect(j).toMatchObject({
      declared: true,
      retention: "policy",
      jurisdiction: "CH",
      training_use: "none",
      legal_hold: { active: false, note: "No orders received as of the date above." },
      claims: { retention: { source: "https://policy.example/data-terms", as_of: OLD }, jurisdiction: { as_of: OLD }, legal_hold: { as_of: OLD }, training_use: { as_of: OLD } },
      current: { class: "policy", attestation_fresh: false },
    });
    expect(j.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Replacing omits what is not restated: it reverts to the conservative default rather than lingering.
    await put("policy", { retention: { value: "policy", ...claim() }, legal_hold: { active: false, ...claim() } });
    expect((await (await h.request("/api/v1/disclosure/policy")).json()).data).toMatchObject({ jurisdiction: "unknown", training_use: "unknown", claims: { jurisdiction: null } });
  });

  test("the admin panel procedure writes the same profile", async () => {
    const r = await h.request("/trpc/providers.setDisclosure", { method: "POST", headers: admin, json: { id: "vendor", retention: { value: "logs", ...claim() }, jurisdiction: { value: "US", ...claim() } } });
    expect(r.status).toBe(200);
    expect((await (await h.request("/api/v1/disclosure/vendor")).json()).data).toMatchObject({ declared: true, retention: "logs", jurisdiction: "US" });
    const missing = await h.request("/trpc/providers.setDisclosure", { method: "POST", headers: admin, json: { id: "nobody", retention: { value: "logs", ...claim() } } });
    expect(missing.status).toBe(404);
  });
});

describe("disclosure in requests, headers and receipts", () => {
  const declareEnclave = () => put("enclave", { retention: { value: "attested", ...claim() }, legal_hold: { active: false, ...claim() }, jurisdiction: { value: "DE", ...claim() } });
  const setStale = async () => {
    await h.ctx.db.update(providers).set({ attestedAt: new Date(Date.now() - h.ctx.cfg.attestation.intervalMs * 5) }).where(eq(providers.id, "enclave"));
    await h.ctx.catalog.refresh();
  };

  test("defaults are unchanged: any provider, and the label says what was served", async () => {
    // Every provider is reachable with no options, and the label follows its profile (set by the tests above):
    // vendor documented logs, policy documented a no-retention policy, enclave has no profile yet.
    for (const [slug, name, label] of [["vendor", "Vendor", "vendor-forwarded"], ["policy", "Policy", "policy"], ["enclave", "Enclave", "vendor-forwarded"]]) {
      const r = await chat({ provider: { only: [slug] } });
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.provider).toBe(name);
      expect(r.headers.get("x-anyroute-disclosure")).toBe(label);
      expect(r.headers.get("x-anyroute-lane")).toBe("public");
      expect(j.receipt.payload).toMatchObject({ disclosure: label, lane: "public" });
    }
    const plain = await chat();
    expect(plain.status).toBe(200);
    expect(plain.headers.get("x-anyroute-disclosure")).toBe((await plain.json()).receipt.payload.disclosure);
    // Explicit defaults behave the same.
    expect((await chat({ provider: { disclosure: "any", lane: "public" } })).status).toBe(200);
    expect((await chat({}, { "x-anyroute-disclosure-max": "any", "x-anyroute-lane": "public" })).status).toBe(200);
  });

  test("with nothing attested yet, none/attested are refused with a clear 409 and nothing is sent or charged", async () => {
    await declareEnclave(); // declared, but the attestor has not run: no fresh report
    const before = await balance();
    for (const [body, headers, type] of [
      [{ provider: { disclosure: "none" } }, {}, "disclosure_unavailable"],
      [{ provider: { lane: "attested" } }, {}, "lane_unavailable"],
      [{}, { "x-anyroute-disclosure-max": "none" }, "disclosure_unavailable"],
      [{}, { "x-anyroute-lane": "attested" }, "lane_unavailable"],
      [{ stream: true, provider: { disclosure: "none" } }, {}, "disclosure_unavailable"],
    ] as const) {
      const r = await chat({ ...body }, { ...headers });
      expect(r.status).toBe(409);
      const j = await r.json();
      expect(j.error.type).toBe(type);
      expect(j.error.message).toMatch(/Nothing was sent to any provider and nothing was charged/);
      expect(j.error.metadata.requested.disclosure).toBe("none");
      expect(j.error.metadata.excluded.length).toBeGreaterThan(0);
    }
    expect(await balance()).toBe(before);
    // The plain request still works: the ceiling is what refused those, not the model.
    expect((await chat()).status).toBe(200);
  });

  test("after a real attestation, none routes only to the attested provider; header and receipt say attested", async () => {
    const att = await runAttestor(h.ctx);
    expect((att.results[0] as any).ok).toBe(true);
    for (let i = 0; i < 5; i++) {
      const r = await chat({ provider: { disclosure: "none" } });
      expect(r.status).toBe(200);
      const j = await r.json();
      const receipt = structuredClone(j.receipt); // (bun's toMatchObject writes matchers back into the object)
      expect(j.provider).toBe("Enclave");
      expect(r.headers.get("x-anyroute-disclosure")).toBe("attested");
      expect(r.headers.get("x-anyroute-lane")).toBe("public");
      expect(j.receipt.payload).toMatchObject({ disclosure: "attested", lane: "public", attestation: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
      // The dev attestation is what this test router runs on, and the receipt says so.
      expect(j.receipt.payload.attestation_simulated).toBe(true);
      const v = await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload: receipt.payload, sig: receipt.sig, key_id: receipt.key_id } })).json();
      expect(v.data.signature_valid).toBe(true);
      const forged = await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload: { ...receipt.payload, disclosure: "vendor-forwarded" }, sig: receipt.sig, key_id: receipt.key_id } })).json();
      expect(forged.data.signature_valid).toBe(false);
    }
  });

  test("lane attested by body or header, and the stricter of two settings wins", async () => {
    for (const [body, headers] of [
      [{ provider: { lane: "attested" } }, {}],
      [{}, { "x-anyroute-lane": "attested" }],
      [{}, { "x-anyroute-disclosure-max": "none" }],
      [{ provider: { disclosure: "policy" } }, { "x-anyroute-disclosure-max": "none" }],
      [{ provider: { disclosure: "none" } }, { "x-anyroute-disclosure-max": "any" }], // a header cannot relax the body
      [{ provider: { lane: "public", disclosure: "none" } }, { "x-anyroute-lane": "public" }],
    ] as const) {
      const r = await chat({ ...body }, { ...headers });
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.provider).toBe("Enclave");
      expect(r.headers.get("x-anyroute-disclosure")).toBe("attested");
      expect(j.receipt.payload.lane).toBe(r.headers.get("x-anyroute-lane"));
    }
    const lane = await (await chat({ provider: { lane: "attested" } })).json();
    expect(lane.receipt.payload.lane).toBe("attested");
  });

  test("streaming: header when the class is settled up front, receipt always", async () => {
    const r = await chat({ stream: true, provider: { disclosure: "none" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-anyroute-disclosure")).toBe("attested");
    expect(r.headers.get("x-anyroute-lane")).toBe("public");
    const s = await sse(r);
    expect(s.done).toBe(true);
    expect(s.events.at(-1).receipt.payload).toMatchObject({ disclosure: "attested", lane: "public" });
    // With mixed classes reachable the header is left off (the provider is not chosen yet) and the receipt tells.
    const mixed = await chat({ stream: true });
    const m = await sse(mixed);
    expect(["attested", "policy", "vendor-forwarded"]).toContain(m.events.at(-1).receipt.payload.disclosure);
  });

  test("policy: documented policy or attested retention, no downgrade to logs", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await chat({ provider: { disclosure: "policy" } });
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(["Policy", "Enclave"]).toContain(j.provider);
      expect(r.headers.get("x-anyroute-disclosure")).toBe(j.provider === "Enclave" ? "attested" : "policy");
      expect(j.receipt.payload.disclosure).toBe(r.headers.get("x-anyroute-disclosure"));
    }
  });

  test("a legal hold removes the policy provider from the policy ceiling", async () => {
    await put("policy", { retention: { value: "policy", ...claim() }, legal_hold: { active: true, note: "Preservation order.", ...claim() } });
    for (let i = 0; i < 6; i++) {
      const j = await (await chat({ provider: { disclosure: "policy" } })).json();
      expect(j.provider).toBe("Enclave");
    }
    await put("policy", { retention: { value: "policy", ...claim() }, legal_hold: { active: false, ...claim() } });
  });

  test("a lapsed attestation is never reported as attested: none refuses, policy still serves", async () => {
    await setStale();
    const none = await chat({ provider: { disclosure: "none" } });
    expect(none.status).toBe(409);
    expect((await h.request("/api/v1/disclosure/enclave").then((r) => r.json())).data.current).toMatchObject({ class: "policy", attestation_fresh: false });
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const r = await chat({ provider: { disclosure: "policy" } });
      expect(r.status).toBe(200);
      seen.add((await r.json()).provider);
      expect(r.headers.get("x-anyroute-disclosure")).toBe("policy");
    }
    expect([...seen].every((p) => p === "Policy" || p === "Enclave")).toBe(true);
    await runAttestor(h.ctx);
    expect((await chat({ provider: { disclosure: "none" } })).status).toBe(200);
  });

  test("a compliant provider that is down gives a 503, never a fallback to one that is not", async () => {
    const health = h.ctx.health as unknown as { outage: (m: string, p: string) => boolean };
    const original = health.outage.bind(h.ctx.health);
    health.outage = (m, p) => p === "enclave" || original(m, p);
    try {
      const before = await balance();
      const r = await chat({ provider: { lane: "attested" } });
      expect(r.status).toBe(503);
      expect(r.headers.get("retry-after")).toBe("30");
      const j = await r.json();
      expect(j.error.type).toBe("disclosure_provider_unavailable");
      expect(j.error.message).toMatch(/nothing was charged/);
      expect(await balance()).toBe(before);
      expect((await chat()).status).toBe(200); // the default request is unaffected
    } finally {
      health.outage = original;
    }
  });

  test("a model no attested provider serves is refused, not served by the others", async () => {
    const ok = await chat({ model: QWEN });
    expect(ok.status).toBe(200);
    const r = await chat({ model: QWEN, provider: { disclosure: "none" } });
    expect(r.status).toBe(409);
    expect((await r.json()).error.type).toBe("disclosure_unavailable");
  });

  test("fallback models are filtered by the same ceiling", async () => {
    const r = await chat({ model: QWEN, models: [QWEN, LLAMA], provider: { disclosure: "none" } });
    expect(r.status).toBe(200);
    expect((await r.json()).provider).toBe("Enclave");
  });

  test("embeddings honour the same options, headers and receipt fields", async () => {
    const embed = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
      h.request("/api/v1/embeddings", { method: "POST", headers: { ...auth.current, ...headers }, json: { model: EMBED, input: ["a", "bb"], ...body } });
    const plain = await embed();
    expect(plain.status).toBe(200);
    expect(plain.headers.get("x-anyroute-lane")).toBe("public");
    const strict = await embed({ provider: { disclosure: "none" } });
    expect(strict.status).toBe(200);
    const j = await strict.json();
    expect(j.receipt.payload).toMatchObject({ disclosure: "attested", lane: "public" });
    expect(strict.headers.get("x-anyroute-disclosure")).toBe("attested");
    expect((await embed({}, { "x-anyroute-lane": "attested" })).status).toBe(200);
    const refused = await embed({ provider: { disclosure: "none", ignore: ["enclave"] } });
    expect(refused.status).toBe(409); // with the only compliant provider ignored, the ceiling leaves nothing (no fallback to the others)
    await setStale();
    const lapsed = await embed({ provider: { disclosure: "none" } });
    expect(lapsed.status).toBe(409);
    expect((await lapsed.json()).error.type).toBe("disclosure_unavailable");
    await runAttestor(h.ctx);
    const unl = await embed({ provider: { lane: "unlinkable" } });
    expect(unl.status).toBe(501);
  });

  test("a response cache never serves or stores a request that carries a ceiling", async () => {
    const cache = { cache: { mode: "exact" }, temperature: 0, messages: [{ role: "user", content: "cache me under a ceiling" }] };
    const a = await chat({ ...cache, provider: { disclosure: "none" } });
    expect(a.status).toBe(200);
    const b = await chat({ ...cache, provider: { disclosure: "none" } });
    expect(b.status).toBe(200);
    expect(b.headers.get("x-anyroute-cache")).toBeNull();
    expect((await b.json()).receipt.payload.mode).not.toBe("cache");
    // Default requests keep the existing cache behaviour, and a hit is labelled conservatively.
    const plain = { cache: { mode: "exact" }, temperature: 0, messages: [{ role: "user", content: "cache me plainly" }] };
    await (await chat(plain)).json();
    const hit = await chat(plain);
    expect(hit.headers.get("x-anyroute-cache")).toBe("hit");
    expect(hit.headers.get("x-anyroute-disclosure")).toBe("vendor-forwarded");
    expect((await hit.json()).receipt.payload).toMatchObject({ mode: "cache", disclosure: "vendor-forwarded", lane: "public" });
  });
});

describe("unlinkable lane", () => {
  test("is refused clearly before any provider is contacted or any charge is made", async () => {
    const before = await balance();
    for (const [body, headers] of [
      [{ provider: { lane: "unlinkable" } }, {}],
      [{}, { "x-anyroute-lane": "unlinkable" }],
      [{ stream: true, provider: { lane: "unlinkable" } }, {}],
      [{ provider: { lane: "attested" } }, { "x-anyroute-lane": "unlinkable" }],
    ] as const) {
      const r = await chat({ ...body }, { ...headers });
      expect(r.status).toBe(501);
      const j = await r.json();
      expect(j.error.type).toBe("lane_not_available");
      expect(j.error.message).toMatch(/not available yet/);
      expect(j.error.metadata.available_lanes).toEqual(["public", "attested"]);
    }
    expect(await balance()).toBe(before);
    const m = await h.request("/api/v1/models?lane=unlinkable");
    expect(m.status).toBe(501);
  });

  test("an unknown lane or ceiling is a 400 naming the accepted values", async () => {
    const lane = await chat({ provider: { lane: "fast" } });
    expect(lane.status).toBe(400);
    expect((await lane.json()).error.message).toMatch(/public, attested, unlinkable/);
    const disc = await chat({}, { "x-anyroute-disclosure-max": "some" });
    expect(disc.status).toBe(400);
    expect((await disc.json()).error.message).toMatch(/none, policy, any/);
    expect((await h.request("/api/v1/models?lane=fast")).status).toBe(400);
  });
});

describe("models lane filter", () => {
  test("?lane=attested lists only models with an attested endpoint; default and public list everything", async () => {
    await runAttestor(h.ctx);
    const all = (await (await h.request("/api/v1/models")).json()).data.map((m: any) => m.id).sort();
    expect(all).toEqual([EMBED, LLAMA, QWEN].sort());
    expect((await (await h.request("/api/v1/models?lane=public")).json()).data.map((m: any) => m.id).sort()).toEqual(all);
    const attested = (await (await h.request("/api/v1/models?lane=attested")).json()).data;
    expect(attested.map((m: any) => m.id).sort()).toEqual([EMBED, LLAMA].sort());
    const llama = attested.find((m: any) => m.id === LLAMA);
    expect(llama.disclosure).toMatchObject({ best: "attested", endpoints: { attested: 1 } });
    expect((await (await h.request("/v1/models?lane=attested")).json()).data.length).toBe(2);
    // Endpoints show the class each is served under.
    const ep = (await (await h.request(`/api/v1/models/${LLAMA}/endpoints`)).json()).data.endpoints;
    expect(Object.fromEntries(ep.map((e: any) => [e.provider_slug, e.disclosure]))).toMatchObject({ enclave: "attested", policy: "policy", vendor: "vendor-forwarded" });
    // Without a fresh attestation the lane has no models.
    await h.ctx.db.update(providers).set({ attestedAt: new Date(Date.now() - h.ctx.cfg.attestation.intervalMs * 5) }).where(eq(providers.id, "enclave"));
    await h.ctx.catalog.refresh();
    expect((await (await h.request("/api/v1/models?lane=attested")).json()).data).toEqual([]);
    await runAttestor(h.ctx);
  });
});

describe("dev attestation stays out of production", () => {
  test("a dev TEE is not attested in production, and writing an attested claim on one is refused", async () => {
    const p = profileOf(row({ retention: "attested", legalHold: false }) as never);
    const devOffer = offer("enc", 100n, { ...tee, teeKind: "dev" });
    const asClass = (production: boolean) => selectProviders({ modelId: "m/x", offers: [devOffer], prefs: { disclosure: "none" }, modifiers: new Set(), requestParams: [], estimatedTokens: 1, health: healthy, production, attestationMaxAgeMs: 3_600_000, disclosure: () => p } as never).ordered.length;
    expect(asClass(false)).toBe(1);
    expect(asClass(true)).toBe(0);
    const prod = await startRouter({ providers: [{ id: "enclave", name: "Enclave", models: [MODELS.llama], tee: "dev" }] });
    try {
      prod.ctx.cfg.production = true;
      const r = await prod.request("/api/v1/disclosure/enclave", { method: "PUT", headers: admin, json: { retention: { value: "attested", ...claim() }, legal_hold: { active: false, ...claim() } } });
      expect(r.status).toBe(409);
    } finally {
      await prod.close();
    }
  });
});
