import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ADMIN, MODELS, startRouter, type Harness } from "./helpers.ts";
import { models, modelsLane, providers } from "../src/db/schema.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { selectProviders, type HealthView } from "../src/router/select.ts";
import { profileOf } from "../src/router/disclosure.ts";
import { MAINSTREAM, classifierFromReport, inferredVariant, laneOf, restrictedExclusion } from "../src/router/lane.ts";
import type { Candidate } from "../src/catalog/catalog.ts";

// ---- pure pieces -----------------------------------------------------------------------------------------

describe("variant classification", () => {
  const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, hfRepo: null, ...extra });

  test("a declared row wins; unknown stored values read as the most restricted setting", () => {
    expect(laneOf(model("a/b"), { variant: "native_low_refusal", status: "servable" })).toMatchObject({ variant: "native_low_refusal", servable: true, source: "declared" });
    expect(laneOf(model("a/b-abliterated"), { variant: "mainstream", status: "servable" })).toMatchObject({ variant: "mainstream", source: "declared" }); // an operator may say a name is misleading
    expect(laneOf(model("a/b"), { variant: "who-knows", status: "servable" }).variant).toBe("abliterated");
    expect(laneOf(model("a/b"), { variant: "abliterated", status: "candidate" }).servable).toBe(false);
    expect(laneOf(model("a/b"), { variant: "abliterated", status: "anything-else" }).servable).toBe(false);
  });

  test("with no row: a day-zero candidate's repository, then the name, then mainstream", () => {
    expect(laneOf(model("a/b", { hfRepo: "x/y" }), null, { variant: "abliterated", status: "evaluated" })).toMatchObject({ variant: "abliterated", servable: false, source: "candidate" });
    expect(laneOf(model("a/b"), null, { variant: "native_low_refusal", status: "servable" })).toMatchObject({ servable: true, source: "candidate" });
    // A candidate the pipeline rejected says nothing about serving.
    expect(laneOf(model("a/b"), null, { variant: "abliterated", status: "rejected" })).toMatchObject({ variant: "mainstream", source: "default" });
    expect(laneOf(model("lab/model-8b-abliterated"), null)).toMatchObject({ variant: "abliterated", servable: true, source: "inferred" });
    expect(laneOf(model("acme/chat-instruct-70b"), null)).toMatchObject({ variant: "mainstream", servable: true, source: "default" });
    expect(inferredVariant({ id: "x/y", name: "Y Uncensored 24B" })).toBe("abliterated");
    expect(inferredVariant({ id: "x/y", hfRepo: "someone/y-decensored" })).toBe("abliterated");
    expect(inferredVariant({ id: "x/censorship-research-tool" })).toBe("mainstream");
  });

  test("restricted variants need an attested class AND a reported classifier; unknown is not enough", () => {
    expect(restrictedExclusion("attested", true)).toBeNull();
    expect(restrictedExclusion("attested", false)).toMatch(/classifier/);
    expect(restrictedExclusion("attested", null)).toMatch(/classifier/);
    expect(restrictedExclusion("attested", undefined)).toMatch(/classifier/);
    expect(restrictedExclusion("policy", true)).toMatch(/attested retention/);
    expect(restrictedExclusion("vendor-forwarded", true)).toMatch(/vendor-forwarded/);
  });
});

