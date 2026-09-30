import { beforeAll, beforeEach, afterAll, expect, test } from "bun:test";
import { sql, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { startRouter, ADMIN } from "./helpers.ts";
import { networkWaitlist } from "../src/network/schema.ts";
import { MemoryRateLimiter } from "../src/lib/ratelimit.ts";
import { TABLE_DOCS, checkDatabaseColumns } from "../src/privacy/inventory.ts";

const BASE = "/api/v1/network/waitlist";
const sample = { role: "host_gpu", hardware: "2x H100 · TDX", readiness: "TDX guest=yes · GPU CC=on", region: "europe", contact: "@private-fixture", paid_in: "usdg", website: "" };
let h: Awaited<ReturnType<typeof startRouter>>;
let limiter: MemoryRateLimiter;
beforeAll(async () => { h = await startRouter({ providers: [], env: { TRUST_PROXY: "true", ONION_PROXY_SECRET: "fixture-onion-".repeat(4), ONION_POOL_MULTIPLIER: "2" } }); });
beforeEach(async () => { await limiter?.close(); limiter = new MemoryRateLimiter(); h.ctx.limiter = limiter; await h.ctx.db.delete(networkWaitlist); });
afterAll(async () => { await limiter?.close(); await h?.close(); });
const post = (json: unknown, headers?: Record<string, string>) => h.request(BASE, { method: "POST", json, headers });

test("strict enums, lengths, unknown fields and malformed bodies fail without storage", async () => {
  const invalid = [{ ...sample, role: "host" }, { ...sample, region: "city" }, { ...sample, paid_in: "usd" }, { ...sample, hardware: "x".repeat(201) }, { ...sample, readiness: "x".repeat(301) }, { ...sample, contact: "x".repeat(121) }, { ...sample, ip: "fixture-address" }, { ...sample, readiness: null }];
  for (const value of invalid) expect((await post(value)).status).toBe(400);
  expect((await h.request(BASE, { method: "POST", body: "{" })).status).toBe(400);
  expect((await post(sample, { "x-forwarded-for": "192.0.2.2" })).status).toBe(200);
  expect((await h.ctx.db.select().from(networkWaitlist)).length).toBe(1);
});
test("bounded body rejects a chunked oversized request", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ ...sample, hardware: "x".repeat(5000) }));
  const body = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  expect((await h.request(BASE, { method: "POST", body })).status).toBe(413);
  expect(await h.ctx.db.select().from(networkWaitlist)).toEqual([]);
});
test("filled honeypot returns ordinary success but saves nothing", async () => {
  const r = await post({ ...sample, website: "filled" });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ id: expect.any(String), delete_code: expect.any(String) });
  expect((await post({ website: "filled", role: "invalid" })).status).toBe(200);
  expect(await h.ctx.db.select().from(networkWaitlist)).toEqual([]);
});
test("code is random, only SHA-256 is stored; omitted optional values work", async () => {
  const { contact: _contact, readiness: _readiness, website: _website, ...minimal } = sample;
  const a = await (await post(minimal)).json();
  const b = await (await post(minimal)).json();
  expect(a.id).not.toBe(b.id); expect(a.delete_code).not.toBe(b.delete_code);
  const [row] = await h.ctx.db.select().from(networkWaitlist).where(eq(networkWaitlist.id, a.id));
  expect(row!.contact).toBeNull(); expect(row!.readiness).toBe("");
  expect(row!.deleteCodeHash).toBe(createHash("sha256").update(a.delete_code).digest("hex"));
  expect(JSON.stringify(row)).not.toContain(a.delete_code);
});
test("deletion requires the matching code and never changes another entry", async () => {
  const a = await (await post(sample)).json(); const b = await (await post(sample)).json();
  const remove = (id: string, code: string) => h.request(`${BASE}/${id}`, { method: "DELETE", json: { delete_code: code } });
  expect((await remove(a.id, b.delete_code)).status).toBe(404);
  expect((await remove(a.id, "short")).status).toBe(400);
  expect((await remove(a.id, a.delete_code)).status).toBe(200);
  expect((await remove(a.id, a.delete_code)).status).toBe(404);
  expect((await h.ctx.db.select().from(networkWaitlist)).map((r) => r.id)).toEqual([b.id]);
});
test("public stats include counts only, even when readiness says no TDX", async () => {
  await post(sample);
  await post({ ...sample, role: "developer", region: "asia", readiness: "SEV-SNP=no; GPU-CC unknown; private-readiness-marker", hardware: "private-hardware-marker", contact: "private-contact-marker" });
  const response = await h.request(`${BASE}/stats`);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const data = await response.json();
  expect(data.total).toBe(2); expect(data.readiness_mentions).toBe(2);
  expect(data.by_role.host_gpu).toBe(1); expect(data.by_role.developer).toBe(1); expect(data.by_region.asia).toBe(1);
  expect(Object.keys(data).sort()).toEqual(["by_region", "by_role", "readiness_mentions", "total"]);
  const text = JSON.stringify(data); for (const field of ["contact", "hardware", "private-", "delete_code", "created_at", sample.contact]) expect(text).not.toContain(field);
});
test("rate limit uses keyed digests, isolates addresses, and never stores IP or user agent", async () => {
  const calls: string[] = []; const underlying = h.ctx.limiter;
  h.ctx.limiter = { take: async (key, ...args) => { calls.push(key); return underlying.take(key, ...args); }, close: () => underlying.close() };
  const headers = { "x-forwarded-for": "192.0.2.47", "user-agent": "private-agent-marker" };
  for (let i = 0; i < 10; i++) expect((await post(sample, headers)).status).toBe(200);
  const limited = await post(sample, headers); expect(limited.status).toBe(429); expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await post(sample, { "x-forwarded-for": "192.0.2.48" })).status).toBe(200);
  expect(calls[0]).toMatch(/^network-waitlist:[0-9a-f]{64}$/);
  expect(calls[0]).not.toBe(calls.at(-1)!);
  const rows = JSON.stringify(await h.ctx.db.select().from(networkWaitlist));
  for (const marker of ["192.0.2.47", "private-agent-marker"]) { expect(calls.join()).not.toContain(marker); expect(rows).not.toContain(marker); }
});
test("onion uses one shared scaled bucket regardless of supplied address headers", async () => {
  const keys: string[] = []; const underlying = h.ctx.limiter;
  h.ctx.limiter = { take: async (key, ...args) => { keys.push(key); return underlying.take(key, ...args); }, close: () => underlying.close() };
  for (let i = 0; i < 20; i++) expect((await post(sample, { "x-anyroute-onion": "fixture-onion-".repeat(4), "x-forwarded-for": `192.0.2.${i}` })).status).toBe(200);
  expect((await post(sample, { "x-anyroute-onion": "fixture-onion-".repeat(4) })).status).toBe(429);
  expect(new Set(keys)).toEqual(new Set(["network-waitlist:onion"]));
});
test("owner export is authenticated, read-only and paginated", async () => {
  await post(sample); await post(sample);
  const route = "/trpc/networkWaitlistExport?input=" + encodeURIComponent(JSON.stringify({ limit: 1 }));
  expect((await h.request(route)).status).toBe(401);
  const first = await (await h.request(route, { headers: { authorization: `Bearer ${ADMIN}` } })).json();
  expect(first.result.data.length).toBe(1); expect(first.result.data[0].contact).toBe(sample.contact);
  const next = "/trpc/networkWaitlistExport?input=" + encodeURIComponent(JSON.stringify({ limit: 1, after: first.result.data[0].id }));
  const second = await (await h.request(next, { headers: { "x-admin-token": ADMIN } })).json();
  expect(second.result.data[0].id).not.toBe(first.result.data[0].id);
  expect((await h.ctx.db.select().from(networkWaitlist)).length).toBe(2);
});
test("migration has exactly nine documented columns and enforces field bounds", async () => {
  const result = await h.ctx.db.execute(sql`select table_name, column_name, data_type, udt_name from information_schema.columns where table_name = 'network_waitlist'`);
  const rows = ((result as { rows?: unknown[] }).rows ?? result) as Parameters<typeof checkDatabaseColumns>[0];
  expect(rows.length).toBe(9);
  expect(checkDatabaseColumns(rows, { network_waitlist: TABLE_DOCS.network_waitlist! })).toEqual([]);
  await expect(h.ctx.db.insert(networkWaitlist).values({ id: randomUUID(), role: "invalid", hardware: "", readiness: "", region: "europe", paidIn: "usdg", deleteCodeHash: "a".repeat(64) }).execute()).rejects.toThrow();
});
