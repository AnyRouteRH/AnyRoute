import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keys, kv } from "../src/db/schema.ts";
import { browserLabel, browserSessionKey } from "../src/browser-sessions/labels.ts";
import { startRouter, type Harness } from "./helpers.ts";
import { signOutBrowsers } from "../web/lib/browser-sessions.js";

let h: Harness;
const wallet = privateKeyToAccount(generatePrivateKey());
const path = "/api/v1/account/browser-sessions";
const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36";
async function signIn(account = wallet, header = ua) {
  const response = await h.request("/api/v1/auth/wallet/challenge", { method: "POST", json: { address: account.address } });
  const { data } = await response.json();
  const result = await h.request("/api/v1/auth/wallet", { method: "POST", headers: { "user-agent": header }, json: {
    address: account.address, nonce: data.nonce, signature: await account.signMessage({ message: data.message }), name: "Browser sign-in",
  } });
  expect(result.status).toBe(201);
  const body = await result.json();
  return { hash: body.data.hash, auth: { authorization: `Bearer ${body.key}` }, data: body.data };
}
const list = async (auth: Record<string, string>, query = "") => {
  const response = await h.request(path + query, { headers: auth });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.json();
};
beforeAll(async () => { h = await startRouter(); });
afterAll(async () => { await h?.close(); });

test("labels contain only coarse fixed families, including mobile and unknown headers", () => {
  expect(browserLabel(ua)).toBe("Chrome on macOS");
  expect(browserLabel(ua + " Edg/140.0")).toBe("Edge on macOS");
  expect(browserLabel("Mozilla/5.0 (iPhone) AppleWebKit Safari/605.1")).toBe("Safari on iOS");
  expect(browserLabel("Mozilla/5.0 (Android) Firefox/140.0")).toBe("Firefox on Android");
  expect(browserLabel("Mozilla/5.0 (Windows) OPR/12.0")).toBe("Opera on Windows");
  expect(browserLabel("Mozilla/5.0 (CrOS) Chrome/140.0")).toBe("Chrome on ChromeOS");
  expect(browserLabel("Mozilla/5.0 (Linux) Firefox/140.0")).toBe("Firefox on Linux");
  expect(browserLabel("arbitrary sensitive text")).toBe("Browser");
  expect(browserLabel()).toBe("Browser");
});

test("default listing is account-scoped, active-only, paginated and preserves existing sign-in responses", async () => {
  const current = await signIn();
  const older = await signIn();
  await h.ctx.db.delete(kv).where(eq(kv.key, browserSessionKey(older.hash)));
  const foreign = await signIn(privateKeyToAccount(generatePrivateKey()));
  const expired = await signIn();
  const disabled = await signIn();
  await h.ctx.db.update(keys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(keys.keyHash, expired.hash));
  await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, disabled.hash));
  const sub = await h.request("/api/v1/keys", { method: "POST", headers: current.auth, json: { management: true } });
  expect(sub.status).toBe(201);
  const subHash = (await sub.json()).data.hash;
  const rows = (await list(current.auth)).data;
  expect(rows.map((row: any) => row.hash).sort()).toEqual([current.hash, older.hash].sort());
  expect(rows.some((row: any) => [foreign.hash, expired.hash, disabled.hash, subHash].includes(row.hash))).toBe(false);
  expect(rows.find((row: any) => row.hash === current.hash)).toEqual({ hash: current.hash, browser_label: "Chrome on macOS", created_at: current.data.created_at, last_used: null, current: true });
  expect(rows.find((row: any) => row.hash === older.hash).browser_label).toBe("Browser details unavailable");
  const [saved] = await h.ctx.db.select().from(kv).where(eq(kv.key, browserSessionKey(current.hash)));
  expect(saved.value).toEqual({ label: "Chrome on macOS" });
  expect(current.data.browser_label).toBeUndefined();
  const first = await list(current.auth, "?offset=0&limit=1");
  const next = await list(current.auth, "?offset=1&limit=1");
  expect(first.has_more).toBe(true); expect(next.has_more).toBe(false);
  expect(first.data[0].hash).not.toBe(next.data[0].hash);
  expect((await h.request(path + "?limit=0", { headers: current.auth })).status).toBe(400);
  expect((await h.request(path + "?offset=invalid", { headers: current.auth })).status).toBe(400);
});

