import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { payouts, providers, settlements } from "../src/db/schema.ts";
import { sanctionsAddresses, sanctionsMeta } from "../src/network/schema.ts";
import { assertNotSanctioned, isSanctioned, normalizeEvmAddress, parseSdnXml, refreshSanctions, sanctionsStatus } from "../src/network/sanctions.ts";
import { DEFAULT_SANCTIONS_LIST_URL } from "../src/network/config.ts";
import { sha256 } from "../src/lib/util.ts";
import { registerJobs } from "../src/services/register.ts";
import { Jobs } from "../src/services/jobs.ts";
import { runPayouts } from "../src/services/settlement.ts";
import { startRouter, type Harness } from "./helpers.ts";

const fixture = readFileSync(new URL("./fixtures/sanctions/sdn.xml", import.meta.url), "utf8");
const blocked = "0x" + "a".repeat(40), otherBlocked = "0x" + "b".repeat(40), clean = "0x" + "c".repeat(40);
const today = new Date().toISOString().slice(0, 10).split("-");
const statusNow = new Date();
const currentFixture = fixture.replace("09/30/2026", `${today[1]}/${today[2]}/${today[0]}`);
const fetchXml = (xml = currentFixture) => (async () => new Response(xml)) as typeof fetch;

test("classic SDN XML: currency IDs only, EVM shape across tickers, deduplication, ignored formats", () => {
  const parsed = parseSdnXml(fixture);
  expect(parsed.addresses).toEqual([blocked, otherBlocked]);
  expect(parsed.listDate.toISOString()).toBe("2026-09-30T00:00:00.000Z");
  expect(parsed.ignoredCount).toBe(4);
  expect(parsed.digitalCount).toBe(7);
  expect(normalizeEvmAddress(" 0X" + "A".repeat(40) + " ")).toBe(blocked);
  expect(normalizeEvmAddress("0x123")).toBeNull();
});
test("rejects truncated feeds, invalid date/count/root and DTDs instead of clearing the list", () => {
  for (const xml of [fixture.slice(0, -20), fixture.replace("09/30/2026", "02/30/2026"), fixture.replace("<Record_Count>2", "<Record_Count>3"), fixture.replaceAll("sdnList", "Error"), '<!DOCTYPE sdnList [<!ENTITY x SYSTEM "file:///fixture">]>' + fixture, fixture.replace("<idNumber>0xAa", "<idNumber><nested/>0xAa"), fixture + fixture]) expect(() => parseSdnXml(xml)).toThrow();
});
test("supports namespace prefixes and character references in currency IDs", () => {
  const xml = fixture.replace(/<(\/?)([A-Za-z_][A-Za-z_0-9]*)(?=[\s>])/g, '<$1n:$2').replace("- ETH", "- &#69;TH");
  expect(parseSdnXml(xml).addresses).toEqual([blocked, otherBlocked]);
});