describe("what the attestor may believe about the classifier", () => {
  const hw = { hardwareVerified: true, bindingsCommitted: true, simulated: false, allowDev: false };
  test("only committed bindings of a verified quote count", () => {
    expect(classifierFromReport({ sidecar_bindings: { classifier_enabled: true } }, hw)).toBe(true);
    expect(classifierFromReport({ sidecar_bindings: { classifier_enabled: false } }, hw)).toBe(false);
    expect(classifierFromReport({ sidecar_bindings: { classifier_enabled: "true" } }, hw)).toBe(false);
    // The document's own top-level claim is not covered by the quote.
    expect(classifierFromReport({ classifier: { enabled: true } }, hw)).toBe(false);
    expect(classifierFromReport({ classifier: { enabled: true }, sidecar_bindings: {} }, hw)).toBe(false);
    expect(classifierFromReport({ sidecar_bindings: { classifier_enabled: true } }, { ...hw, bindingsCommitted: false })).toBe(false);
    expect(classifierFromReport({ sidecar_bindings: { classifier_enabled: true } }, { ...hw, hardwareVerified: false })).toBe(false);
    expect(classifierFromReport(null, hw)).toBe(false);
    expect(classifierFromReport({}, hw)).toBe(false);
  });

  test("a development report counts only where development attestation is allowed", () => {
    const dev = { hardwareVerified: false, bindingsCommitted: false, simulated: true, allowDev: true };
    expect(classifierFromReport({ classifier: { enabled: true } }, dev)).toBe(true);
    expect(classifierFromReport({ classifier: { enabled: true } }, { ...dev, allowDev: false })).toBe(false);
    expect(classifierFromReport({ classifier: { enabled: 1 } }, dev)).toBe(false);
    expect(classifierFromReport({}, dev)).toBe(false);
    // Simulated evidence never borrows the hardware path.
    expect(classifierFromReport({ sidecar_bindings: { classifier_enabled: true } }, { ...dev, hardwareVerified: true, bindingsCommitted: true, allowDev: false })).toBe(false);
  });
});

// ---- selection -------------------------------------------------------------------------------------------

const provider = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, status: "live", dataPolicy: { training: false, retains_prompts: false, zdr: true }, attested: false, attestationHash: null, attestedAt: null, teeKind: null, anyrStake: 0n, datacenter: [], classifierEnabled: false, ...extra }) as unknown as Candidate["provider"];
const offer = (pid: string, prompt: bigint, pextra: Record<string, unknown> = {}) =>
  ({ modelId: "m/x", providerId: pid, providerModelId: "x", pricePrompt: prompt, priceCompletion: prompt * 3n, priceRequest: 0n, priceImage: 0n, priceWebSearch: 0n, priceReasoning: 0n, priceCacheRead: null, priceCacheWrite: null, quant: "bf16", ctx: 100_000, maxOut: 4096, supportedParameters: [], features: {}, isModerated: false, status: "live", updatedAt: new Date(), provider: provider(pid, pextra) }) as unknown as Candidate;
