// B116: human links use the site address; signed and protocol URLs keep the router address.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { privacyLabel } from "../src/privacy/label.ts";
import { atomFeed, rssFeed } from "../src/services/slo.ts";
import { TelegramBot, type RouterCall, type TgUpdate } from "../src/services/telegram.ts";
import { agentIdentities } from "../src/identity/schema.ts";
import { newIdentityId } from "../src/identity/identity.ts";
import { startRouter, MODELS, type Harness } from "./helpers.ts";

const router = "https://router.example";
const site = "https://anyroute.tech";
const env = { PUBLIC_BASE_URL: router, AGENT_PROFILES_ENABLED: "true", AGENT_IDENTITY_ENABLED: "true" };
const profile = { name: "Sample agent", description: "Reads documents", capabilities: [], show: [] };
const token = "123456789:AAFixtureTokenFixtureToken0123456789";
let h: Harness;
let fallback: Harness;
beforeAll(async () => {
  h = await startRouter({ env: { ...env, SITE_URL: site } });
  fallback = await startRouter({ env });
});
afterAll(async () => { await h?.close(); await fallback?.close(); });

const rpc = (app: Harness, name: string, args: unknown) => app.request("/mcp", {
  method: "POST", json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
});
const message = (text: string): TgUpdate => ({ update_id: 1, message: { message_id: 1, from: { id: 116 }, chat: { id: 116, type: "private" }, text } });
function telegram(app: Harness, routerCall?: RouterCall) {
  const sent: string[] = [];
  const fetchImpl = (async (_input: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (typeof body.text === "string") sent.push(body.text);
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;
  return { sent, bot: new TelegramBot(app.ctx, { token, fetch: fetchImpl, router: routerCall ?? ((path, init) => app.app.request(path, init)) }) };
}

test("SITE_URL is opt-in and leaves protocol configuration unchanged", () => {
  const original = loadConfig({ ANYROUTE_ENV: "test", PUBLIC_BASE_URL: router + "/" });
  const explicit = loadConfig({ ANYROUTE_ENV: "test", PUBLIC_BASE_URL: router + "/", SITE_URL: router + "/" });
  expect(original).toEqual(explicit);
  const configured = loadConfig({ ANYROUTE_ENV: "test", PUBLIC_BASE_URL: router, SITE_URL: site + "/" });
  expect(configured.siteUrl).toBe(site);
  expect(configured.publicUrl).toBe(router);
  expect(configured.webauthn).toEqual(original.webauthn);
  expect(configured.tlog.origin).toBe(original.tlog.origin);
});

for (const configured of [true, false]) test(`receipt read links and signed payloads (${configured ? "SITE_URL" : "unset"})`, async () => {
  const app = configured ? h : fallback;
  const owner = await app.fundedKey();
  const path = "/api/v1/chat/completions";
  const json = { model: MODELS.llama.slug, messages: [{ role: "user", content: "Hello" }], max_tokens: 20 };
  expect((await app.request(path, { method: "POST", headers: { authorization: "Bearer invalid-key" }, json })).status).toBe(401);
  const call = await app.request(path, { method: "POST", headers: owner.auth, json });
  expect(call.status).toBe(200);
  const id = call.headers.get("x-receipt-id")!;
  await call.text();
  const receiptPath = `/api/v1/receipts/${id}`;
  const response = await app.request(receiptPath); // Public by receipt id, as before.
  expect(response.status).toBe(200);
  const bytes = await response.text();
  const { data } = JSON.parse(bytes);
  expect(data.privacy.verify_url).toBe(`${configured ? site : router}/verify?r=${id}`);
  expect(data.privacy.verify_url).toStartWith(`${configured ? site : router}/verify`);
  expect(data.payload.router).toBe(router);
  expect(data.v2.claims.iss).toBe(router);
  expect(await app.ctx.signer.verify(data.payload, data.sig, data.key_id)).toBe(true);
  const signed = JSON.stringify({ payload: data.payload, sig: data.sig, v2: data.v2 });
  expect((await (await app.request(`${receiptPath}/privacy`)).json()).data).toEqual(data.privacy);
  expect((await (await rpc(app, "get_receipt", { id })).json()).result.structuredContent.privacy.verify_url).toBe(data.privacy.verify_url);
  const savedSite = app.ctx.cfg.siteUrl;
  try {
    app.ctx.cfg.siteUrl = router;
    const legacyBytes = await (await app.request(receiptPath)).text();
    const legacy = JSON.parse(legacyBytes);
    expect(legacy.data.privacy).toEqual(privacyLabel(data, { baseUrl: router }));
    expect(JSON.stringify({ payload: legacy.data.payload, sig: legacy.data.sig, v2: legacy.data.v2 })).toBe(signed);
    if (!configured) expect(bytes).toBe(legacyBytes);
  } finally { app.ctx.cfg.siteUrl = savedSite; }
  expect((await app.request("/api/v1/receipts/unknown")).status).toBe(404);
});

test("MCP provider verification opens the site without requiring authentication", async () => {
  const result = (await (await rpc(h, "verify_provider", { provider_id: "alpha" })).json()).result.structuredContent;
  expect(result.verify_page).toBe(`${site}/verify?p=alpha`);
  const original = await (await rpc(fallback, "verify_provider", { provider_id: "alpha" })).text();
  fallback.ctx.cfg.siteUrl = router;
  expect(await (await rpc(fallback, "verify_provider", { provider_id: "alpha" })).text()).toBe(original);
});

test("profile publication, directory, card and registration use site links; API services keep router URLs", async () => {
  for (const app of [h, fallback]) {
    const owner = await app.fundedKey();
    const path = `/api/v1/agents/${owner.hash}/profile`;
    expect((await app.request(path, { method: "PUT", json: profile })).status).toBe(401);
    const published = await app.request(path, { method: "PUT", headers: owner.auth, json: profile });
    expect(published.status).toBe(200);
    const { data } = await published.json();
    expect(data.url).toBe(`${app.ctx.cfg.siteUrl}/agents/profile/?id=${data.id}`);
    const cardPath = `/api/v1/agents/profiles/${data.id}`;
    const bytes = await (await app.request(cardPath)).text();
    expect(JSON.parse(bytes).url).toBe(data.url);
    expect((await (await app.request("/api/v1/agents/profiles")).json()).data.some(card => card.url === data.url)).toBe(true);
    const identity = newIdentityId();
    await app.ctx.db.insert(agentIdentities).values({ keyHash: owner.hash, id: identity });
    const registrationPath = `/api/v1/agents/identity/${identity}/registration.json`;
    const registrationBytes = await (await app.request(registrationPath)).text();
    const registration = JSON.parse(registrationBytes);
    expect(registration.services.find(s => s.name === "web").endpoint).toBe(data.url);
    for (const service of registration.services.filter(s => s.name !== "web")) expect(service.endpoint).toStartWith(router);
    if (app === fallback) {
      const originalCard = await (await app.request(cardPath)).text();
      app.ctx.cfg.siteUrl = router;
      expect(await (await app.request(cardPath)).text()).toBe(originalCard);
      expect(await (await app.request(registrationPath)).text()).toBe(registrationBytes);
    }
  }
  h.ctx.cfg.agentProfilesEnabled = false;
  try { expect((await h.request("/api/v1/agents/profiles")).status).toBe(404); }
  finally { h.ctx.cfg.agentProfilesEnabled = true; }
});

test("Telegram welcome, private-mode guidance and receipt links use the site", async () => {
  const { bot, sent } = telegram(h);
  await bot.handleUpdate(message("/start"));
  expect(sent.at(-1)).toContain(`${site}/dashboard`);
  const owner = await h.fundedKey();
  await bot.handleUpdate(message(`/key ${owner.secret}`));
  await bot.handleUpdate(message("/private on"));
  expect(sent.at(-1)).toContain(`${site}/verify`);
  await bot.handleUpdate(message("/private off"));
  await bot.handleUpdate(message("Hello"));
  expect(sent.at(-1)).toContain(`receipt ${site}/api/v1/receipts/`);
  expect(sent.at(-1)).not.toContain(router);
  const original = telegram(fallback);
  await original.bot.handleUpdate(message("/help"));
  const explicit = telegram(fallback);
  fallback.ctx.cfg.siteUrl = router;
  await explicit.bot.handleUpdate(message("/help"));
  expect(explicit.sent).toEqual(original.sent);
});


test("Telegram attested footers and withheld-answer receipt links use the site", async () => {
  let response: () => Response = () => Response.json({ model: MODELS.llama.slug, choices: [{ message: { content: "Answer" } }], receipt: { id: "receipt sample", payload: { provider: "alpha", lane: "attested", disclosure: "attested" } } });
  const { bot, sent } = telegram(h, (path, init) => path === "/api/v1/chat/completions" ? Promise.resolve(response()) : h.app.request(path, init));
  const owner = await h.fundedKey();
  await bot.handleUpdate(message(`/key ${owner.secret}`));
  await bot.handleUpdate(message("/private on"));
  await bot.handleUpdate(message("Hello"));
  expect(sent.at(-1)).toContain(`${site}/verify?p=alpha`);
  expect(sent.at(-1)).toContain(`${site}/api/v1/receipts/receipt%20sample`);
  response = () => Response.json({ receipt: { id: "receipt sample", payload: { lane: "public" } } });
  await bot.handleUpdate(message("Hello"));
  expect(sent.at(-1)).toContain(`Receipt: ${site}/api/v1/receipts/receipt%20sample`);
  response = () => Response.json({ id: "receipt sample", error: { type: "upstream_not_attested" } }, { status: 502 });
  await bot.handleUpdate(message("Hello"));
  expect(sent.at(-1)).toContain(`Receipt: ${site}/api/v1/receipts/receipt%20sample`);
});

test("status feeds separate human links from API identifiers and self links, with identical defaults", async () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const incident = { id: "inc_sample", title: "Service update", status: "investigating", impact: "minor", lanes: ["public"], surfaces: [], started_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), resolved_at: null, updates: [] } as Parameters<typeof atomFeed>[1][number];
  for (const feed of [atomFeed, rssFeed]) {
    expect(feed(router, [incident], now, fallback.ctx.cfg.siteUrl)).toBe(feed(router, [incident], now));
    const bytes = feed(router, [incident], now, site);
    expect(bytes).toContain(`${site}/status/#incident-inc_sample`);
    expect(bytes).toContain(`${router}/api/v1/status/incidents.`);
    expect(bytes).not.toContain(`${router}/status/`);
  }
  for (const format of ["atom", "rss"]) {
    const response = await h.request(`/api/v1/status/incidents.${format}`);
    expect(response.status).toBe(200);
    const bytes = await response.text();
    expect(bytes).toContain(`${site}/status/`);
    expect(bytes).toContain(`${router}/api/v1/status/incidents.${format}`);
  }
});


test("unset SITE_URL preserves status-feed normalization with extra trailing slashes", async () => {
  const original = { publicUrl: fallback.ctx.cfg.publicUrl, siteUrl: fallback.ctx.cfg.siteUrl };
  const config = loadConfig({ ANYROUTE_ENV: "test", PUBLIC_BASE_URL: router + "//" });
  fallback.ctx.cfg.publicUrl = config.publicUrl;
  fallback.ctx.cfg.siteUrl = config.siteUrl;
  try {
    for (const format of ["atom", "rss"]) {
      const bytes = await (await fallback.request(`/api/v1/status/incidents.${format}`)).text();
      expect(bytes).toContain(`${router}/status/`);
      expect(bytes).toContain(`${router}/api/v1/status/incidents.${format}`);
      expect(bytes).not.toContain(`${router}//status/`);
    }
  } finally { Object.assign(fallback.ctx.cfg, original); }
});