describe("screening integration", () => {
  let h: Harness;
  let transfers: string[] = [];
  beforeAll(async () => {
    h = await startRouter({ providers: [], env: { SANCTIONS_SCREENING_ENABLED: "true" } });
    h.ctx.chain.transferUsdg = async (_role, to) => { transfers.push(to); return { hash: "0x" + "1".repeat(64) as `0x${string}` }; };
  });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    h.ctx.cfg.sanctions.enabled = true;
    transfers = [];
    for (const table of [settlements, payouts, providers, sanctionsAddresses, sanctionsMeta]) await h.ctx.db.delete(table);
  });
  async function due(addr = blocked) {
    await h.ctx.db.insert(providers).values({ id: "sanctions-provider", name: "Sanctions provider", baseUrl: "https://provider.example", payoutMode: "usdg", payoutAddress: addr });
    await h.ctx.db.insert(settlements).values({ providerId: "sanctions-provider", period: "2020-01-01T00", tokens: 10n, upstream: 10n, fee: 0n, usdgOwed: 5n });
  }
  async function priorPayment(addr = clean, status = "paid", tx: string | null = "0x" + "2".repeat(64)) {
    await h.ctx.db.insert(payouts).values({ id: "earlier", providerId: "old-provider", usdg: 5n, to: addr, status, tx });
  }
  async function stale() {
    await refreshSanctions(h.ctx, fetchXml());
    await h.ctx.db.update(sanctionsMeta).set({ listDate: new Date(Date.now() - 8 * 86_400_000) });
  }
  test("refresh replaces list and metadata together; lookup and public metadata reflect exact bytes", async () => {
    await refreshSanctions(h.ctx, fetchXml());
    expect(await isSanctioned(h.ctx, blocked.toUpperCase())).toBe(true);
    expect(await isSanctioned(h.ctx, clean)).toBe(false);
    const r = await h.request("/api/v1/network/sanctions");
    expect(r.status).toBe(200);
    const data = (await r.json()).data;
    expect(data.entry_count).toBe(2);
    expect(data.ignored_count).toBe(4);
    expect(data.source_hash).toBe(sha256(currentFixture));
    expect(data.stale).toBe(false);
    expect(JSON.stringify(data)).not.toContain(blocked);
    const changed = currentFixture.replaceAll(/0xAa[Aa]+|0xaaaa[a]+/g, clean);
    await refreshSanctions(h.ctx, fetchXml(changed));
    expect(await isSanctioned(h.ctx, blocked)).toBe(false);
    expect(await isSanctioned(h.ctx, clean)).toBe(true);
    const rows = await h.ctx.db.select().from(sanctionsAddresses);
    expect(rows.every((r) => r.sourceHash === sha256(changed))).toBe(true);
  });
  test("fetch, HTTP and malformed feed failures retain last good metadata and addresses", async () => {
    await refreshSanctions(h.ctx, fetchXml());
    const before = await sanctionsStatus(h.ctx, statusNow);
    for (const fetcher of [fetchXml("<html>unavailable</html>"), (async () => new Response("failure", { status: 500 })) as typeof fetch, (async () => { throw new Error("network failure"); }) as typeof fetch]) {
      await expect(refreshSanctions(h.ctx, fetcher)).rejects.toThrow("last good list retained");
      expect(await sanctionsStatus(h.ctx, statusNow)).toEqual(before);
      expect(await isSanctioned(h.ctx, blocked)).toBe(true);
    }
  });
  test("OFAC redirect chain to a signed allowlisted URL refreshes the list", async () => {
    const locations = ["https://www.treasury.gov/ofac/downloads/sdn.xml", "https://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/SDN.XML?signature=fixture"];
    let calls = 0;
    const fetcher = (async (_input, init) => {
      expect(init!.redirect).toBe("manual");
      const location = locations[calls++];
      return location ? new Response(null, { status: 302, headers: { location } }) : new Response(currentFixture);
    }) as typeof fetch;
    const result = await refreshSanctions(h.ctx, fetcher);
    expect(result).toMatchObject({ entry_count: 2, source_hash: sha256(currentFixture) });
    expect(await isSanctioned(h.ctx, blocked)).toBe(true);
    expect(calls).toBe(3);
  });
  test("off-list, HTTP, credential, missing-location and excessive redirects keep the last good list", async () => {
    await refreshSanctions(h.ctx, fetchXml());
    const before = await sanctionsStatus(h.ctx, statusNow);
    for (const location of ["https://example.com/sdn.xml", "http://treasury.gov/sdn.xml", "http://localhost/sdn.xml", "https://user:password@treasury.gov/sdn.xml", "https://user@treasury.gov/sdn.xml", "https://treasury.gov/sdn.xml#fragment", null, "/redirect-loop"]) {
      let calls = 0;
      const fetcher = (async () => { calls++; return new Response(null, { status: 302, headers: location ? { location } : {} }); }) as typeof fetch;
      await expect(refreshSanctions(h.ctx, fetcher)).rejects.toThrow("last good list retained");
      expect(calls).toBe(location === "/redirect-loop" ? 4 : 1);
      expect(await sanctionsStatus(h.ctx, statusNow)).toEqual(before);
      expect(await isSanctioned(h.ctx, blocked)).toBe(true);
      expect(await isSanctioned(h.ctx, otherBlocked)).toBe(true);
    }
  });
  test("declared and streamed download size limits retain the last good list after redirects", async () => {
    await refreshSanctions(h.ctx, fetchXml());
    const before = await sanctionsStatus(h.ctx, statusNow);
    for (const oversized of [() => new Response(currentFixture, { headers: { "content-length": String(64 * 1024 * 1024 + 1) } }), () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(64 * 1024 * 1024 + 1)); controller.close(); } }))]) {
      let calls = 0;
      const fetcher = (async () => ++calls === 1 ? new Response(null, { status: 302, headers: { location: "https://treasury.gov/sdn.xml" } }) : oversized()) as typeof fetch;
      await expect(refreshSanctions(h.ctx, fetcher)).rejects.toThrow("last good list retained");
      expect(await sanctionsStatus(h.ctx, statusNow)).toEqual(before);
      expect(await isSanctioned(h.ctx, blocked)).toBe(true);
    }
  });
  test("a database failure after deletion rolls back both the entries and metadata", async () => {
    await refreshSanctions(h.ctx, fetchXml());
    const before = await sanctionsStatus(h.ctx, statusNow);
    await h.ctx.db.execute(sql`ALTER TABLE sanctions_addresses ADD CONSTRAINT fixture_reject CHECK (address <> '0xcccccccccccccccccccccccccccccccccccccccc')`);
    try {
      await expect(refreshSanctions(h.ctx, fetchXml(currentFixture.replaceAll("0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", clean)))).rejects.toThrow();
      expect(await sanctionsStatus(h.ctx, statusNow)).toEqual(before);
      expect(await isSanctioned(h.ctx, blocked)).toBe(true);
      expect(await isSanctioned(h.ctx, otherBlocked)).toBe(true);
    } finally { await h.ctx.db.execute(sql`ALTER TABLE sanctions_addresses DROP CONSTRAINT fixture_reject`); }
  });
  test("publication dates cannot regress or be in the future", async () => {
    await refreshSanctions(h.ctx, fetchXml());
    const before = await sanctionsStatus(h.ctx, statusNow);
    await expect(refreshSanctions(h.ctx, fetchXml(fixture.replace("09/30/2026", "01/01/2020")))).rejects.toThrow();
    await expect(refreshSanctions(h.ctx, fetchXml(fixture.replace("09/30/2026", "01/01/2099")))).rejects.toThrow();
    expect(await sanctionsStatus(h.ctx, statusNow)).toEqual(before);
  });
  test("sanctioned payout is skipped before creating payout or claiming settlement, even if previously paid", async () => {
    await stale(); await due(blocked); await priorPayment(blocked);
    const r = await runPayouts(h.ctx);
    expect(r.payouts).toEqual([{ provider: "sanctions-provider", status: "skipped", reason: "sanctioned_address", list_date: (await sanctionsStatus(h.ctx, statusNow)).list_date }]);
    expect(transfers).toEqual([]);
    expect((await h.ctx.db.select().from(settlements))[0].payoutId).toBeNull();
    expect(await h.ctx.db.select().from(payouts).where(eq(payouts.providerId, "sanctions-provider"))).toEqual([]);
  });
  test("fresh nonmatching address is paid normally", async () => {
    await refreshSanctions(h.ctx, fetchXml()); await due(clean);
    await runPayouts(h.ctx);
    expect(transfers).toEqual([clean]);
    expect((await h.ctx.db.select().from(payouts))[0].status).toBe("paid");
  });
  test("missing and stale lists pause NEW payout addresses without consuming earnings", async () => {
    await due(clean);
    expect((await runPayouts(h.ctx)).payouts[0]).toMatchObject({ reason: "sanctions_list_missing_new_address" });
    await stale();
    expect((await runPayouts(h.ctx)).payouts[0]).toMatchObject({ reason: "sanctions_list_stale_new_address" });
    expect((await h.ctx.db.select().from(settlements))[0].payoutId).toBeNull();
    expect(transfers).toEqual([]);
    await refreshSanctions(h.ctx, fetchXml());
    await runPayouts(h.ctx);
    expect(transfers).toEqual([clean]);
  });
  test("paid address may continue on a stale or missing list; another address's payment is no exemption", async () => {
    await due(clean); await priorPayment(blocked);
    expect((await runPayouts(h.ctx)).payouts[0]).toMatchObject({ reason: "sanctions_list_missing_new_address" });
    await h.ctx.db.delete(payouts); await priorPayment(clean.toUpperCase());
    await stale(); await runPayouts(h.ctx);
    expect(transfers).toEqual([clean]);
    await h.ctx.db.delete(settlements); await h.ctx.db.delete(providers); await h.ctx.db.delete(sanctionsMeta); await h.ctx.db.delete(sanctionsAddresses);
    await due(clean); await runPayouts(h.ctx);
    expect(transfers).toEqual([clean, clean]);
  });
  test("pending/invoice payouts and paid rows without a transaction do not exempt a new address", async () => {
    await due(clean);
    for (const [status, tx] of [["pending", "0x1"], ["invoice", "0x1"], ["paid", null]]) {
      await h.ctx.db.delete(payouts); await priorPayment(clean, status!, tx);
      expect((await runPayouts(h.ctx)).payouts[0]).toMatchObject({ reason: "sanctions_list_missing_new_address" });
    }
    expect(transfers).toEqual([]);
  });
  test("admission helper and provider application block matches and require current list", async () => {
    await expect(assertNotSanctioned(h.ctx, clean)).rejects.toMatchObject({ status: 503 });
    await refreshSanctions(h.ctx, fetchXml());
    await expect(assertNotSanctioned(h.ctx, blocked)).rejects.toMatchObject({ status: 403 });
    await assertNotSanctioned(h.ctx, clean);
    const application = { id: "application-provider", name: "Applicant", base_url: "https://provider.example", payout_address: blocked, data_policy: { training: false, retains_prompts: false } };
    const rejected = await h.request("/api/v1/providers/apply", { method: "POST", json: application });
    expect(rejected.status).toBe(403);
    expect((await rejected.json()).error.type).toBe("sanctioned_address");
    expect(await h.ctx.db.select().from(providers)).toEqual([]);
    await stale(); await priorPayment(clean);
    await expect(assertNotSanctioned(h.ctx, clean)).rejects.toMatchObject({ status: 503 });
  });
  test("flag off changes neither payouts nor provider applications and performs no fetch", async () => {
    h.ctx.cfg.sanctions.enabled = false;
    await assertNotSanctioned(h.ctx, blocked);
    expect(await refreshSanctions(h.ctx, (async () => { throw new Error("must not fetch"); }) as typeof fetch)).toEqual({ skipped: "screening_disabled" });
    await due(blocked); await runPayouts(h.ctx);
    expect(transfers).toEqual([blocked]);
    const r = await h.request("/api/v1/providers/apply", { method: "POST", json: { id: "off-provider", name: "Off", base_url: "https://provider.example", payout_address: blocked, data_policy: { training: false, retains_prompts: false } } });
    expect(r.status).toBe(201);
  });
  test("DB screening errors pause payouts and admission", async () => {
    await due(clean);
    await h.ctx.db.execute(sql`ALTER TABLE sanctions_meta RENAME TO fixture_unavailable_sanctions_meta`);
    try {
      expect((await runPayouts(h.ctx)).payouts[0]).toMatchObject({ reason: "sanctions_unavailable" });
      await expect(assertNotSanctioned(h.ctx, clean)).rejects.toMatchObject({ status: 503, type: "sanctions_unavailable" });
      expect(transfers).toEqual([]);
    } finally { await h.ctx.db.execute(sql`ALTER TABLE fixture_unavailable_sanctions_meta RENAME TO sanctions_meta`); }
  });
  test("daily worker registers only with flag and explicit worker allow-list", () => {
    const jobs = new Jobs(undefined, undefined, ["sanctions-refresh"]);
    registerJobs({ ...h.ctx, jobs });
    expect(jobs.status()).toMatchObject([{ name: "sanctions-refresh", every_ms: 86_400_000 }]);
    const offJobs = new Jobs(undefined, undefined, ["sanctions-refresh"]);
    h.ctx.cfg.sanctions.enabled = false;
    registerJobs({ ...h.ctx, jobs: offJobs });
    expect(offJobs.status()).toEqual([]);
  });
});