const healthy: HealthView = { outage: () => false, uptime30d: () => 1, quality: () => 1, stats: () => null };
const row = (over: Record<string, unknown> = {}) => ({ retention: "logs", jurisdiction: "unknown", legalHold: null, legalHoldNote: null, trainingUse: "unknown", claims: {}, updatedAt: new Date("2026-01-01T00:00:00Z"), ...over });
const tee = { attested: true, attestationHash: "0xabc", attestedAt: new Date(), teeKind: "tdx" };
const attestedProfile = profileOf(row({ retention: "attested", legalHold: false }) as never);
const profiles: Record<string, ReturnType<typeof profileOf>> = { enc: attestedProfile, encNoClf: attestedProfile, encStale: attestedProfile, devtee: attestedProfile, encDown: attestedProfile, policy: profileOf(row({ retention: "policy", legalHold: false }) as never) };
const offers = [
  offer("vendor", 100n),
  offer("policy", 105n, { classifierEnabled: true }), // a documented policy is not enough, whatever the flag says
  offer("enc", 110n, { ...tee, classifierEnabled: true }),
  offer("encNoClf", 120n, tee),
  offer("encStale", 130n, { ...tee, attestedAt: new Date(Date.now() - 10 * 3_600_000), classifierEnabled: true }),
  offer("devtee", 140n, { ...tee, teeKind: "dev", classifierEnabled: true }),
  offer("encDown", 150n, { ...tee, classifierEnabled: true }),
  offer("unproven", 160n, { classifierEnabled: true }), // flag set, but no attestation
];
const sel = (modelLane: unknown, prefs: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  selectProviders({ modelId: "m/x", offers, prefs, modifiers: new Set(), requestParams: [], estimatedTokens: 100, health: healthy, production: false, attestationMaxAgeMs: 3_600_000, disclosure: (id: string) => profiles[id], modelLane, ...extra } as never);
const ids = (s: ReturnType<typeof sel>) => s.ordered.map((o) => o.providerId).sort();
const reasons = (s: ReturnType<typeof sel>) => Object.fromEntries(s.excluded.map((e) => [e.provider, e.reason]));

describe("routing rule for restricted variants", () => {
  const restricted = { variant: "abliterated", servable: true };

  test("a mainstream model routes exactly as before, with or without the new input", () => {
    const all = ["devtee", "enc", "encDown", "encNoClf", "encStale", "policy", "unproven", "vendor"];
    expect(ids(sel(MAINSTREAM))).toEqual(all);
    expect(ids(sel(undefined))).toEqual(all);
    expect(ids(sel({ variant: "mainstream", servable: true }, { lane: "attested" }))).toEqual(["devtee", "enc", "encDown", "encNoClf"]);
  });

  for (const variant of ["abliterated", "native_low_refusal"]) {
    test(`${variant}: only attested providers that report the classifier, whatever the request asks`, () => {
      const lane = { variant, servable: true };
      // No lane, no disclosure option: the public default still cannot reach a vendor.
      expect(ids(sel(lane))).toEqual(["devtee", "enc", "encDown"]);
      expect(ids(sel(lane, { lane: "public" }))).toEqual(["devtee", "enc", "encDown"]);
      expect(ids(sel(lane, { lane: "attested" }))).toEqual(["devtee", "enc", "encDown"]);
      expect(ids(sel(lane, { disclosure: "any" }))).toEqual(["devtee", "enc", "encDown"]);
      expect(ids(sel(lane, { disclosure: "policy" }))).toEqual(["devtee", "enc", "encDown"]);
      expect(ids(sel(lane, { only: ["vendor"] }))).toEqual([]); // pinning a provider cannot bypass it
    });
  }

  test("each way of failing the rule has its own reason", () => {
    const r = reasons(sel(restricted));
    expect(r.vendor).toMatch(/attested retention with a fresh attestation \(this provider is vendor-forwarded\)/);
    expect(r.policy).toMatch(/attested retention with a fresh attestation \(this provider is policy\)/);
    expect(r.unproven).toMatch(/vendor-forwarded/); // declared nothing, so it cannot be attested
    expect(r.encStale).toMatch(/\(this provider is policy\)/); // a lapsed attestation degrades to policy
    expect(r.encNoClf).toMatch(/classifier/);
    expect(r.enc).toBeUndefined();
  });

  test("a development attestation counts outside production only", () => {
    expect(ids(sel(restricted, {}, { production: true }))).toEqual(["enc", "encDown"]);
  });

  test("the classifier flag is required even for a fully attested provider", () => {
    const flagOff = offers.map((o) => (o.providerId === "enc" ? { ...o, provider: { ...o.provider, classifierEnabled: false } } : o));
    expect(ids(sel(restricted, {}, { offers: flagOff }))).toEqual(["devtee", "encDown"]);
    const flagUnknown = offers.map((o) => (o.providerId === "enc" ? { ...o, provider: { ...o.provider, classifierEnabled: undefined } } : o));
    expect(ids(sel(restricted, {}, { offers: flagUnknown }))).toEqual(["devtee", "encDown"]);
  });

  test("a model that is not approved for serving is routed to nobody", () => {
    const s = sel({ variant: "abliterated", servable: false });
    expect(ids(s)).toEqual([]);
    expect(Object.values(reasons(s)).every((r) => /not been approved/.test(r))).toBe(true);
    expect(ids(sel({ variant: "mainstream", servable: false }))).toEqual([]);
  });

  test("an outage is reported only for a provider that could have served", () => {
    const down = { ...healthy, outage: (_m: string, p: string) => p === "encDown" || p === "vendor" };
    const s = sel(restricted, {}, { health: down });
    expect(ids(s)).toEqual(["devtee", "enc"]);
    const r = reasons(s);
    expect(r.encDown).toBe("outage in the last 30s");
    expect(r.vendor).toMatch(/restricted variant/); // the vendor is out on the rule, not because it is down
  });
});

describe("every route into selectProviders states the model's lane", () => {
  test("source calls pass modelLane", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(import.meta.dir, "../src"));
    const calls: string[] = [];
    for (const f of files) {
      if (f.endsWith("router/select.ts")) continue;
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/selectProviders\(\{/g)) {
        const rest = src.slice(m.index!);
        const close = rest.search(/\n\s*\}\)/); // the call's closing brace on its own line
        calls.push(`${f}: ${rest.slice(0, close).includes("modelLane") ? "ok" : "MISSING"}`);
      }
    }
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.filter((c) => c.endsWith("MISSING"))).toEqual([]);
  });
});

