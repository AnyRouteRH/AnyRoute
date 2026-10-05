import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import { accounts, generations, keys } from "../src/db/schema.ts";
import { makegoodRefunds } from "../src/services/makegood-schema.ts";
import { issueRefund } from "../src/services/makegood.ts";
import { runAnchor } from "../src/services/anchor.ts";
import { proofPackRoutes } from "../src/api/proof-pack.ts";
import { PROOF_PACK_LIMITS, proofPackQuery } from "../src/proof-pack/read.ts";
import { verifyProofPack } from "../scripts/verify-proof-pack.mjs";
import { verifyReceipt as webVerifyReceipt } from "../web/lib/verify.js";

// U100: proof packs. src/app.ts registers proofPackRoutes after statementRoutes; this harness registers it the same way.

const LLAMA = MODELS.llama.slug;
const PROMPT = "proof-pack prompt sentinel 7f3a";
const ANSWER = "proof-pack answer sentinel 91c2";
const today = () => new Date().toISOString().slice(0, 10);
type Key = { hash: string; auth: Record<string, string> };

let h: Harness;
beforeAll(async () => {
  h = await startRouter({
    env: { STATEMENTS_ENABLED: "true", MAKEGOOD_ENABLED: "true" },
    providers: [{ id: "alpha", name: "Alpha", models: [MODELS.llama, MODELS.qwen], reply: () => ANSWER }],
  });
  proofPackRoutes(h.app, h.ctx); // before the first request, as app.ts would
});
afterAll(async () => {
  await h?.close();
});

const pack = async (auth: Record<string, string>, query: Record<string, string>) => {
  const r = await h.request(`/api/v1/proof-pack?${new URLSearchParams(query)}`, { headers: auth });
  return { status: r.status, headers: r.headers, body: (await r.json()) as { data?: any; error?: { type: string; message: string } } };
};
const okPack = async (auth: Record<string, string>, query: Record<string, string> = { from: today(), to: today() }) => {
  const r = await pack(auth, query);
  expect(r.status).toBe(200);
  return r.body.data;
};
const call = async (auth: Record<string, string>, stream = false) => {
  const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model: LLAMA, stream, messages: [{ role: "user", content: `${PROMPT} please` }] } });
  const text = await r.text();
  expect(r.status, text).toBe(200);
  if (!stream) expect(text).toContain(ANSWER); // a stream splits it across events
};
const child = async (owner: Key): Promise<Key> => {
  const r = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Pack agent" } });
  expect(r.status).toBe(201);
  const j = await r.json();
  return { hash: j.data.hash, auth: { authorization: `Bearer ${j.key}` } };
};
const idsOf = async (keyHash: string) => (await h.ctx.db.select({ id: generations.id }).from(generations).where(eq(generations.keyHash, keyHash))).map((g) => g.id);
async function refundFor(generationId: string, accountId: string, keyHash: string) {
  const id = `rf_pack${generationId.slice(-10)}`;
  await h.ctx.db.insert(makegoodRefunds).values({ id, sourceId: generationId, generationId, accountId, keyHash, rule: "truncated_stream", amount: 1n, evidence: { billed_completion_tokens: 2, delivered_completion_tokens: 1 }, status: "pending" });
  expect((await issueRefund(h.ctx, id, new Date()))?.status).toBe("issued");
  return id;
}
const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(k), strings(x, out));
  return out;
};

