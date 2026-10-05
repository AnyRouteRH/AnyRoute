import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agentPolicies } from "../src/agents/schema.ts";
import { agentPolicySchema, agentPolicySha256, type AgentPolicy } from "../src/agents/policy.ts";
import { combineRouteDefaults, namesLane, routeDefaultLane } from "../src/routing/route-default.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { ADMIN, MODELS, startRouter, type Harness } from "./helpers.ts";
import { STARTER_RULEBOOKS } from "../web/lib/agent-starters.js";

// U101: a key's default privacy route (rulebook `route_default`), applied only to a request that names no lane.

const LLAMA = MODELS.llama.slug; // served by "vendor" and by the attested "enclave"
const QWEN = MODELS.qwen.slug; // served by "vendor" only: no attested endpoint
const base: AgentPolicy = { version: 1, models: {}, caps: {}, on_breach: "deny" };
const claim = { source: "https://provider.example/terms", as_of: "2025-01-15" };

describe("the rule, without the router", () => {
  const none = () => undefined;
  test("every existing way of naming a lane counts, and nothing else does", () => {
    expect(namesLane({ model: LLAMA }, none)).toBe(false);
    expect(namesLane({ model: LLAMA, provider: { only: ["vendor"], private: false } }, none)).toBe(false);
    for (const provider of [{ lane: "public" }, { lane: "attested" }, { disclosure: "any" }, { disclosure: "none" }, { lane_downgrade: "attested" }, { private: true }])
      expect(namesLane({ model: LLAMA, provider }, none), JSON.stringify(provider)).toBe(true);
    for (const h of ["x-anyroute-lane", "x-anyroute-disclosure-max", "x-anyroute-lane-downgrade"]) expect(namesLane({ model: LLAMA }, (n) => (n === h ? "public" : undefined)), h).toBe(true);
    expect(namesLane({ model: `${LLAMA}:private` }, none)).toBe(true);
    expect(namesLane({ model: QWEN, models: [`${LLAMA}:private`] }, none)).toBe(true);
    // An unrecognised value still names a lane: the existing parser refuses it (400), the default never replaces it.
    expect(namesLane({ model: LLAMA, provider: { lane: "bogus" } }, none)).toBe(true);
  });

  test("the strictest default wins across a key's rulebooks, and their lane allowlists intersect", () => {
    expect(combineRouteDefaults([])).toEqual({ route: "standard", lanes: null });
    expect(combineRouteDefaults([{}, { route_default: "proven_first" }])).toEqual({ route: "proven_first", lanes: null });
    expect(combineRouteDefaults([{ route_default: "proven_only" }, { route_default: "proven_first" }]).route).toBe("proven_only");
    expect(combineRouteDefaults([{ route_default: "standard", lanes: ["public", "attested"] }, { lanes: ["attested", "unlinkable"] }])).toEqual({ route: "standard", lanes: ["attested"] });
  });

  test("standard adds nothing, proven_only is always attested, proven_first is attested only when available and allowed", () => {
    const yes = () => true, no = () => false;
    expect(routeDefaultLane("standard", null, yes)).toBeNull();
    expect(routeDefaultLane("proven_only", null, no)).toBe("attested");
    expect(routeDefaultLane("proven_only", ["public"], yes)).toBe("attested"); // the allowlist then refuses it: stricter wins
    expect(routeDefaultLane("proven_first", null, yes)).toBe("attested");
    expect(routeDefaultLane("proven_first", null, no)).toBe("public");
    expect(routeDefaultLane("proven_first", ["public"], yes)).toBe("public"); // never widened into a lane the rulebook excludes
    expect(routeDefaultLane("proven_first", ["attested"], no)).toBe("public"); // and the allowlist then refuses that
  });

  test("the rulebook accepts the three settings only, and a rulebook without one keeps its hash", () => {
    for (const route_default of ["standard", "proven_first", "proven_only"] as const) expect(agentPolicySchema.parse({ ...base, route_default }).route_default).toBe(route_default);
    expect(() => agentPolicySchema.parse({ ...base, route_default: "attested" })).toThrow();
    expect(agentPolicySha256(agentPolicySchema.parse(base))).toBe(agentPolicySha256(base));
    expect(agentPolicySha256({ ...base, route_default: "proven_first" })).not.toBe(agentPolicySha256(base));
  });
});

