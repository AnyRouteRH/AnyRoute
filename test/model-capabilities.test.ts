import { expect, test } from "bun:test";
import { Hono } from "hono";
import { capabilityJson } from "../src/api/model-capabilities.ts";
import { modelsRoutes } from "../src/api/models.ts";
import { loadConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { Candidate, ModelRow } from "../src/catalog/catalog.ts";
import { configureNetworkRouting, refreshNetworkRouting } from "../src/network/routing.ts";
import type { Db } from "../src/db/client.ts";
import { PHALA_PROVIDER } from "../src/e2ee/config.ts";

const model = { id: "sample/model", name: "Sample model", hidden: false, ctx: 128000, createdUnix: 1, arch: { input_modalities: ["text", "image"], output_modalities: ["text", "image"] } } as ModelRow;
function fixture() {
  const offer = { modelId: model.id, providerId: PHALA_PROVIDER, providerModelId: model.id, status: "live", pricePrompt: 1n, priceCompletion: 2n, priceRequest: 0n, priceImage: 0n, priceWebSearch: 0n, priceReasoning: 0n, supportedParameters: ["tools", "max_tokens", "stream"], provider: {
    id: PHALA_PROVIDER, name: "Confidential gateway", status: "live", teeKind: "tdx", attested: true, attestedAt: new Date(), attestationHash: "fresh-evidence", attestationUrl: "https://gateway.example/attestation", baseUrl: "https://gateway.example/v1", apiKeyEnc: "fixture-encrypted-value", networkHost: true, networkModels: [model.id], networkReasons: [], aci: { notAfter: Date.now() / 1000 + 3600 },
  } } as unknown as Candidate;
  const cfg = loadConfig({});
  cfg.e2ee.enabled = true;
  const ctx = { cfg, health: { outage: () => false, uptime30d: () => 1, quality: () => 1, stats: () => null }, catalog: {
    providers: new Map([[PHALA_PROVIDER, offer.provider]]), models: new Map([[model.id, model]]), offers: () => [offer], ensureFresh: async () => {},
    disclosure: new Map([[PHALA_PROVIDER, { retention: "attested", legalHold: false, updatedAt: new Date() }]]), manifests: new Map(), lane: new Map(),
    laneOf: () => ({ variant: "mainstream", servable: true, source: "default" }),
  } } as unknown as Ctx;
  return { ctx, offer };
}

test("both public model endpoints retain fields and add the same capability and provider arrays", async () => {
  const { ctx } = fixture();
  const app = new Hono(); modelsRoutes(app, ctx);
  const get = async (path: string) => {
    const response = await app.request(path); expect(response.status).toBe(200); return (await response.json()).data[0];
  };
  const first = await get("/api/v1/models");
  expect(await get("/v1/models")).toEqual(first);
  expect(first).toMatchObject({ id: model.id, context_length: 128000, architecture: model.arch, pricing: { prompt: "0.000000000001", completion: "0.000000000002" }, supported_parameters: ["max_tokens", "stream", "tools"], provider_names: ["Confidential gateway"] });
  expect(first.capabilities).toEqual(["vision", "imageOut", "tools", "longContext", "attested", "network", "encrypted"]);
});

test("network membership requires a fresh real-hardware offer for an admitted model without admission reasons", () => {
  const { ctx, offer } = fixture();
  for (const change of [{ networkHost: false }, { networkModels: ["another/model"] }, { networkReasons: ["admission refused"] }, { teeKind: "dev" }, { attestedAt: new Date(0) }]) {
    const candidate = { ...offer, provider: { ...offer.provider, ...change } } as Candidate;
    expect(capabilityJson(ctx, model, [candidate]).capabilities).not.toContain("network");
  }
});

test("encrypted chat never follows a general attestation and is hidden when disabled, stale, renamed or unconfigured", () => {
  const { ctx, offer } = fixture();
  expect(capabilityJson(ctx, model, [offer]).capabilities).toContain("encrypted");
  ctx.cfg.e2ee.enabled = false;
  expect(capabilityJson(ctx, model, [offer]).capabilities).not.toContain("encrypted");
  ctx.cfg.e2ee.enabled = true;
  expect(capabilityJson(ctx, model, [{ ...offer, providerModelId: "another/model" }]).capabilities).not.toContain("encrypted");
  offer.provider.aci!.notAfter = 1;
  expect(capabilityJson(ctx, model, [offer]).capabilities).not.toContain("encrypted");
  delete offer.provider.aci;
  expect(capabilityJson(ctx, model, [offer]).capabilities).not.toContain("encrypted");
  ctx.catalog.providers.clear();
  expect(capabilityJson(ctx, model, [offer]).capabilities).not.toContain("encrypted");
});

test("production encrypted metadata requires pinning and the router's selectable attested lane", () => {
  const { ctx, offer } = fixture(); ctx.cfg.production = true;
  expect(capabilityJson(ctx, model, [offer]).capabilities).not.toContain("encrypted");
  offer.provider.tlsPin = {} as never;
  expect(capabilityJson(ctx, model, [offer]).capabilities).toContain("encrypted");
  ctx.health.outage = () => true;
  expect(capabilityJson(ctx, model, [offer]).capabilities).not.toContain("encrypted");
  ctx.health.outage = () => false; ctx.catalog.disclosure.clear();
  expect(capabilityJson(ctx, model, [offer]).capabilities).not.toContain("encrypted");
});

test("the production config loader starts with catalogue metadata and existing encrypted path enabled", () => {
  const address = "0x" + "1".repeat(40);
  const cfg = loadConfig({ NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64), E2EE_PASSTHROUGH_ENABLED: "true", E2EE_GATEWAY_BASE_URL: "https://gateway.example/v1", E2EE_GATEWAY_ATTESTATION_URL: "https://gateway.example/attestation" });
  expect(cfg.production).toBe(true); expect(cfg.e2ee.enabled).toBe(true);
});


test("eligible probation hosts appear in the same catalogue and missing network evidence excludes them", async () => {
  const { ctx, offer } = fixture();
  ctx.cfg.e2ee.enabled = false;
  offer.provider.status = "probation"; offer.status = "shadow";
  offer.provider.createdAt = new Date(); offer.provider.probationUntil = new Date(Date.now() + 86400000);
  configureNetworkRouting(ctx.health, { ...ctx.cfg.networkWeights, enabled: true });
  const app = new Hono(); modelsRoutes(app, ctx);
  const list = async () => (await (await app.request("/api/v1/models")).json()).data;
  expect(await list()).toEqual([]);
  let query = 0;
  const db = { select: () => ({ from: async () => [offer.provider] }), execute: async () => [
    [{ successes: 0 }],
    [{ recent_successes: 0, recent_failures: 0, probe_successes: 1, probe_failures: 0, probe_latency: 100 }],
    [{ ok: true, tee_kind: "tdx" }],
  ][query++] } as unknown as Db;
  await refreshNetworkRouting(ctx.health, db);
  const data = await list();
  expect(data).toHaveLength(1); expect(data[0].id).toBe(model.id); expect(data[0].capabilities).toContain("network");
  offer.provider.attestedAt = new Date(0);
  expect(await list()).toEqual([]);
});
