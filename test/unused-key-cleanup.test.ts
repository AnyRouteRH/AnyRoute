import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { keys } from "../src/db/schema.ts";
import { startRouter, MODELS, type Harness } from "./helpers.ts";

// B125: exercise the existing routes used by cleanup, with default flags unchanged.
let h: Harness;
let owner: Awaited<ReturnType<Harness["fundedKey"]>>;
const child = async (fields = {}) => {
  const response = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: fields });
  expect(response.status).toBe(201);
  const body = await response.json();
  return { hash: body.data.hash, auth: { authorization: `Bearer ${body.key}` } };
};
beforeAll(async () => { h = await startRouter(); owner = await h.fundedKey(20n); });
afterAll(async () => { await h?.close(); });

test("key lists expose existing timestamps by default without marking browsing as use", async () => {
  const key = await child();
  const list = await h.request("/api/v1/keys", { headers: owner.auth });
  const row = (await list.json()).data.find((value: any) => value.hash === key.hash);
  expect(row.last_used).toBeNull();
  expect(Number.isFinite(Date.parse(row.created_at))).toBe(true);
  expect(row.disabled).toBe(false);
});

test("charged inference updates last_used for the next review", async () => {
  const key = await child();
  const before = Date.now();
  const response = await h.request("/api/v1/chat/completions", { method: "POST", headers: key.auth,
    json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "hello" }], max_tokens: 8 } });
  expect(response.status).toBe(200);
  await response.text();
  const read = await h.request(`/api/v1/keys/${key.hash}`, { headers: owner.auth });
  const data = (await read.json()).data;
  expect(data.usage).toBeGreaterThan(0);
  expect(Date.parse(data.last_used)).toBeGreaterThanOrEqual(before);
});

test("disable requires auth, preserves history, and cannot disable this browser's key", async () => {
  const key = await child({ management: true });
  const path = `/api/v1/keys/${key.hash}`;
  expect((await h.request("/api/v1/keys")).status).toBe(401);
  expect((await h.request(path, { method: "DELETE" })).status).toBe(401);
  expect((await h.request(`/api/v1/keys/${owner.hash}`, { method: "DELETE", headers: owner.auth })).status).toBe(400);
  const other = await h.fundedKey();
  expect((await h.request(path, { method: "DELETE", headers: other.auth })).status).toBe(404);
  expect((await h.request(path, { method: "DELETE", headers: owner.auth })).status).toBe(200);
  const read = await h.request(path, { headers: owner.auth });
  expect((await read.json()).data.disabled).toBe(true);
  expect((await h.request("/api/v1/key", { headers: key.auth })).status).toBe(401);
});

test("viewer cannot disable keys; team admin stays within existing team scope and audit", async () => {
  const teamResponse = await h.request("/api/v1/teams", { method: "POST", headers: owner.auth, json: { name: "Cleanup team" } });
  expect(teamResponse.status).toBe(201);
  const team = (await teamResponse.json()).data.id;
  const viewer = await child({ team, role: "viewer" });
  const admin = await child({ team, role: "admin" });
  const target = await child({ team });
  const outside = await child();
  expect((await h.request("/api/v1/keys", { headers: viewer.auth })).status).toBe(200);
  expect((await h.request(`/api/v1/keys/${target.hash}`, { method: "DELETE", headers: viewer.auth })).status).toBe(403);
  const visible = (await (await h.request("/api/v1/keys", { headers: admin.auth })).json()).data;
  expect(visible.some((row: any) => row.hash === outside.hash)).toBe(false);
  expect((await h.request(`/api/v1/keys/${outside.hash}`, { method: "DELETE", headers: admin.auth })).status).toBe(403);
  expect((await h.request(`/api/v1/keys/${target.hash}`, { method: "DELETE", headers: admin.auth })).status).toBe(200);
  const audit = (await (await h.request(`/api/v1/teams/${team}/audit`, { headers: owner.auth })).json()).data;
  expect(audit.some((entry: any) => entry.action === "key.disable" && entry.target === target.hash)).toBe(true);
  const [row] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, target.hash));
  expect(row.disabled).toBe(true);
});