test("real production config loader starts enabled for API and isolated worker with the OFAC default", () => {
  const address = "0x" + "1".repeat(40);
  const base = { NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64), SANCTIONS_SCREENING_ENABLED: "true", SANCTIONS_LIST_URL: DEFAULT_SANCTIONS_LIST_URL };
  expect(loadConfig(base).sanctions).toEqual({ enabled: true, listUrl: DEFAULT_SANCTIONS_LIST_URL, maxAgeDays: 7 });
  expect(loadConfig({ ...base, SANCTIONS_LIST_URL: undefined }).sanctions.listUrl).toBe(DEFAULT_SANCTIONS_LIST_URL);
  expect(loadConfig({ ...base, RUNTIME_ROLE: "worker", WORKER_JOBS: "sanctions-refresh", ROUTER_PRIVATE_KEY: "" }).workerJobs).toEqual(["sanctions-refresh"]);
  for (const change of [{ SANCTIONS_LIST_URL: "https://list.example/sdn.xml" }, { SANCTIONS_LIST_URL: "http://list.example/sdn.xml" }, { SANCTIONS_MAX_AGE_DAYS: "0" }, { SANCTIONS_MAX_AGE_DAYS: "NaN" }]) expect(() => loadConfig({ ...base, ...change })).toThrow();
  expect(loadConfig({ ...base, SANCTIONS_SCREENING_ENABLED: "false", SANCTIONS_LIST_URL: "" }).sanctions.enabled).toBe(false);
  expect(loadConfig({ ANYROUTE_ENV: "test" }).sanctions).toEqual({ enabled: false, listUrl: DEFAULT_SANCTIONS_LIST_URL, maxAgeDays: 7 });
});