// ---- end to end ------------------------------------------------------------------------------------------

const ABL = { id: "flash-abl", slug: "lanetest/flash-abliterated", prompt: "0.0000002", completion: "0.0000004" };
const LOWREF = { id: "lowref-like", slug: "lanetest/lowref-like", prompt: "0.0000003", completion: "0.0000006" };
const PLAIN = { id: "plain", slug: "lanetest/plain-chat", prompt: "0.0000001", completion: "0.0000002" };
const EMBED = MODELS.embed;

let h: Harness;
const admin = { "x-admin-token": ADMIN };
const claim = { source: "https://lane.example/terms", as_of: "2025-01-15" };
const chat = (model: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  h.request("/api/v1/chat/completions", { method: "POST", headers: { ...auth.current, ...headers }, json: { model, messages: [{ role: "user", content: "hello" }], ...body } });
const auth = { current: {} as Record<string, string> };
const listed = async (query = "") => ((await (await h.request(`/api/v1/models${query}`)).json()) as { data: any[] }).data;
const putLane = (id: string, json: unknown, headers: Record<string, string> = admin) => h.request(`/api/v1/models/${id}/lane`, { method: "PUT", headers, json });
const restrictedLane = { variant: "native_low_refusal", license: "apache-2.0", base_model: "lab/base-model" };
const attest = async () => {
  await runAttestor(h.ctx);
  await h.ctx.catalog.refresh();
};

beforeAll(async () => {
  h = await startRouter({
    providers: [
      { id: "vendor", name: "Vendor", models: [ABL, LOWREF, PLAIN, EMBED] },
      { id: "enclave", name: "Enclave", models: [ABL, LOWREF, EMBED], tee: "dev", classifier: true },
      { id: "noclf", name: "NoClassifier", models: [ABL, LOWREF], tee: "dev" },
      { id: "offclf", name: "ClassifierOff", models: [ABL, LOWREF], tee: "dev", classifier: false },
    ],
  });
  auth.current = (await h.fundedKey(20n)).auth;
  for (const id of ["enclave", "noclf", "offclf"]) {
    const r = await h.request(`/api/v1/disclosure/${id}`, { method: "PUT", headers: admin, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } });
    expect(r.status).toBe(200);
  }
  await attest();
});
afterAll(async () => h.close());

describe("the classifier flag is read by the attestor", () => {
  test("only a provider whose development report says so has it; silence and false are false", async () => {
    const rows = await h.ctx.db.select({ id: providers.id, flag: providers.classifierEnabled, attested: providers.attested }).from(providers);
    const flag = Object.fromEntries(rows.map((r) => [r.id, r.flag]));
    expect(flag).toEqual({ vendor: false, enclave: true, noclf: false, offclf: false });
    expect(rows.filter((r) => r.attested).map((r) => r.id).sort()).toEqual(["enclave", "noclf", "offclf"]);
  });

  test("a failed attestation clears the flag", async () => {
    h.mocks.enclave.cfg.tee = null;
    await attest();
    expect((await h.ctx.db.select().from(providers).where(eq(providers.id, "enclave")))[0].classifierEnabled).toBe(false);
    h.mocks.enclave.cfg.tee = "dev";
    await attest();
    expect((await h.ctx.db.select().from(providers).where(eq(providers.id, "enclave")))[0].classifierEnabled).toBe(true);
  });

  test("the public provider list and endpoints report it", async () => {
    const list = ((await (await h.request("/api/v1/providers")).json()) as { data: any[] }).data;
    expect(Object.fromEntries(list.map((p) => [p.slug, p.classifier_enabled]))).toMatchObject({ enclave: true, noclf: false, offclf: false, vendor: false });
    const eps = ((await (await h.request("/api/v1/models/lanetest/plain-chat/endpoints")).json()) as { data: { endpoints: any[] } }).data.endpoints;
    expect(eps.map((e) => [e.provider_slug, e.classifier_enabled])).toEqual([["vendor", false]]);
  });
});