describe("a proof pack", () => {
  let owner: Key, agent: Key, accountId: string, refundId: string, full: any;
  beforeAll(async () => {
    owner = await h.fundedKey();
    [{ accountId }] = await h.ctx.db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, owner.hash));
    agent = await child(owner);
    await call(owner.auth);
    await call(owner.auth, true);
    await call(agent.auth);
    await Bun.sleep(1100); // runAnchor closes whole seconds
    expect((await runAnchor(h.ctx)).anchored).toBeGreaterThan(0);
    await call(owner.auth); // after the root: no Merkle path yet
    refundId = await refundFor((await idsOf(agent.hash))[0], accountId, agent.hash);
    full = await okPack(owner.auth);
  });

  test("bundles the exact receipts, refund receipts, statement and published keys, and every receipt verifies", async () => {
    expect(full).toMatchObject({ type: "anyroute.proof-pack.v1", version: 1, scope: "account", key_hash: null, part: 1, truncated: false, next_cursor: null });
    expect(full.range).toMatchObject({ from: today(), to: today(), days: 1, time_zone: "UTC", so_far: true });
    expect(full.calls).toHaveLength(4);
    expect(full.counts).toMatchObject({ calls: 4, receipts: 4, without_receipt: 0, v2_receipts: 4, refunds: 1, statements: 1 });
    expect(full.counts.merkle_paths).toBe(6); // three rooted calls, v1 and v2 paths each
    for (const c of full.calls) {
      const served = (await (await h.request(`/api/v1/receipts/${c.id}`)).json()).data;
      const { privacy: _, ...receipt } = served;
      expect(c.receipt).toEqual(receipt); // the same object, Merkle paths included (anchorProof)
      expect((await webVerifyReceipt(c.receipt, { keys: full.keys })).valid).toBe(true);
    }
    expect(full.refunds).toEqual([(await (await h.request(`/api/v1/receipts/${refundId}`)).json()).data]);
    expect(full.keys).toEqual(await (await h.request("/.well-known/anyroute-receipt-keys.json")).json());
    const [statement] = full.statements;
    expect(statement.payload).toMatchObject({ type: "anyroute.statement.v1", month: today().slice(0, 7), scope: "account" });
    expect(await h.ctx.signer.verify(statement.payload, statement.sig, statement.key_id)).toBe(true);
    expect(await h.ctx.signer.verify(full.manifest.payload, full.manifest.sig, full.manifest.key_id)).toBe(true);
    expect(full.manifest.payload.calls.map((c: { id: string }) => c.id)).toEqual(full.calls.map((c: { id: string }) => c.id));
    expect(full.verify.command).toContain("verify-proof-pack.mjs");
  });

  test("the offline verifier passes it, from code and from the command line", () => {
    const result = verifyProofPack({ data: full });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({ calls: 4, receipts: 4, v1_valid: 4, v2_valid: 4, paths: 6, paths_valid: 6, unrooted: 1, refunds_valid: 1, statements_valid: 1, manifest: true });
    const dir = mkdtempSync(join(tmpdir(), "proof-pack-"));
    try {
      const file = join(dir, "pack.json");
      writeFileSync(file, JSON.stringify({ data: full }));
      const out = execFileSync("node", ["scripts/verify-proof-pack.mjs", file], { cwd: join(import.meta.dir, ".."), encoding: "utf8" });
      expect(out).toContain("Result: every check passed.");
      writeFileSync(file, JSON.stringify({ ...full, calls: full.calls.slice(1) }));
      let failed = false;
      try {
        execFileSync("node", ["scripts/verify-proof-pack.mjs", file], { cwd: join(import.meta.dir, ".."), stdio: "pipe" });
      } catch (e) {
        failed = (e as { status: number }).status === 1;
      }
      expect(failed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("holds no prompt or answer text: receipts keep hashes only", () => {
    const text = JSON.stringify(full);
    expect(text).not.toContain(PROMPT);
    expect(text).not.toContain(ANSWER);
    expect(text.toLowerCase()).not.toContain("sentinel");
    const words = strings(full);
    for (const banned of ["messages", "content", "choices", "attempts"]) expect(words).not.toContain(banned);
    for (const c of full.calls) {
      expect(c.receipt.payload.request_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(c.receipt.v2.claims.req.h).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test("tampering with any receipt, path, statement, key or the listing fails", () => {
    const fails = (mutate: (p: any) => void, expected: RegExp) => {
      const copy = structuredClone(full);
      mutate(copy);
      const r = verifyProofPack(copy);
      expect(r.ok).toBe(false);
      expect(r.failures.join("\n")).toMatch(expected);
    };
    fails((p) => (p.calls[0].receipt.payload.cost = "0"), /v1 the signature does not verify/);
    fails((p) => (p.calls[1].receipt.v2.cose = Buffer.from(Buffer.from(p.calls[1].receipt.v2.cose, "base64").map((b: number, i: number) => (i === 40 ? b ^ 1 : b))).toString("base64")), /v2/);
    fails((p) => (p.calls[0].receipt.anchor.proof[0] = `0x${"ab".repeat(32)}`), /Merkle path does not lead/);
    fails((p) => (p.calls[0].receipt.v2.claims.model.id = "other/model"), /readable v2 claims differ/);
    fails((p) => (p.refunds[0].payload.amount = "9"), /refund .*signature does not verify/);
    fails((p) => (p.statements[0].payload.deposits = "1000"), /statement .*signature does not verify/);
    fails((p) => p.calls.pop(), /manifest: .*calls/);
    fails((p) => p.refunds.pop(), /manifest: .*refunds/);
    fails((p) => (p.keys.keys[0].kid = "0000000000000000"), /id does not match its bytes|not in this pack/);
    fails((p) => (p.type = "something.else"), /not an Anyroute proof pack/);
  });

  test("scope follows statements and Activity: an ordinary key reads only its own calls and refunds", async () => {
    const own = await okPack(agent.auth);
    expect(own).toMatchObject({ scope: "key", key_hash: agent.hash });
    expect(own.calls.map((c: { id: string }) => c.id)).toEqual(await idsOf(agent.hash));
    expect(own.refunds.map((r: { id: string }) => r.id)).toEqual([refundId]);
    expect(own.statements[0].payload).toMatchObject({ scope: "key", key_hash: agent.hash });
    expect(verifyProofPack(own).ok).toBe(true);
    const ownerOnly = await okPack(owner.auth);
    expect(ownerOnly.calls.length).toBe(4);
    const other = await h.fundedKey();
    expect((await okPack(other.auth)).calls).toEqual([]);
    expect((await (await h.request("/api/v1/proof-pack/limits", { headers: agent.auth })).json()).data).toMatchObject({ scope: "key", max_days: 31, max_calls: PROOF_PACK_LIMITS.maxCalls });
    expect((await (await h.request("/api/v1/proof-pack/limits", { headers: owner.auth })).json()).data.scope).toBe("account");
    // A session key stays key-scoped even with management metadata, exactly as statements.
    const session = (await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
    await h.ctx.db.update(keys).set({ management: true }).where(eq(keys.keyHash, session.key_hash));
    expect(await okPack({ authorization: `Bearer ${session.key}` })).toMatchObject({ scope: "key", calls: [] });
    // Inference-only keys are refused before the route, as for statements.
    const limited = await child(owner);
    await h.ctx.db.update(keys).set({ scope: "inference" }).where(eq(keys.keyHash, limited.hash));
    expect((await pack(limited.auth, { from: today(), to: today() })).status).toBe(403);
    expect((await h.request(`/api/v1/statements/${today().slice(0, 7)}`, { headers: limited.auth })).status).toBe(403);
  });
});

describe("limits", () => {
  test("dates are validated, a range over 31 days is 413, and no key is 401", async () => {
    const k = await h.fundedKey();
    expect((await h.request(`/api/v1/proof-pack?from=${today()}&to=${today()}`)).status).toBe(401);
    expect((await h.request("/api/v1/proof-pack/limits")).status).toBe(401);
    for (const q of [{}, { from: today() }, { from: "2026-02-30", to: "2026-03-01" }, { from: "2026-3-01", to: "2026-03-02" }, { from: "2026-03-05", to: "2026-03-01" }, { from: "2999-01-01", to: "2999-01-02" }]) {
      const r = await pack(k.auth, q as Record<string, string>);
      expect(r.status, JSON.stringify(q)).toBe(400);
    }
    const long = await pack(k.auth, { from: "2026-01-01", to: "2026-02-01" });
    expect(long.status).toBe(413);
    expect(long.body.error).toMatchObject({ type: "range_too_large" });
    expect(long.body.error!.message).toContain("at most 31 days");
    expect((await pack(k.auth, { from: "2026-01-01", to: "2026-01-31" })).status).toBe(200);
    expect(proofPackQuery({ from: "2026-02-01", to: "2026-03-03" }).days).toBe(31);
    expect((await pack(k.auth, { from: today(), to: today(), cursor: "not a cursor" })).status).toBe(400);
  });

  test("statements cover each month the range touches; months before the account are listed as unavailable", async () => {
    const k = await h.fundedKey();
    const [row] = await h.ctx.db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, k.hash));
    await h.ctx.db.update(accounts).set({ createdAt: new Date("2026-04-15T00:00:00Z") }).where(eq(accounts.id, row.accountId));
    const p = await okPack(k.auth, { from: "2026-03-25", to: "2026-04-20" });
    expect(p.statements.map((s: any) => s.payload.month)).toEqual(["2026-04"]);
    expect(p.statements_unavailable).toEqual([{ month: "2026-03", status: 404, reason: "No account existed in this month." }]);
    expect(p.range).toMatchObject({ from_ts: "2026-03-25T00:00:00.000Z", to_exclusive: "2026-04-21T00:00:00.000Z", days: 27, so_far: false });
    expect(verifyProofPack(p).ok).toBe(true);
  });

  test("more calls than one file holds are split with a cursor that continues exactly once", async () => {
    const k = await h.fundedKey();
    const [row] = await h.ctx.db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, k.hash));
    const base = Date.parse("2026-06-10T00:00:00Z");
    const n = PROOF_PACK_LIMITS.maxCalls + 5;
    const values = Array.from({ length: n }, (_, i) => ({ id: `gen-pack-${k.hash.slice(0, 6)}-${String(i).padStart(5, "0")}`, accountId: row.accountId, keyHash: k.hash, modelId: LLAMA, providerId: "alpha", mode: "prepaid", ts: new Date(base + Math.floor(i / 3) * 1000) }));
    for (let i = 0; i < values.length; i += 500) await h.ctx.db.insert(generations).values(values.slice(i, i + 500));
    const first = await okPack(k.auth, { from: "2026-06-10", to: "2026-06-10" });
    expect(first).toMatchObject({ part: 1, truncated: true });
    expect(first.calls).toHaveLength(PROOF_PACK_LIMITS.maxCalls);
    expect(first.counts.without_receipt).toBe(PROOF_PACK_LIMITS.maxCalls);
    expect(verifyProofPack(first).ok).toBe(true);
    const second = await okPack(k.auth, { from: "2026-06-10", to: "2026-06-10", cursor: first.next_cursor });
    expect(second).toMatchObject({ part: 2, truncated: false, next_cursor: null });
    expect(second.manifest.payload.after).toMatchObject({ id: first.calls.at(-1).id });
    const ids = [...first.calls, ...second.calls].map((c: { id: string }) => c.id);
    expect(ids).toEqual(values.map((v) => v.id));
    // A cursor belongs to one range and one key's access.
    expect((await pack(k.auth, { from: "2026-06-09", to: "2026-06-10", cursor: first.next_cursor })).status).toBe(400);
    const other = await h.fundedKey();
    expect((await pack(other.auth, { from: "2026-06-10", to: "2026-06-10", cursor: first.next_cursor })).status).toBe(400);
  });

  test("a file rebuilds at most the anchor cap of Merkle trees", async () => {
    const k = await h.fundedKey();
    const [row] = await h.ctx.db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, k.hash));
    const base = Date.parse("2026-07-01T00:00:00Z");
    const values = Array.from({ length: PROOF_PACK_LIMITS.maxAnchors + 3 }, (_, i) => ({ id: `gen-anchor-${k.hash.slice(0, 6)}-${String(i).padStart(4, "0")}`, accountId: row.accountId, keyHash: k.hash, modelId: LLAMA, providerId: "alpha", mode: "prepaid", ts: new Date(base + i * 1000), anchorIndex: 900_000 + i, leafIndex: 0 }));
    await h.ctx.db.insert(generations).values(values);
    const first = await okPack(k.auth, { from: "2026-07-01", to: "2026-07-01" });
    expect(first.calls).toHaveLength(PROOF_PACK_LIMITS.maxAnchors);
    expect(first.truncated).toBe(true);
    const second = await okPack(k.auth, { from: "2026-07-01", to: "2026-07-01", cursor: first.next_cursor });
    expect(second.calls).toHaveLength(3);
  });

  test("ten packs per key per minute, then 429 with retry-after", async () => {
    const k = await h.fundedKey();
    for (let i = 0; i < PROOF_PACK_LIMITS.perMinute; i++) expect((await pack(k.auth, { from: today(), to: today() })).status).toBe(200);
    const limited = await pack(k.auth, { from: today(), to: today() });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await pack((await h.fundedKey()).auth, { from: today(), to: today() })).status).toBe(200); // per key
  });

  test("off with statements: no route answers", async () => {
    const off = await startRouter();
    try {
      proofPackRoutes(off.app, off.ctx);
      const k = await off.fundedKey();
      expect(off.ctx.cfg.statementsEnabled).toBe(false);
      expect((await off.request(`/api/v1/proof-pack?from=${today()}&to=${today()}`, { headers: k.auth })).status).toBe(404);
      expect((await off.request("/api/v1/proof-pack/limits", { headers: k.auth })).status).toBe(404);
    } finally {
      await off.close();
    }
  });
});