test("missing, ordinary, team admin, inference and agent-session auth cannot list browsers", async () => {
  expect((await h.request(path)).status).toBe(401);
  const owner = await h.fundedKey();
  expect((await list(owner.auth)).data).toEqual([]);
  const child = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: {} });
  const childBody = await child.json();
  const auth = { authorization: `Bearer ${childBody.key}` };
  expect((await h.request(path, { headers: auth })).status).toBe(403);
  const teamResult = await h.request("/api/v1/teams", { method: "POST", headers: owner.auth, json: { name: "Browser team" } });
  const team = (await teamResult.json()).data.id;
  const admin = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { team, role: "admin" } });
  expect((await h.request(path, { headers: { authorization: `Bearer ${(await admin.json()).key}` } })).status).toBe(403);
  // Cover inference keys without constructing a row prohibited by the schema.
  await h.ctx.db.update(keys).set({ scope: "inference" }).where(eq(keys.keyHash, childBody.data.hash));
  expect((await h.request(path, { headers: auth })).status).toBe(403);
  const session = await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { name: "Browser checks", budget_usd: 1, ttl_minutes: 30 } });
  expect(session.status).toBe(201);
  const sessionAuth = { authorization: `Bearer ${(await session.json()).data.key}` };
  expect((await h.request(path, { headers: sessionAuth })).status).toBe(403);
});

test("sign out one through the existing disable path; foreign accounts stay protected", async () => {
  const current = await signIn(), other = await signIn();
  const foreign = await signIn(privateKeyToAccount(generatePrivateKey()));
  expect((await h.request(`/api/v1/keys/${other.hash}`, { method: "DELETE" })).status).toBe(401);
  expect((await h.request(`/api/v1/keys/${foreign.hash}`, { method: "DELETE", headers: current.auth })).status).toBe(404);
  expect((await h.request(`/api/v1/keys/${other.hash}`, { method: "DELETE", headers: current.auth })).status).toBe(200);
  expect((await h.request("/api/v1/key", { headers: other.auth })).status).toBe(401);
  expect((await list(current.auth)).data.some((row: any) => row.hash === other.hash)).toBe(false);
  expect((await h.request(`/api/v1/keys/${current.hash}`, { method: "PATCH", headers: current.auth, json: { disabled: true } })).status).toBe(200);
  expect((await h.request(path, { headers: current.auth })).status).toBe(401);
  expect((await h.request(path, { headers: foreign.auth })).status).toBe(200);
});

test("all others uses existing routes and preserves current, foreign and provisioned keys", async () => {
  const current = await signIn(), other = await signIn();
  const foreign = await signIn(privateKeyToAccount(generatePrivateKey()));
  const child = await h.request("/api/v1/keys", { method: "POST", headers: current.auth, json: { management: true } });
  const childAuth = { authorization: `Bearer ${(await child.json()).key}` };
  const request = async (url: string, options: { method?: string; body?: unknown } = {}) => {
    const response = await h.request(url, { method: options.method, headers: current.auth, ...(options.body ? { json: options.body } : {}) });
    expect(response.status).toBe(200);
    return response.json();
  };
  const result = await signOutBrowsers(request, { allOthers: true, confirmed: true });
  expect(result.failed).toEqual([]); expect(result.disabled).toContain(other.hash); expect(result.disabled).not.toContain(current.hash);
  expect((await list(current.auth)).data.map((row: any) => row.hash)).toEqual([current.hash]);
  expect((await h.request(path, { headers: other.auth })).status).toBe(401);
  expect((await h.request(path, { headers: foreign.auth })).status).toBe(200);
  expect((await h.request(path, { headers: childAuth })).status).toBe(200);
});