describe("an unclassified model whose name says abliterated is held to the rule", () => {
  test("the catalog says so and lists only the eligible endpoint", async () => {
    const m = (await listed()).find((x) => x.id === "lanetest/flash-abliterated");
    expect(m).toMatchObject({ variant: "abliterated", variant_source: "inferred", license: null, base_model: null, weights: null, creator_handle: null });
    expect(m.data_policy.providers).toBe(1);
    const eps = ((await (await h.request("/api/v1/models/lanetest/flash-abliterated/endpoints")).json()) as { data: { endpoints: any[] } }).data.endpoints;
    expect(eps.map((e) => e.provider_slug)).toEqual(["enclave"]);
    expect(eps[0]).toMatchObject({ disclosure: "attested", classifier_enabled: true });
  });

  test("a request with no options is served by the enclave and never by the vendor, and is labelled attested", async () => {
    for (let i = 0; i < 6; i++) {
      const r = await chat(ABL.slug);
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.provider).toBe("Enclave");
      expect(r.headers.get("x-anyroute-disclosure")).toBe("attested");
      expect(j.receipt.payload).toMatchObject({ disclosure: "attested" });
    }
    const streamed = await chat(ABL.slug, { stream: true });
    expect(streamed.status).toBe(200);
    await streamed.text();
    expect(streamed.headers.get("x-anyroute-disclosure")).toBe("attested");
  });

  test("pinning the vendor cannot reach it: refused with the reason, nothing sent", async () => {
    const before = h.mocks.vendor.stats.requests;
    const r = await chat(ABL.slug, { provider: { only: ["vendor"] } });
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.error.type).toBe("no_providers");
    expect(j.error.metadata.excluded.find((e: any) => e.provider === "vendor").reason).toMatch(/restricted variant/);
    expect(h.mocks.vendor.stats.requests).toBe(before);
    // Same through the lane header and an explicit public lane.
    expect((await chat(ABL.slug, { provider: { only: ["vendor"], lane: "public" } })).status).toBe(404);
  });

  test("the response cache is never used for a restricted model", async () => {
    const body = { cache: { mode: "exact" }, temperature: 0, messages: [{ role: "user", content: "cache me if you can" }] };
    const first = await chat(ABL.slug, body);
    expect(first.status).toBe(200);
    const second = await chat(ABL.slug, body);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-anyroute-cache")).toBeNull();
    expect((await second.json()).provider).toBe("Enclave");
    // Control: the same request to a mainstream model is cached.
    const plain = { ...body, messages: [{ role: "user", content: "cache me, I am mainstream" }] };
    expect((await chat(PLAIN.slug, plain)).status).toBe(200);
    expect((await chat(PLAIN.slug, plain)).headers.get("x-anyroute-cache")).toBe("hit");
  });
});

