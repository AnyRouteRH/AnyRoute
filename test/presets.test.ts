import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { presetVersions, savedRoutes } from "../src/db/schema.ts";
import { verifyInvariants } from "../src/ledger/ledger.ts";
import { LIMITS, applyPreset, diffJson, normalizePreset, parseVersionRef, presetDocSchema, presetHash, presetRefOf, type PresetDoc } from "../src/routing/presets.ts";

const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const QWEN = "qwen/qwen3-32b";
type Auth = Record<string, string>;
const doc = (d: Record<string, unknown>) => presetDocSchema.parse(d);
const tool = (name: string) => ({ type: "function", function: { name, description: "d", parameters: { type: "object", properties: {} } } });

describe("presets (pure)", () => {
  test("only `@preset/<name>` names a preset, with an optional version after a second @", () => {
    expect(presetRefOf("@preset/support")).toEqual({ name: "support", ref: null });
    expect(presetRefOf("@preset/support@3")).toEqual({ name: "support", ref: "3" });
    expect(presetRefOf("@preset/support@a1b2c3d4")).toEqual({ name: "support", ref: "a1b2c3d4" });
    for (const m of [LLAMA, "@route/support", "preset/support", "@Preset/x", undefined, 7]) expect(presetRefOf(m)).toBeNull();
    expect(parseVersionRef("3")).toEqual({ version: 3 });
    expect(parseVersionRef("v12")).toEqual({ version: 12 });
    expect(parseVersionRef(4)).toEqual({ version: 4 });
    expect(parseVersionRef("A1B2C3D")).toEqual({ hash: "a1b2c3d" });
    for (const bad of ["0", "abc", "latest", "1.5", "zzzzzzz", "-1"]) expect(parseVersionRef(bad)).toBeNull();
  });

  test("the hash is of the normalized canonical JSON: key order and default values do not change it", () => {
    const a = doc({ models: [LLAMA], params: { temperature: 0.2, top_p: 0.9 }, provider: { lane: "public", disclosure: "any", zdr: true }, system_prompt: "Be brief." });
    const b = doc({ system_prompt: "Be brief.", provider: { zdr: true }, params: { top_p: 0.9, temperature: 0.2 }, models: [LLAMA] });
    expect(presetHash(a)).toBe(presetHash(b));
    expect(presetHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(normalizePreset(a)).toEqual({ models: [LLAMA], params: { temperature: 0.2, top_p: 0.9 }, provider: { zdr: true }, system_prompt: "Be brief." });
    expect(presetHash(doc({ models: [LLAMA], system_prompt: "Be briefer." }))).not.toBe(presetHash(doc({ models: [LLAMA], system_prompt: "Be brief." })));
  });

  test("prompt fields are allowed here but capped; routing fields keep the saved route's rules", () => {
    expect(presetDocSchema.safeParse({ models: [LLAMA], system_prompt: "x".repeat(LIMITS.systemPromptChars) }).success).toBe(true);
    const tooMany = Array.from({ length: LIMITS.tools + 1 }, (_, i) => tool(`t${i}`));
    for (const bad of [
      { models: [LLAMA], system_prompt: "x".repeat(LIMITS.systemPromptChars + 1) },
      { models: [LLAMA], system_prompt: "" },
      { models: [LLAMA], tools: tooMany },
      { models: [LLAMA], tools: [tool("a"), tool("a")] },
      { models: [LLAMA], tools: [{ type: "function", function: { name: "bad name" } }] },
      { models: [LLAMA], tool_choice: "auto" },
      { models: [LLAMA], tools: [tool("a")], tool_choice: { type: "function", function: { name: "b" } } },
      { models: [LLAMA], response_format: { type: "xml" } },
      { models: [LLAMA], response_format: { type: "json_schema", json_schema: { name: "big", schema: { blob: "x".repeat(LIMITS.responseFormatBytes) } } } },
      { models: [LLAMA], tools: [{ ...tool("a"), function: { name: "a", parameters: { blob: "x".repeat(LIMITS.toolsBytes) } } }] },
      { models: [LLAMA], description: "d".repeat(281) },
      { models: ["@route/other"] },
      { models: ["@preset/other"] },
      { models: [LLAMA], params: { system: "sneaky" } },
      { models: [LLAMA], params: { messages: [] } },
      { models: [LLAMA], messages: [] },
      { models: [LLAMA], provider: { lane: "unlinkable" } },
    ])
      expect(presetDocSchema.safeParse(bad).success).toBe(false);
    // The whole document is capped too, even when each field is within its own cap.
    const system_prompt = "é".repeat(LIMITS.systemPromptChars); // two bytes each in UTF-8
    const tools = Array.from({ length: 4 }, (_, i) => ({ type: "function", function: { name: `t${i}`, parameters: { blob: "y".repeat(7_000) } } }));
    const response_format = { type: "json_schema", json_schema: { name: "r", schema: { blob: "z".repeat(15_000) } } };
    const whole = presetDocSchema.safeParse({ models: [LLAMA], system_prompt, tools, response_format, description: "d" });
    expect(whole.success).toBe(false);
    expect(JSON.stringify(whole.error?.issues)).toContain("64 KB");
  });

  test("system prompt rule: prepended only when the request has no system or developer message", () => {
    const p = doc({ models: [QWEN, LLAMA], system_prompt: "You are the support bot.", params: { temperature: 0.1 } });
    const plain: Record<string, unknown> = { model: "@preset/x", messages: [{ role: "user", content: "hi" }] };
    applyPreset(plain, p);
    expect(plain.messages).toEqual([{ role: "system", content: "You are the support bot." }, { role: "user", content: "hi" }]);
    expect(plain).toMatchObject({ model: QWEN, models: [QWEN, LLAMA], temperature: 0.1 });
    for (const role of ["system", "developer"]) {
      const own: Record<string, unknown> = { model: "@preset/x", messages: [{ role: "user", content: "hi" }, { role, content: "mine" }] };
      applyPreset(own, p);
      expect(own.messages).toEqual([{ role: "user", content: "hi" }, { role, content: "mine" }]);
    }
  });

  test("tools and response_format fill in only when the request sets none; copies, never shared", () => {
    const p = doc({ models: [LLAMA], tools: [tool("lookup")], tool_choice: "auto", response_format: { type: "json_object" } });
    const empty: Record<string, unknown> = { model: "@preset/x", messages: [] };
    applyPreset(empty, p);
    expect(empty).toMatchObject({ tools: [tool("lookup")], tool_choice: "auto", response_format: { type: "json_object" } });
    (empty.tools as unknown[]).push("MUTATED");
    expect(p.tools?.length).toBe(1);
    const own: Record<string, unknown> = { model: "@preset/x", messages: [], tools: [tool("mine")], response_format: { type: "text" } };
    applyPreset(own, p);
    expect(own.tools).toEqual([tool("mine")]);
    expect(own.tool_choice).toBeUndefined(); // the preset's choice names the preset's tools, so it comes only with them
    expect(own.response_format).toEqual({ type: "text" });
  });

  test("privacy: the stricter of preset and request wins, exactly as for a saved route", () => {
    const attested = doc({ models: [LLAMA], provider: { lane: "attested", sort: "price" } });
    const looser: Record<string, unknown> = { model: "@preset/x", provider: { lane: "public", sort: "latency" } };
    applyPreset(looser, attested);
    expect(looser.provider).toEqual({ lane: "attested", sort: "latency" }); // other fields: the request wins
    const policy = doc({ models: [LLAMA], provider: { disclosure: "policy" } });
    const tighter: Record<string, unknown> = { model: "@preset/x", provider: { disclosure: "none" } };
    applyPreset(tighter, policy);
    expect((tighter.provider as Record<string, unknown>).disclosure).toBe("none");
    const any: Record<string, unknown> = { model: "@preset/x", provider: { disclosure: "any" } };
    applyPreset(any, policy);
    expect((any.provider as Record<string, unknown>).disclosure).toBe("policy");
  });

  test("diff: JSON Pointer paths with the old and new value", () => {
    const a = normalizePreset(doc({ models: [QWEN, LLAMA], params: { temperature: 0.2 }, system_prompt: "v1" }));
    const b = normalizePreset(doc({ models: [QWEN], params: { temperature: 0.5, top_p: 0.9 }, system_prompt: "v2", description: "now with a/slash~" }));
    expect(diffJson(a, b)).toEqual([
      { op: "add", path: "/description", to: "now with a/slash~" },
      { op: "remove", path: "/models/1", from: LLAMA },
      { op: "replace", path: "/params/temperature", from: 0.2, to: 0.5 },
      { op: "add", path: "/params/top_p", to: 0.9 },
      { op: "replace", path: "/system_prompt", from: "v1", to: "v2" },
    ]);
    expect(diffJson(a, structuredClone(a))).toEqual([]);
    expect(diffJson({ "a/b": { "c~d": 1 } }, { "a/b": { "c~d": 2 } })).toEqual([{ op: "replace", path: "/a~1b/c~0d", from: 1, to: 2 }]);
  });
});

describe("Presets API and @preset/ resolution", () => {
  let h: Harness;
  let owner: Awaited<ReturnType<Harness["fundedKey"]>>;
  const api = (auth: Auth, path = "", method = "GET", json?: unknown) => h.request("/api/v1/presets" + path, { method, headers: auth, json });
  const put = (auth: Auth, name: string, json: unknown) => api(auth, "/" + name, "PUT", json);
  const chat = (auth: Auth, body: Record<string, unknown>) => h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { messages: [{ role: "user", content: "hello" }], ...body } });
  const upstream = async (id: "alpha" | "beta") => (await (await fetch(h.mocks[id].url + "/_stats")).json()).lastBody;
  const subKey = async (parent: Auth, json: Record<string, unknown> = {}) => {
    const r = await (await h.request("/api/v1/keys", { method: "POST", headers: parent, json: { name: "sub", ...json } })).json();
    return { hash: r.data.hash as string, auth: { authorization: `Bearer ${r.key}` } };
  };
  const V1 = { description: "Support bot", models: [QWEN, LLAMA], provider: { only: ["alpha"] }, params: { temperature: 0.2, max_tokens: 40 }, system_prompt: "You are the support bot. Answer in one line." };
  const V2 = { ...V1, params: { temperature: 0.7, max_tokens: 40, seed: 3 }, system_prompt: "You are the support bot v2." };
  let hashV1 = "";

  beforeAll(async () => {
    h = await startRouter();
    owner = await h.fundedKey(5n);
  });
  afterAll(async () => h.close());

  test("PUT creates version 1; the same document again adds nothing; a change adds version 2", async () => {
    const r = await put(owner.auth, "support", V1);
    expect(r.status).toBe(201);
    const { data } = await r.json();
    expect(data).toMatchObject({ name: "support", model: "@preset/support", description: "Support bot", version: 1, changed: true });
    expect(data.hash).toMatch(/^[0-9a-f]{64}$/);
    hashV1 = data.hash;
    expect(data.config).toEqual({ description: "Support bot", models: [QWEN, LLAMA], provider: { only: ["alpha"] }, params: { temperature: 0.2, max_tokens: 40 }, system_prompt: V1.system_prompt });

    const same = await put(owner.auth, "support", { ...V1, provider: { only: ["alpha"], lane: "public" } }); // a default is not a change
    expect(same.status).toBe(200);
    expect((await same.json()).data).toMatchObject({ version: 1, hash: hashV1, changed: false });

    const two = await put(owner.auth, "support", V2);
    expect(two.status).toBe(200);
    const d2 = (await two.json()).data;
    expect(d2).toMatchObject({ version: 2, changed: true });
    expect(d2.hash).not.toBe(hashV1);

    const list = (await (await api(owner.auth)).json()) as { data: { name: string; version: number; versions: number }[]; limit: number };
    expect(list.data).toEqual([expect.objectContaining({ name: "support", version: 2, versions: 2 })]);
    expect(list.limit).toBe(100);
    const got = (await (await api(owner.auth, "/support")).json()).data;
    expect(got).toMatchObject({ version: 2, latest_version: 2, config: { system_prompt: "You are the support bot v2." } });
    const pinned = (await (await api(owner.auth, "/support?version=1")).json()).data;
    expect(pinned).toMatchObject({ version: 1, hash: hashV1, latest_version: 2, config: { system_prompt: V1.system_prompt } });
  });

  test("versions are immutable: listed newest first, and version 1's row is exactly what was saved", async () => {
    const v = (await (await api(owner.auth, "/support/versions")).json()) as { data: { version: number; hash: string; source: string; model: string }[]; latest: number };
    expect(v.latest).toBe(2);
    expect(v.data.map((x) => [x.version, x.source, x.model])).toEqual([
      [2, "put", "@preset/support@2"],
      [1, "put", "@preset/support@1"],
    ]);
    const rows = await h.ctx.db.select().from(presetVersions).where(eq(presetVersions.name, "support")).orderBy(asc(presetVersions.version));
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[0]!.hash).toBe(hashV1);
    expect(presetHash(rows[0]!.config as PresetDoc)).toBe(hashV1); // the stored content still hashes to its id
    expect((rows[0]!.config as PresetDoc).system_prompt).toBe(V1.system_prompt);
    // There is no route that edits a version in place.
    for (const method of ["PATCH", "PUT", "DELETE"]) expect((await api(owner.auth, "/support/versions/1", method, {})).status).toBe(404);
  });

  test("diff: previous to latest by default, any two versions on request", async () => {
    const d = (await (await api(owner.auth, "/support/diff")).json()).data;
    expect(d).toMatchObject({ name: "support", from: { version: 1 }, to: { version: 2 }, identical: false });
    expect(d.changes).toEqual([
      { op: "replace", path: "/params/temperature", from: 0.2, to: 0.7 },
      { op: "add", path: "/params/seed", to: 3 },
      { op: "replace", path: "/system_prompt", from: V1.system_prompt, to: "You are the support bot v2." },
    ].sort((a, b) => a.path.localeCompare(b.path)));
    const back = (await (await api(owner.auth, `/support/diff?from=2&to=${hashV1.slice(0, 10)}`)).json()).data;
    expect(back.to.version).toBe(1);
    expect(back.changes.find((c: { path: string }) => c.path === "/params/temperature")).toEqual({ op: "replace", path: "/params/temperature", from: 0.7, to: 0.2 });
    expect((await (await api(owner.auth, "/support/diff?from=1&to=1")).json()).data).toMatchObject({ identical: true, changes: [] });
    expect((await api(owner.auth, "/support/diff?from=9")).status).toBe(404);
    expect((await api(owner.auth, "/support/diff?from=latest")).status).toBe(400);
  });

  test("@preset/ resolves the latest version: models, provider, params and the system prompt", async () => {
    const r = await chat(owner.auth, { model: "@preset/support" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ model: QWEN, provider: "Alpha", preset: { name: "support", version: 2 } });
    expect(j.preset.hash).toMatch(/^[0-9a-f]{64}$/);
    const sent = await upstream("alpha");
    expect(sent).toMatchObject({ temperature: 0.7, max_tokens: 40, seed: 3 });
    expect(sent.messages).toEqual([{ role: "system", content: "You are the support bot v2." }, { role: "user", content: "hello" }]);
    for (const f of ["provider", "models", "preset"]) expect(sent).not.toHaveProperty(f);
  });

  test("@preset/<name>@<version> pins a version, by number or by hash prefix", async () => {
    for (const ref of ["1", "v1", hashV1.slice(0, 7), hashV1]) {
      const r = await chat(owner.auth, { model: `@preset/support@${ref}` });
      expect(r.status).toBe(200);
      expect((await r.json()).preset).toEqual({ name: "support", version: 1, hash: hashV1 });
      const sent = await upstream("alpha");
      expect(sent.temperature).toBe(0.2);
      expect(sent.messages[0]).toEqual({ role: "system", content: V1.system_prompt });
    }
    const missing = await chat(owner.auth, { model: "@preset/support@9" });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.type).toBe("preset_version_not_found");
    expect((await chat(owner.auth, { model: "@preset/support@latest" })).status).toBe(400);
  });

  test("a request with its own system message keeps it, and request values still win", async () => {
    const r = await chat(owner.auth, { model: "@preset/support", temperature: 0.1, messages: [{ role: "system", content: "Mine." }, { role: "user", content: "hello" }] });
    expect(r.status).toBe(200);
    const sent = await upstream("alpha");
    expect(sent.messages).toEqual([{ role: "system", content: "Mine." }, { role: "user", content: "hello" }]);
    expect(sent.temperature).toBe(0.1);
  });

  test("rollback appends a version with the old content: same hash, new number, and calls follow it", async () => {
    const r = await api(owner.auth, "/support/rollback", "POST", { version: 1 });
    expect(r.status).toBe(200);
    const d = (await r.json()).data;
    expect(d).toMatchObject({ version: 3, hash: hashV1, changed: true, restored_from: 1, config: { system_prompt: V1.system_prompt } });
    const v = (await (await api(owner.auth, "/support/versions")).json()).data;
    expect(v[0]).toMatchObject({ version: 3, source: "rollback", restored_from: 1, hash: hashV1 });
    expect(v.length).toBe(3); // nothing was deleted or rewritten
    expect((await (await api(owner.auth, "/support/diff?from=1&to=3")).json()).data).toMatchObject({ identical: true, changes: [] });
    expect((await (await chat(owner.auth, { model: "@preset/support" })).json()).preset).toEqual({ name: "support", version: 3, hash: hashV1 });
    // Pinned version 2 still resolves to its own content.
    await chat(owner.auth, { model: "@preset/support@2" });
    expect((await upstream("alpha")).temperature).toBe(0.7);
    // Rolling back to what is already current adds nothing; unknown versions are a 404, junk a 400.
    expect((await (await api(owner.auth, "/support/rollback", "POST", { version: hashV1.slice(0, 8) })).json()).data).toMatchObject({ version: 3, changed: false });
    expect((await api(owner.auth, "/support/rollback", "POST", { version: 42 })).status).toBe(404);
    expect((await api(owner.auth, "/support/rollback", "POST", { version: "nope" })).status).toBe(400);
    expect((await api(owner.auth, "/nope/rollback", "POST", { version: 1 })).status).toBe(404);
  });

  test("validation: names, catalog models, size caps and the lane check all apply on PUT", async () => {
    expect((await put(owner.auth, "Bad_Name", V1)).status).toBe(404);
    const unknown = await put(owner.auth, "ghost", { models: ["x/unknown"] });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error.type).toBe("model_not_found");
    const long = await put(owner.auth, "long", { models: [LLAMA], system_prompt: "x".repeat(LIMITS.systemPromptChars + 1) });
    expect(long.status).toBe(400);
    expect(JSON.stringify(await long.json())).toContain("16000");
    expect((await put(owner.auth, "nested", { models: ["@preset/support"] })).status).toBe(400);
    // No provider here is attested, so a preset that pins the attested lane is refused like a saved route.
    const lane = await put(owner.auth, "private", { models: [LLAMA], provider: { lane: "attested" } });
    expect(lane.status).toBe(409);
    expect((await lane.json()).error.type).toBe("route_lane_unavailable");
    expect((await api(owner.auth, "/long")).status).toBe(404);
  });

  test("unknown, anonymous, cross-account and nested preset calls fail clearly", async () => {
    const unknown = await chat(owner.auth, { model: "@preset/nope" });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.type).toBe("preset_not_found");
    const anonymous = await chat({}, { model: "@preset/support" });
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error.type).toBe("missing_key");
    const other = await h.fundedKey(1n);
    expect((await chat(other.auth, { model: "@preset/support" })).status).toBe(404);
    expect((await api(other.auth, "/support")).status).toBe(404);
    expect((await (await api(other.auth)).json()).data).toEqual([]);
    const nested = await chat(owner.auth, { model: LLAMA, models: ["@preset/support"] });
    expect(nested.status).toBe(400);
    expect((await nested.json()).error.message).toContain("@preset/");
  });

  test("key allowlist: `@preset/<name>` allows that preset's models, the same way `@route/<slug>` does", async () => {
    const onlyPreset = await subKey(owner.auth, { allowed_models: ["@preset/support"] });
    const ok = await chat(onlyPreset.auth, { model: "@preset/support" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).model).toBe(QWEN);
    const direct = await chat(onlyPreset.auth, { model: QWEN });
    expect(direct.status).toBe(403);
    expect((await direct.json()).error.type).toBe("model_not_allowed");
    // A route of the same name is a different thing.
    await h.request("/api/v1/routes", { method: "POST", headers: owner.auth, json: { slug: "support", config: { models: [LLAMA] } } });
    expect((await chat(onlyPreset.auth, { model: "@route/support" })).status).toBe(403);
    // Agent sessions accept presets of their own account in allowed_models, and refuse unknown ones.
    const s = await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 0.5, allowed_models: ["@preset/support"] } });
    expect(s.status).toBe(201);
    const sessionKey = { authorization: `Bearer ${(await s.json()).data.key}` };
    expect((await chat(sessionKey, { model: "@preset/support" })).status).toBe(200);
    const bad = await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 0.5, allowed_models: ["@preset/nope"] } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toContain("No preset");
  });

  test("roles: members read, owners and admins write", async () => {
    const member = await subKey(owner.auth);
    expect((await api(member.auth)).status).toBe(200);
    expect((await api(member.auth, "/support/versions")).status).toBe(200);
    for (const [path, method, json] of [["/support", "PUT", V1], ["/support", "DELETE", undefined], ["/support/rollback", "POST", { version: 1 }]] as const) {
      const r = await api(member.auth, path, method, json);
      expect(r.status).toBe(403);
      expect((await r.json()).error.type).toBe("forbidden");
    }
    expect((await api({})).status).toBe(401);
  });

  test("completions: a preset with prompt fields is refused there; a routing-only preset works", async () => {
    const refused = await h.request("/api/v1/completions", { method: "POST", headers: owner.auth, json: { model: "@preset/support", prompt: "Once upon" } });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.type).toBe("preset_unsupported");
    expect((await put(owner.auth, "plain", { models: [QWEN], params: { max_tokens: 12 } })).status).toBe(201);
    const c = await h.request("/api/v1/completions", { method: "POST", headers: owner.auth, json: { model: "@preset/plain", prompt: "Once upon" } });
    expect(c.status).toBe(200);
    expect(await c.json()).toMatchObject({ object: "text_completion", model: QWEN, preset: { name: "plain", version: 1 } });
  });

  test("delete removes every version; calls and pins stop resolving; saved_routes never holds preset text", async () => {
    const routes = await h.ctx.db.select().from(savedRoutes);
    expect(JSON.stringify(routes)).not.toContain("support bot");
    const del = await api(owner.auth, "/support", "DELETE");
    expect(await del.json()).toEqual({ data: { name: "support", model: "@preset/support", deleted: true, versions: 3 } });
    expect((await api(owner.auth, "/support", "DELETE")).status).toBe(404);
    expect((await chat(owner.auth, { model: "@preset/support" })).status).toBe(404);
    expect((await chat(owner.auth, { model: "@preset/support@1" })).status).toBe(404);
    const left = await h.ctx.db.select().from(presetVersions).where(and(eq(presetVersions.name, "support")));
    expect(left).toEqual([]);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });
});
