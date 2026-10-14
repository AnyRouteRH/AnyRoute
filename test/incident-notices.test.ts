import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { keys, kv, statusIncidents } from "../src/db/schema.ts";
import { loadConfig } from "../src/config.ts";
import { incidentChanges, registerIncidentNoticesJob, runIncidentNotices } from "../src/incident-notices/worker.ts";
import { subscriptionKey } from "../src/incident-notices/preferences.ts";
import { consumeCode, removeLink } from "../src/telegram/linking.ts";
import { flushQuietNotifications } from "../src/notifications/telegram.ts";
const PREFS = "/api/v1/account/notifications", INCIDENTS = "/api/v1/status/incidents";
let h: Harness, telegramUid = 169000;
type Owner = Awaited<ReturnType<Harness["fundedKey"]>>;
const env = { AGENT_POLICY_ENABLED: "true", STATUS_INCIDENT_NOTICES_ENABLED: "true", NOTIFICATION_QUIET_HOURS_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_BOT_TOKEN: "123456789:AAFixtureTokenFixtureToken0123456789", ADMIN_TOKEN: "sample-incident-operator" };
const operator = { "x-admin-token": env.ADMIN_TOKEN };
beforeAll(async () => { h = await startRouter({ env }); });
afterAll(async () => { await h?.close(); });
async function settings(owner: Owner) { const res = await h.request(PREFS, { headers: owner.auth }); expect(res.status).toBe(200); return (await res.json()).data; }
async function save(owner: Owner, value: any) { const res = await h.request(PREFS, { method: "PUT", headers: owner.auth, json: { channels: value.channels, quiet_hours: value.quiet_hours } }); expect(res.status).toBe(200); }
async function optIn(owner: Owner, inbox = true, telegram = true) { const value = await settings(owner); value.channels.status_incidents = { inbox, telegram }; await save(owner, value); return value; }
async function account(owner: Owner) { const [row] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash)); return row!.accountId; }
async function inbox(owner: Owner) { const res = await h.request("/api/v1/inbox", { headers: owner.auth }); expect(res.status).toBe(200); return (await res.json()).data.filter((row: any) => row.kind === "status_incidents"); }
async function open(title = "Slow responses on some models") { const res = await h.request(INCIDENTS, { method: "POST", headers: operator, json: { title, lanes: ["public"], message: "We are checking slow responses." } }); expect(res.status).toBe(201); return (await res.json()).data.id; }
async function update(id: string, status: string, message = "A new public update.") { const res = await h.request(`${INCIDENTS}/${id}/updates`, { method: "POST", headers: operator, json: { status, message } }); expect(res.status).toBe(200); }
async function linked(owner: Owner) { const res = await h.request("/api/v1/telegram/link", { method: "POST", headers: owner.auth }); expect(res.status).toBe(200); return consumeCode(h.ctx, ++telegramUid, (await res.json()).data.code); }
function telegram() { const calls: any[] = []; return { calls, fetch: (async (_url: unknown, init: RequestInit) => { calls.push(JSON.parse(init.body as string)); return Response.json({ ok: true, result: { message_id: calls.length } }); }) as typeof fetch }; }
const tick = (fetchImpl?: typeof fetch) => runIncidentNotices(h.ctx, { telegramFetch: fetchImpl });
test("flag defaults off, API role does no work, job registration and worker name are guarded", async () => {
  expect(loadConfig({}).statusIncidentNoticesEnabled).toBe(false);
  expect(loadConfig({ RUNTIME_ROLE: "worker", WORKER_JOBS: "incident-notices" }).workerJobs).toEqual(["incident-notices"]);
  const off = { ...h.ctx, cfg: { ...h.ctx.cfg, statusIncidentNoticesEnabled: false }, db: null } as any;
  expect(await runIncidentNotices(off)).toEqual({ created: 0, skipped: "disabled" });
  const names: string[] = [], jobs = { register: (name: string) => names.push(name) };
  registerIncidentNoticesJob({ ...off, jobs }); expect(names).toEqual([]);
  const api = { ...off, cfg: { ...h.ctx.cfg, runtimeRole: "api" } };
  registerIncidentNoticesJob({ ...api, jobs }); expect(names).toEqual([]); expect((await runIncidentNotices(api)).created).toBe(0);
  registerIncidentNoticesJob({ ...h.ctx, jobs } as any); expect(names).toEqual(["incident-notices"]);
});
test("settings authenticate, default off, and remain opt-in while the source flag is off", async () => {
  for (const method of ["GET", "PUT"]) expect((await h.request(PREFS, { method, json: method === "PUT" ? {} : undefined })).status).toBe(401);
  const owner = await h.fundedKey(), value = await settings(owner);
  expect(value.channels.status_incidents).toEqual({ inbox: false, telegram: false });
  const res = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "sample-incident-reader", scope: "read" } });
  const readAuth = { authorization: `Bearer ${(await res.json()).key}` };
  for (const method of ["GET", "PUT"]) expect((await h.request(PREFS, { method, headers: readAuth, json: method === "PUT" ? { channels: value.channels, quiet_hours: null } : undefined })).status).toBe(403);
  await open(); const tg = telegram(); await tick(tg.fetch); expect(await inbox(owner)).toEqual([]); expect(tg.calls).toEqual([]);
  const enabled = h.ctx.cfg.statusIncidentNoticesEnabled; h.ctx.cfg.statusIncidentNoticesEnabled = false;
  try { await optIn(owner); expect((await settings(owner)).channels.status_incidents.inbox).toBe(true); expect(await inbox(owner)).toEqual([]); }
  finally { h.ctx.cfg.statusIncidentNoticesEnabled = enabled; }
  await optIn(owner, false, false);
});
test("open, new updates and resolve each produce one notice, including changes between ticks", async () => {
  const owner = await h.fundedKey(), other = await h.fundedKey(), tg = telegram();
  await optIn(owner); const link = await linked(owner);
  const id = await open(); await tick(tg.fetch);
  expect((await inbox(owner)).map((row: any) => row.title)).toEqual(["Investigating: Slow responses on some models"]);
  await update(id, "identified", "We have identified the cause."); await update(id, "monitoring", "Responses are recovering."); await update(id, "resolved", "Responses have recovered.");
  await tick(tg.fetch); expect(await inbox(owner)).toHaveLength(4); expect(tg.calls).toHaveLength(4);
  expect(new Set((await inbox(owner)).map((row: any) => row.id)).size).toBe(4);
  h.ctx.cfg.statusIncidentNoticesEnabled = false;
  try { expect(await inbox(owner)).toEqual([]); expect((await tick(tg.fetch)).created).toBe(0); }
  finally { h.ctx.cfg.statusIncidentNoticesEnabled = true; }
  expect(tg.calls.at(-1).text).toContain("Resolved: Slow responses on some models"); expect(tg.calls.at(-1).text).toContain("https://anyroute.tech/status/");
  expect(await inbox(other)).toEqual([]);
  for (const item of await inbox(owner)) expect(item.href).toBe("/status/");
  expect((await tick(tg.fetch)).created).toBe(0); expect(tg.calls).toHaveLength(4);
  const child = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "sample-incident-child" } });
  const childInbox = await h.request("/api/v1/inbox", { headers: { authorization: `Bearer ${(await child.json()).key}` } });
  expect((await childInbox.json()).data.some((row: any) => row.kind === "status_incidents")).toBe(false);
  await removeLink(h.ctx, link.uid); await optIn(owner, false, false);
});
test("replicas claim once, title patches send nothing, and failed Telegram attempts are not retried", async () => {
  const owner = await h.fundedKey(), tg = telegram(); await optIn(owner); const link = await linked(owner); const id = await open("A service interruption");
  await Promise.all([tick(tg.fetch), tick(tg.fetch)]); expect(tg.calls).toHaveLength(1); expect(await inbox(owner)).toHaveLength(1);
  expect((await h.request(`${INCIDENTS}/${id}`, { method: "PATCH", headers: operator, json: { title: "Service recovering" } })).status).toBe(200);
  await tick(tg.fetch); expect(tg.calls).toHaveLength(1);
  await update(id, "resolved"); let attempts = 0;
  await tick((async () => { attempts++; throw new Error("ambiguous outbound failure"); }) as typeof fetch);
  await tick(tg.fetch); expect(attempts).toBe(1); expect(tg.calls).toHaveLength(1); expect(await inbox(owner)).toHaveLength(2);
  await removeLink(h.ctx, link.uid); await optIn(owner, false, false);
});
test("quiet hours hold incidents, recheck feature and channel, and discard an unlinked recipient", async () => {
  const owner = await h.fundedKey(), tg = telegram(); const value = await optIn(owner), link = await linked(owner);
  const now = new Date(), clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  value.quiet_hours = { from_utc: clock(+now - 60_000), to_utc: clock(+now + 3_600_000) }; await save(owner, value);
  const id = await open("Slow responses"); await tick(tg.fetch); expect(tg.calls).toHaveLength(0); expect(await inbox(owner)).toHaveLength(1);
  const queue = await h.ctx.db.select().from(kv).where(like(kv.key, "notification-quiet:%")); expect(queue).toHaveLength(1); expect(JSON.stringify(queue)).not.toContain("We are checking slow responses.");
  const future = new Date(+now + 2 * 3_600_000);
  expect((await flushQuietNotifications({ ...h.ctx, cfg: { ...h.ctx.cfg, statusIncidentNoticesEnabled: false } }, tg.fetch, future)).sent).toBe(0);
  expect((await flushQuietNotifications(h.ctx, tg.fetch, future)).sent).toBe(1); expect(tg.calls[0].text).toContain("Investigating: Slow responses");
  await update(id, "identified"); await tick(tg.fetch); value.channels.status_incidents.telegram = false; await save(owner, value);
  expect((await flushQuietNotifications(h.ctx, tg.fetch, future)).sent).toBe(0);
  value.channels.status_incidents.telegram = true; await save(owner, value); await update(id, "resolved"); await tick(tg.fetch); await removeLink(h.ctx, link.uid);
  expect((await flushQuietNotifications(h.ctx, tg.fetch, future)).sent).toBe(0); expect(tg.calls).toHaveLength(1);
  value.channels.status_incidents.inbox = false; await save(owner, value); expect(await inbox(owner)).toEqual([]);
});
test("subscriptions exclude old updates, preserve start across saves, and channels act independently", async () => {
  const id = await open("Earlier service issue"), owner = await h.fundedKey(), tg = telegram();
  // Ensure the public update unambiguously predates opt-in on fast machines too.
  const [old] = await h.ctx.db.select().from(statusIncidents).where(eq(statusIncidents.id, id));
  const earlier = new Date(Date.now() - 60_000).toISOString();
  await h.ctx.db.update(statusIncidents).set({ updates: (old!.updates as any[]).map(item => ({ ...item, at: earlier })) }).where(eq(statusIncidents.id, id));
  const value = await optIn(owner, true, false); await tick(tg.fetch); expect(await inbox(owner)).toEqual([]);
  const key = subscriptionKey(await account(owner)); const [start] = await h.ctx.db.select().from(kv).where(eq(kv.key, key));
  await save(owner, value); const [same] = await h.ctx.db.select().from(kv).where(eq(kv.key, key)); expect(same!.value).toEqual(start!.value);
  await update(id, "identified"); await tick(tg.fetch); expect(await inbox(owner)).toHaveLength(1); expect(tg.calls).toHaveLength(0);
  const link = await linked(owner); await optIn(owner, false, true); await update(id, "resolved"); await tick(tg.fetch);
  expect(await inbox(owner)).toEqual([]); expect(tg.calls).toHaveLength(1);
  await removeLink(h.ctx, link.uid); await optIn(owner, false, false);
});
test("only public incident text participates; repeated timestamps remain separate changes", async () => {
  const [row] = await h.ctx.db.select().from(statusIncidents).limit(1);
  const at = new Date().toISOString(), updates = [{ at, status: "suggested", text: "Internal suggestion" }, { at, status: "investigating", text: "Public update" }, { at, status: "investigating", text: "Public update" }];
  const input = { ...row!, status: "investigating", evidence: { private: "Internal evidence" }, updates };
  const changes = incidentChanges(input); expect(changes).toHaveLength(2); expect(changes[0]!.change).not.toBe(changes[1]!.change); expect(JSON.stringify(changes)).not.toContain("Internal");
  for (const status of ["suggested", "dismissed"]) expect(incidentChanges({ ...input, status })).toEqual([]);
});