describe("declaring a variant", () => {
  test("only the operator may write, and a restricted variant needs its license and base model", async () => {
    expect((await putLane(LOWREF.slug, restrictedLane, {})).status).toBe(401);
    expect((await putLane(LOWREF.slug, restrictedLane, auth.current)).status).toBe(401);
    const noLicense = await putLane(LOWREF.slug, { variant: "native_low_refusal", base_model: "lab/base-model" });
    expect(noLicense.status).toBe(400);
    expect((await noLicense.json()).error.message).toMatch(/license/);
    expect((await putLane(LOWREF.slug, { variant: "wild" })).status).toBe(400);
    expect((await putLane(LOWREF.slug, { ...restrictedLane, extra: 1 })).status).toBe(400);
    expect((await putLane(LOWREF.slug, { ...restrictedLane, weights: { digest: "sha256:nothex" } })).status).toBe(400);
    expect((await putLane("not-an-id", restrictedLane)).status).toBe(404);
    // Nothing was stored by the refused writes.
    expect(await h.ctx.db.select().from(modelsLane)).toEqual([]);
  });

  test("before it is declared, an ordinary-looking model is served by anyone", async () => {
    const m = (await listed()).find((x) => x.id === LOWREF.slug);
    expect(m).toMatchObject({ variant: "mainstream", variant_source: "default" });
    const r = await chat(LOWREF.slug, { provider: { only: ["vendor"] } });
    expect(r.status).toBe(200);
  });

  test("declared, it is restricted at once and surfaced with its provenance", async () => {
    const w = await putLane(LOWREF.slug, {
      ...restrictedLane,
      weights: { source: "huggingface:lanetest/lowref-like", revision: "0123456789abcdef0123456789abcdef01234567", digest: `sha256:${"ab".repeat(32)}` },
      creator_handle: "lanetest",
    });
    expect(w.status).toBe(200);
    expect((await w.json()).data).toMatchObject({ model: LOWREF.slug, variant: "native_low_refusal", status: "servable", license: "apache-2.0" });
    const m = (await listed()).find((x) => x.id === LOWREF.slug);
    expect(m).toMatchObject({
      variant: "native_low_refusal",
      variant_source: "declared",
      license: "apache-2.0",
      base_model: "lab/base-model",
      weights: { source: "huggingface:lanetest/lowref-like", revision: "0123456789abcdef0123456789abcdef01234567", digest: `sha256:${"ab".repeat(32)}` },
      creator_handle: "lanetest",
    });
    expect(m.data_policy.providers).toBe(1); // only the enclave lists it now
    expect((await chat(LOWREF.slug, { provider: { only: ["vendor"] } })).status).toBe(404);
    for (let i = 0; i < 4; i++) expect((await (await chat(LOWREF.slug)).json()).provider).toBe("Enclave");
  });

  test("the admin panel procedure writes the same record", async () => {
    const via = (headers: Record<string, string>) => h.request("/trpc/models.setLane", { method: "POST", headers, json: { id: PLAIN.slug, variant: "mainstream" } });
    expect((await via({})).status).toBe(401);
    expect((await via(auth.current)).status).toBe(401);
    expect((await via(admin)).status).toBe(200);
    expect((await listed()).find((x) => x.id === PLAIN.slug)).toMatchObject({ variant: "mainstream", variant_source: "declared" });
    const bad = await h.request("/trpc/models.setLane", { method: "POST", headers: admin, json: { id: PLAIN.slug, variant: "abliterated" } });
    expect(bad.status).toBe(400);
  });

  test("an operator can classify a model before any provider lists it", async () => {
    expect((await putLane("future/model-x", restrictedLane)).status).toBe(200);
    expect((await h.ctx.db.select().from(modelsLane).where(eq(modelsLane.modelId, "future/model-x")))[0]).toMatchObject({ variant: "native_low_refusal", status: "servable" });
    await h.ctx.db.delete(modelsLane).where(eq(modelsLane.modelId, "future/model-x"));
  });

  test("?variant= filters, alongside ?lane=", async () => {
    const ids = async (q: string) => (await listed(q)).map((m) => m.id).sort();
    expect(await ids("?variant=abliterated")).toEqual([ABL.slug]);
    expect(await ids("?variant=native_low_refusal")).toEqual([LOWREF.slug]);
    expect(await ids("?variant=mainstream")).toEqual([PLAIN.slug, EMBED.slug].sort());
    expect(await ids("?variant=abliterated,native_low_refusal")).toEqual([ABL.slug, LOWREF.slug].sort());
    expect(await ids("?variant=abliterated&lane=attested")).toEqual([ABL.slug]);
    expect(await ids("?variant=mainstream&lane=attested")).toEqual([EMBED.slug]);
    expect((await listed()).length).toBe(4);
    const bad = await h.request("/api/v1/models?variant=spicy");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toMatch(/variant/);
  });
});

