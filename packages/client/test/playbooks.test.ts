import { expect, test } from "bun:test";
import { AnyRoute, AnyRouteError, type AgentPolicy, type Playbook } from "../src/index.js";
import { json, stubFetch } from "./helpers.js";
const policy: AgentPolicy = { version: 1, models: { allow: ["author/*"] }, caps: { per_day_usd: 2 }, on_breach: "deny" };
const book: Playbook = { id: "pb_1", name: "Support bots", team_id: null, policy, sha256: "digest", version: 2, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z", updated_by: "key", followers: 1, keys: [{ key_hash: "k1", name: "bot" }], can_edit: true };
const auth = (init?: RequestInit) => new Headers(init?.headers).get("authorization");
const sent = (init?: RequestInit) => JSON.parse(init?.body as string);

test("playbook methods call the playbook routes with the key and return REST data unchanged", async () => {
  const f = stubFetch({
    "/api/v1/playbooks": ({ init }) => { expect(auth(init)).toBe("Bearer key"); return json({ data: [book] }); },
    "POST /api/v1/playbooks": ({ init }) => { expect(sent(init)).toEqual({ name: "Support bots", policy, team_id: "team_1" }); return json({ data: book }, 201); },
    "/api/v1/playbooks/pb_1": () => json({ data: { ...book, changes: [{ action: "update", version: 2, sha256: "digest", name: "Support bots", followers: 1, at: "2026-01-02T00:00:00.000Z" }] } }),
    "PUT /api/v1/playbooks/pb_1": ({ init }) => { expect(sent(init)).toEqual({ policy }); return json({ data: { ...book, changed: true } }); },
    "DELETE /api/v1/playbooks/pb_1?unlink=copy": () => json({ data: { id: "pb_1", deleted: true, unlinked: 1 } }),
    "POST /api/v1/agents/k1/playbook": ({ init }) => json({ data: { key_hash: "k1", changed: true, playbook: sent(init).playbook_id ? { id: "pb_1", name: "Support bots", version: 2 } : null, policy, sha256: "digest", killed: false, playbook_id: sent(init).playbook_id } }),
  });
  const c = new AnyRoute({ baseUrl: "https://router.test", apiKey: "key", fetch: f.fetch });
  expect(await c.playbooks.list()).toEqual([book]);
  expect(await c.playbooks.create({ name: "Support bots", policy, team_id: "team_1" })).toEqual(book);
  expect((await c.playbooks.get("pb_1")).changes[0]!.version).toBe(2);
  expect((await c.playbooks.update("pb_1", { policy })).changed).toBe(true);
  expect(await c.playbooks.delete("pb_1", { unlink: "copy" })).toEqual({ id: "pb_1", deleted: true, unlinked: 1 });
  expect((await c.playbooks.follow("k1", "pb_1")).playbook).toEqual({ id: "pb_1", name: "Support bots", version: 2 });
  expect((await c.playbooks.follow("k1", null)).playbook_id).toBeNull();
  expect(f.calls).toHaveLength(7);
});

test("a refused playbook change keeps the router's code, status and metadata", async () => {
  const c = new AnyRoute({ baseUrl: "https://router.test", apiKey: "key", fetch: stubFetch({ "DELETE /api/v1/playbooks/pb_1": () => json({ error: { type: "playbook_followed", message: "2 keys follow this playbook.", metadata: { followers: 2 } } }, 409) }).fetch });
  const e = await c.playbooks.delete("pb_1").catch(e => e);
  expect(e).toBeInstanceOf(AnyRouteError);
  expect([e.status, e.code, e.message, e.details]).toEqual([409, "playbook_followed", "2 keys follow this playbook.", { followers: 2 }]);
});