describe("over HTTP", () => {
  let h: Harness;
  type Key = Awaited<ReturnType<Harness["fundedKey"]>>;
  const chat = (k: Key, json: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    h.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, ...headers }, json: { model: LLAMA, messages: [{ role: "user", content: "hi" }], max_tokens: 16, ...json } });
  const rulebook = async (k: Key, policy: Partial<AgentPolicy>) => {
    const r = await h.request(`/api/v1/agents/${k.hash}/policy`, { method: "PUT", headers: k.auth, json: { ...base, ...policy } });
    expect(r.status).toBe(200);
    return (await r.json()).data;
  };
  const keyWith = async (policy?: Partial<AgentPolicy>) => {
    const k = await h.fundedKey();
    if (policy) await rulebook(k, policy);
    return k;
  };
  const calls = () => ({ vendor: h.mocks.vendor.stats.requests, enclave: h.mocks.enclave.stats.requests });
  const served = async (r: Response) => {
    expect(r.status).toBe(200);
    const payload = (await r.json()).receipt.payload as { id: string; lane: string; provider: string; disclosure: string };
    expect(r.headers.get("x-anyroute-lane")).toBe(payload.lane);
    return payload;
  };

  beforeAll(async () => {
    h = await startRouter({
      env: { AGENT_POLICY_ENABLED: "true" },
      providers: [
        { id: "vendor", name: "Vendor", models: [MODELS.llama, MODELS.qwen] },
        { id: "enclave", name: "Enclave", models: [MODELS.llamaPricey], tee: "dev" },
      ],
    });
    const declare = await h.request("/api/v1/disclosure/enclave", { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } });
    expect(declare.status).toBe(200);
    await runAttestor(h.ctx);
    await h.ctx.catalog.refresh();
  });
  afterAll(async () => {
    await h?.close();
  });

  test("standard, or no rulebook at all: a request with no lane is public exactly as before, with no new header", async () => {
    for (const k of [await keyWith(), await keyWith({ route_default: "standard" }), await keyWith({ lanes: ["public", "attested"] })]) {
      for (let i = 0; i < 3; i++) {
        const r = await chat(k, { provider: { only: ["vendor"] } });
        expect(r.headers.get("x-anyroute-default-route")).toBeNull();
        expect(await served(r)).toMatchObject({ lane: "public", provider: "vendor" });
      }
    }
  });

  test("proven_only: a request with no lane is served exactly as lane attested", async () => {
    const k = await keyWith({ route_default: "proven_only" });
    const before = calls();
    const r = await chat(k);
    expect(r.headers.get("x-anyroute-default-route")).toBe("proven_only; lane=attested");
    expect(await served(r)).toMatchObject({ lane: "attested", disclosure: "attested", provider: "enclave" });
    expect(calls()).toEqual({ vendor: before.vendor, enclave: before.enclave + 1 });
    // A stream too.
    const s = await chat(k, { stream: true });
    expect(s.status).toBe(200);
    expect(s.headers.get("x-anyroute-lane")).toBe("attested");
    await s.text();
  });

  test("proven_only refuses with the attested lane's own refusal when nothing qualifies, and sends nothing", async () => {
    const k = await keyWith({ route_default: "proven_only" });
    const before = calls();
    const r = await chat(k, { model: QWEN });
    expect(r.status).toBe(503);
    const e = (await r.json()).error;
    expect(e.type).toBe("no_attested_endpoint");
    expect(e.metadata).toMatchObject({ lane: "attested", reason: "none_attested" });
    // The same refusal as asking for the lane outright.
    const asked = await chat(await keyWith(), { model: QWEN, provider: { lane: "attested" } });
    expect(asked.status).toBe(503);
    const same = (await asked.json()).error;
    expect({ type: same.type, message: same.message, reason: same.metadata.reason }).toEqual({ type: e.type, message: e.message, reason: e.metadata.reason });
    expect(calls()).toEqual(before);
  });

  test("proven_first: attested when the model has an attested endpoint, otherwise standard, receipted and labelled as standard", async () => {
    const k = await keyWith({ route_default: "proven_first" });
    const proven = await chat(k);
    expect(proven.headers.get("x-anyroute-default-route")).toBe("proven_first; lane=attested");
    expect(await served(proven)).toMatchObject({ lane: "attested", provider: "enclave" });

    const before = calls();
    const fallback = await chat(k, { model: QWEN });
    expect(fallback.headers.get("x-anyroute-default-route")).toBe("proven_first; lane=public");
    const receipt = await served(fallback);
    expect(receipt).toMatchObject({ lane: "public", provider: "vendor" });
    expect(receipt.disclosure).not.toBe("attested");
    expect(calls()).toEqual({ vendor: before.vendor + 1, enclave: before.enclave });
    const label = (await (await h.request(`/api/v1/receipts/${receipt.id}/privacy`)).json()).data;
    expect(label.lane).toBe("public");
    expect(label.label.hardware.attested).toBe(false);
    expect(JSON.stringify([label.summary, label.short, label.label.hardware.text])).not.toMatch(/proven enclave|provider's attested enclave|Attested hardware|Hardware: attested/);
  });

  test("proven_first falls back when the attested endpoint would not take this request (provider.only names the vendor)", async () => {
    const k = await keyWith({ route_default: "proven_first" });
    const r = await chat(k, { provider: { only: ["vendor"] } });
    expect(r.headers.get("x-anyroute-default-route")).toBe("proven_first; lane=public");
    expect(await served(r)).toMatchObject({ lane: "public", provider: "vendor" });
  });

  test("a lane the request names always wins over the default, by any existing means", async () => {
    const only = await keyWith({ route_default: "proven_only" });
    const first = await keyWith({ route_default: "proven_first" });
    for (const [json, headers] of [
      [{ provider: { lane: "public", only: ["vendor"] } }, {}],
      [{ provider: { only: ["vendor"] } }, { "x-anyroute-lane": "public" }],
      [{ provider: { disclosure: "any", only: ["vendor"] } }, {}],
      [{ provider: { only: ["vendor"] } }, { "x-anyroute-disclosure-max": "any" }],
    ] as const) {
      const r = await chat(only, json, headers);
      expect(r.headers.get("x-anyroute-default-route")).toBeNull();
      expect(await served(r)).toMatchObject({ lane: "public", provider: "vendor" });
    }
    // Naming the attested lane on a model without one keeps the lane's refusal, even under proven_first.
    const r = await chat(first, { model: QWEN, provider: { lane: "attested" } });
    expect(r.status).toBe(503);
    expect(r.headers.get("x-anyroute-default-route")).toBeNull();
    // `:private` is the existing private route, untouched by the default.
    const p = await chat(only, { model: `${LLAMA}:private` });
    expect(p.headers.get("x-anyroute-default-route")).toBeNull();
    expect(await served(p)).toMatchObject({ provider: "enclave" });
    // The key's own routing defaults (keys.routing.provider.lane) are an existing lane setting, so they win as well.
    expect((await h.request(`/api/v1/keys/${only.hash}`, { method: "PATCH", headers: only.auth, json: { routing: { provider: { lane: "public", only: ["vendor"] } } } })).status).toBe(200);
    const viaKey = await chat(only);
    expect(viaKey.headers.get("x-anyroute-default-route")).toBeNull();
    expect(await served(viaKey)).toMatchObject({ lane: "public", provider: "vendor" });
  });

  test("the rulebook's lane allowlist is stricter: the default never widens it", async () => {
    // proven_first never picks a lane the rulebook excludes.
    const publicOnly = await keyWith({ route_default: "proven_first", lanes: ["public"] });
    const r = await chat(publicOnly);
    expect(r.headers.get("x-anyroute-default-route")).toBe("proven_first; lane=public");
    expect((await served(r)).lane).toBe("public");
    // proven_only under a public-only allowlist: refused by the rulebook, never served on the public lane.
    const before = calls();
    const refused = await chat(await keyWith({ route_default: "proven_only", lanes: ["public"] }));
    expect(refused.status).toBe(403);
    const e = (await refused.json()).error;
    expect(e.type).toBe("agent_policy_denied");
    expect(e.metadata.reasons.map((x: { code: string }) => x.code)).toContain("lane_not_allowed");
    // proven_first falling back to public under an attested-only allowlist: the allowlist refuses it as before.
    const attestedOnly = await chat(await keyWith({ route_default: "proven_first", lanes: ["attested"] }), { model: QWEN });
    expect(attestedOnly.status).toBe(403);
    expect((await attestedOnly.json()).error.metadata.reasons.map((x: { code: string }) => x.code)).toContain("lane_not_allowed");
    expect(calls()).toEqual(before);
  });

  test("the Proven hardware only starter serves a request that names no lane on proven hardware instead of denying it", async () => {
    const starter = STARTER_RULEBOOKS.find((t) => t.id === "private")!.policy as AgentPolicy;
    expect(starter.lanes).toEqual(["attested"]);
    expect(starter.route_default).toBe("proven_only");
    const k = await h.fundedKey();
    expect((await h.request(`/api/v1/agents/${k.hash}/policy`, { method: "PUT", headers: k.auth, json: starter })).status).toBe(200);
    const r = await chat(k);
    expect(r.headers.get("x-anyroute-default-route")).toBe("proven_only; lane=attested");
    expect(await served(r)).toMatchObject({ lane: "attested", provider: "enclave" });
    // A request that asks for the public lane is still outside its allowlist.
    const named = await chat(k, { provider: { lane: "public" } });
    expect(named.status).toBe(403);
    expect((await named.json()).error.metadata.reasons.map((x: { code: string }) => x.code)).toContain("lane_not_allowed");
  });

  test("the rulebook API stores and returns the setting", async () => {
    const k = await keyWith({ route_default: "proven_first" });
    const read = (await (await h.request(`/api/v1/agents/${k.hash}/policy`, { headers: k.auth })).json()).data;
    expect(read.policy.route_default).toBe("proven_first");
    const bad = await h.request(`/api/v1/agents/${k.hash}/policy`, { method: "PUT", headers: k.auth, json: { ...base, route_default: "attested" } });
    expect(bad.status).toBe(400);
  });
});

test("with rulebooks switched off, a stored default is not read and requests route as before", async () => {
  const off = await startRouter({
    providers: [
      { id: "vendor", name: "Vendor", models: [MODELS.llama] },
      { id: "enclave", name: "Enclave", models: [MODELS.llamaPricey], tee: "dev" },
    ],
  });
  try {
    const k = await off.fundedKey();
    await off.ctx.db.insert(agentPolicies).values({ keyHash: k.hash, version: 1, spec: { ...base, route_default: "proven_only" }, sha256: agentPolicySha256({ ...base, route_default: "proven_only" }), updatedBy: k.hash });
    const r = await off.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: LLAMA, messages: [{ role: "user", content: "hi" }], max_tokens: 16 } });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-anyroute-default-route")).toBeNull();
    expect(r.headers.get("x-anyroute-lane")).toBe("public");
  } finally {
    await off.close();
  }
});