describe("what changes the answer", () => {
  const setEnclave = async (set: Record<string, unknown>) => {
    await h.ctx.db.update(providers).set(set).where(eq(providers.id, "enclave"));
    await h.ctx.catalog.refresh();
  };

  test("a lapsed attestation stops service and hides the endpoint", async () => {
    await setEnclave({ attestedAt: new Date(Date.now() - h.ctx.cfg.attestation.intervalMs * 5) });
    const r = await chat(ABL.slug);
    expect(r.status).toBe(404);
    expect((await r.json()).error.metadata.excluded.find((e: any) => e.provider === "enclave").reason).toMatch(/fresh attestation/);
    expect((await listed()).find((m) => m.id === ABL.slug)).toBeUndefined(); // no eligible endpoint: not listed
    await attest();
    expect((await chat(ABL.slug)).status).toBe(200);
  });

  test("a classifier that is not reported stops service, whatever else is true of the provider", async () => {
    await setEnclave({ classifierEnabled: false });
    const r = await chat(ABL.slug);
    expect(r.status).toBe(404);
    expect((await r.json()).error.metadata.excluded.find((e: any) => e.provider === "enclave").reason).toMatch(/classifier/);
    expect((await chat(ABL.slug, { provider: { lane: "attested" } })).status).toBe(404);
    expect((await chat(ABL.slug, { stream: true })).status).toBe(404);
    // The mainstream models are untouched.
    expect((await chat(PLAIN.slug)).status).toBe(200);
    await attest();
    expect((await chat(ABL.slug)).status).toBe(200);
  });

  test("a model marked candidate is routed to nobody, and is not listed", async () => {
    expect((await putLane(LOWREF.slug, { ...restrictedLane, status: "candidate" })).status).toBe(200);
    expect((await chat(LOWREF.slug)).status).toBe(404);
    expect((await listed()).find((m) => m.id === LOWREF.slug)).toBeUndefined();
    expect((await putLane(LOWREF.slug, restrictedLane)).status).toBe(200);
    expect((await chat(LOWREF.slug)).status).toBe(200);
  });

  test("an operator's mainstream declaration overrides the name, and only that", async () => {
    expect((await putLane(ABL.slug, { variant: "mainstream" })).status).toBe(200);
    const providersSeen = new Set<string>();
    for (let i = 0; i < 25; i++) providersSeen.add((await (await chat(ABL.slug)).json()).provider);
    expect(providersSeen.has("Vendor")).toBe(true);
    await h.ctx.db.delete(modelsLane).where(eq(modelsLane.modelId, ABL.slug));
    await h.ctx.catalog.refresh();
    expect((await chat(ABL.slug, { provider: { only: ["vendor"] } })).status).toBe(404);
  });

  test("embeddings honour the same rule", async () => {
    const embed = (body: Record<string, unknown>) => h.request("/api/v1/embeddings", { method: "POST", headers: auth.current, json: { model: EMBED.slug, input: "hello", ...body } });
    expect((await embed({ provider: { only: ["vendor"] } })).status).toBe(200); // mainstream today
    expect((await putLane(EMBED.slug, restrictedLane)).status).toBe(200);
    expect((await embed({ provider: { only: ["vendor"] } })).status).toBe(404);
    const ok = await embed({});
    expect(ok.status).toBe(200);
    expect((await ok.json()).provider).toBe("Enclave");
    await putLane(EMBED.slug, { variant: "mainstream" });
  });
});

describe("a day-zero candidate's repository holds a model back until it is servable", () => {
  test("a model whose Hugging Face id matches a candidate is not routed while the candidate is pending", async () => {
    await h.ctx.db.update(models).set({ hfRepo: "someone/plain-lowrefusal-8b" }).where(eq(models.id, PLAIN.slug));
    await h.ctx.db.delete(modelsLane).where(eq(modelsLane.modelId, PLAIN.slug));
    const { laneCandidates } = await import("../src/db/schema.ts");
    await h.ctx.db.insert(laneCandidates).values({ hfRepo: "someone/plain-lowrefusal-8b", baseModel: "lab/base-model", variant: "abliterated", creatorHandle: "someone", status: "evaluated" });
    await h.ctx.catalog.refresh();
    expect((await chat(PLAIN.slug)).status).toBe(404);
    expect((await listed()).find((m) => m.id === PLAIN.slug)).toBeUndefined();
    await h.ctx.db.update(laneCandidates).set({ status: "rejected" }).where(eq(laneCandidates.hfRepo, "someone/plain-lowrefusal-8b"));
    await h.ctx.catalog.refresh();
    expect((await chat(PLAIN.slug)).status).toBe(200);
  });
});
