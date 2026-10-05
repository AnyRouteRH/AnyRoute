import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { generations } from "../src/db/schema.ts";
import { balanceOf } from "../src/ledger/ledger.ts";
import { decodeClaims, decodeCoseSign1 } from "../src/receipts/v2.ts";
import { decisionTagOf, parseDecisionTag } from "../src/receipts/decision-tag.ts";
import { DECISION_TAG_HEADER, decisionHeaders, orderIntentHash, verifyDecisionReceipt } from "../integrations/robinhood-agents/decision-receipt.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proofPackRoutes } from "../src/api/proof-pack.ts";
import { decisionTagProblems, orderIntentHash as packIntentHash, verifyProofPack } from "../scripts/verify-proof-pack.mjs";
import { startRouter, sse, MODELS, type Harness } from "./helpers.ts";

// B: X-Anyroute-Decision-Tag. The digest of an order intent, signed into the v1 and v2 receipts of the model call that
// informed it, verifiable later with the integration helper against the router's published keys.

const intent = { symbol: "STOCK_A", side: "buy", quantity: "2", limit_price: "180.00", client_order_id: "7f3c" };
const chat = (extra: Record<string, unknown> = {}) => ({ model: MODELS.llama.slug, messages: [{ role: "user", content: "buy or wait?" }], max_tokens: 32, ...extra });

test("the helper's intent hash is canonical, has a fixed known vector shared with the Python helper, and parses as a tag", () => {
  expect(orderIntentHash(intent)).toBe("sha256:c6a5490500b12be3787fadaa8d87982c369b158af7f5cdfdc8643b5177477c8d");
  expect(orderIntentHash({ client_order_id: "7f3c", limit_price: "180.00", quantity: "2", side: "buy", symbol: "STOCK_A" })).toBe(orderIntentHash(intent));
  expect(decisionHeaders(intent)).toEqual({ [DECISION_TAG_HEADER]: orderIntentHash(intent) });
  expect(parseDecisionTag(orderIntentHash(intent))).toBe(orderIntentHash(intent));
  expect(parseDecisionTag(orderIntentHash(intent).slice(7).toUpperCase())).toBe(orderIntentHash(intent));
  expect(parseDecisionTag(undefined)).toBeNull();
  for (const bad of ["", "sha256:", "sha256:xyz", "sha512:" + "a".repeat(64), "a".repeat(63), "a".repeat(65)]) expect(() => parseDecisionTag(bad)).toThrow(/X-Anyroute-Decision-Tag/);
});

test("the unlinkable lane refuses a tag; off means the header is never read", () => {
  const c = { req: { header: (n: string) => (n === "x-anyroute-decision-tag" ? orderIntentHash(intent) : undefined) } } as never;
  expect(() => decisionTagOf(true, c, "unlinkable")).toThrow(/unlinkable lane/);
  expect(decisionTagOf(true, c, "attested")).toBe(orderIntentHash(intent));
  expect(decisionTagOf(false, { req: { header: () => "not a tag" } } as never, "public")).toBeNull();
});

describe("DECISION_TAGS_ENABLED=true", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter({ env: { DECISION_TAGS_ENABLED: "true" } }); });
  afterAll(async () => { await h?.close(); });

  test("the tag round-trips into the signed v1 and v2 receipts and verifies with the helper; a changed intent does not", async () => {
    const key = await h.fundedKey();
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...key.auth, ...decisionHeaders(intent) }, json: chat() });
    expect(r.status).toBe(200);
    const receipt = (await r.json()).receipt;
    expect(receipt.payload.decision_tag).toBe(orderIntentHash(intent));
    expect(receipt.v2.claims.decision_tag).toBe(orderIntentHash(intent));
    // The COSE bytes carry it too (the JSON claims are only a view of them).
    expect(decodeClaims(decodeCoseSign1(Buffer.from(receipt.v2.cose, "base64")).payload).decision_tag).toBe(orderIntentHash(intent));
    const keys = await (await h.request("/.well-known/anyroute-receipt-keys.json")).json();
    const ok = await verifyDecisionReceipt(receipt, intent, { keys });
    expect(ok).toMatchObject({ ok: true, checks: { key_found: true, signature: true, decision_tag: true }, model: MODELS.llama.slug });
    expect((await verifyDecisionReceipt(receipt, { ...intent, quantity: "20" }, { keys })).checks).toEqual({ key_found: true, signature: true, decision_tag: false });
    // Editing the tag in a stored receipt breaks the router's signature.
    const forged = { ...receipt, payload: { ...receipt.payload, decision_tag: orderIntentHash({ ...intent, quantity: "20" }) } };
    expect((await verifyDecisionReceipt(forged, { ...intent, quantity: "20" }, { keys })).checks.signature).toBe(false);
    // The router's own verifier agrees, and the stored generation keeps the same signed payload.
    expect((await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload: receipt.payload, sig: receipt.sig, key_id: receipt.key_id } })).json()).data.valid).toBe(true);
    const [row] = await h.ctx.db.select().from(generations).where(eq(generations.id, receipt.id));
    expect((row.receipt as { decision_tag?: string }).decision_tag).toBe(orderIntentHash(intent));
    expect((row.receiptV2 as { decision_tag?: string }).decision_tag).toBe(orderIntentHash(intent));
  });

  test("POST /api/v1/receipts/verify shows the signed tag and compares it with the order hash a caller sends", async () => {
    const key = await h.fundedKey();
    const tag = orderIntentHash(intent), changed = orderIntentHash({ ...intent, quantity: "20" });
    const receipt = (await (await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...key.auth, ...decisionHeaders(intent) }, json: chat() })).json()).receipt;
    const plain = (await (await h.request("/api/v1/chat/completions", { method: "POST", headers: key.auth, json: chat() })).json()).receipt;
    const verify = async (body: Record<string, unknown>) => (await (await h.request("/api/v1/receipts/verify", { method: "POST", json: body })).json()).data;
    const v1 = { payload: receipt.payload, sig: receipt.sig, key_id: receipt.key_id };
    expect(await verify(v1)).toMatchObject({ valid: true, decision_tag: tag, decision_tag_valid: null });
    expect(await verify({ ...v1, decision_tag: tag })).toMatchObject({ valid: true, signature_valid: true, decision_tag_valid: true });
    expect(await verify({ ...v1, decision_tag: tag.slice(7).toUpperCase() })).toMatchObject({ valid: true, decision_tag_valid: true });
    expect(await verify({ ...v1, decision_tag: changed })).toMatchObject({ valid: false, signature_valid: true, decision_tag: tag, decision_tag_valid: false });
    expect(await verify({ cose: receipt.v2.cose, decision_tag: tag })).toMatchObject({ valid: true, signature_valid: true, decision_tag: tag, decision_tag_valid: true });
    expect(await verify({ cose: receipt.v2.cose, decision_tag: changed })).toMatchObject({ valid: false, decision_tag_valid: false });
    // An untagged receipt says so, and cannot match an order.
    const untagged = { payload: plain.payload, sig: plain.sig, key_id: plain.key_id };
    expect(await verify(untagged)).toMatchObject({ valid: true, decision_tag: null, decision_tag_valid: null });
    expect(await verify({ ...untagged, decision_tag: tag })).toMatchObject({ valid: false, signature_valid: true, decision_tag: null, decision_tag_valid: false });
    // A tag edited into a stored receipt still fails its signature, whatever the comparison says.
    expect(await verify({ ...v1, payload: { ...v1.payload, decision_tag: changed }, decision_tag: changed })).toMatchObject({ valid: false, signature_valid: false, decision_tag_valid: true });
    expect((await h.request("/api/v1/receipts/verify", { method: "POST", json: { ...v1, decision_tag: "buy STOCK_A" } })).status).toBe(400);
  });

  test("streamed calls carry the tag in the closing receipt; untagged calls are unchanged", async () => {
    const key = await h.fundedKey();
    const s = await sse(await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...key.auth, ...decisionHeaders(intent) }, json: chat({ stream: true }) }));
    const final = s.events.find((e) => e.receipt);
    expect(final.receipt.payload.decision_tag).toBe(orderIntentHash(intent));
    expect(final.receipt.v2.claims.decision_tag).toBe(orderIntentHash(intent));
    const plain = (await (await h.request("/api/v1/chat/completions", { method: "POST", headers: key.auth, json: chat() })).json()).receipt;
    expect("decision_tag" in plain.payload).toBe(false);
    expect("decision_tag" in plain.v2.claims).toBe(false);
  });

  test("a malformed tag is refused before anything is held or charged", async () => {
    const key = await h.fundedKey();
    const account = (await h.ctx.db.query.keys.findFirst({ where: (k, { eq }) => eq(k.keyHash, key.hash) }))!.accountId;
    const before = await balanceOf(h.ctx.db, account);
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...key.auth, [DECISION_TAG_HEADER]: "buy STOCK_A" }, json: chat() });
    expect(r.status).toBe(400);
    expect((await r.json()).error.type).toBe("invalid_decision_tag");
    expect(await balanceOf(h.ctx.db, account)).toEqual(before);
  });

  test("the Responses, Anthropic and Ollama adapters pass the tag through, and a browser may send it", async () => {
    const key = await h.fundedKey();
    const tagged = { ...decisionHeaders(intent) };
    const calls = [
      await h.request("/v1/responses", { method: "POST", headers: { ...key.auth, ...tagged }, json: { model: MODELS.llama.slug, input: "buy or wait?" } }),
      await h.request("/v1/messages", { method: "POST", headers: { "x-api-key": key.secret, ...tagged }, json: { model: MODELS.llama.slug, max_tokens: 32, messages: [{ role: "user", content: "buy or wait?" }] } }),
      await h.request("/ollama/api/chat", { method: "POST", headers: { ...key.auth, ...tagged }, json: { model: MODELS.llama.slug, stream: false, messages: [{ role: "user", content: "buy or wait?" }] } }),
    ];
    for (const res of calls) {
      expect(res.status).toBe(200);
      const id = res.headers.get("x-receipt-id");
      expect(id).toBeTruthy();
      expect((await (await h.request(`/api/v1/receipts/${id}`)).json()).data.payload.decision_tag).toBe(orderIntentHash(intent));
    }
    const preflight = await h.request("/api/v1/chat/completions", { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,x-anyroute-decision-tag" } });
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-anyroute-decision-tag");
  });

  test("/api/v1/status says decision tags are on", async () => {
    expect((await (await h.request("/api/v1/status")).json()).data.decision_tags).toEqual({ enabled: true, header: "X-Anyroute-Decision-Tag" });
  });
});

describe("DECISION_TAGS_ENABLED unset (the default)", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter(); });
  afterAll(async () => { await h?.close(); });

  test("the header is ignored, the receipt has no tag and status says off", async () => {
    const key = await h.fundedKey();
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...key.auth, [DECISION_TAG_HEADER]: "not even a hash" }, json: chat() });
    expect(r.status).toBe(200);
    const receipt = (await r.json()).receipt;
    expect("decision_tag" in receipt.payload).toBe(false);
    expect((await (await h.request("/api/v1/status")).json()).data.decision_tags.enabled).toBe(false);
  });
});

describe("decision tags linked to Agent Guard (DECISION_TAGS_ENABLED and AGENT_GUARD_ENABLED)", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter({ env: { DECISION_TAGS_ENABLED: "true", AGENT_POLICY_ENABLED: "true", AGENT_GUARD_ENABLED: "true" } }); });
  afterAll(async () => { await h?.close(); });
  type Auth = { hash?: string; auth: Record<string, string> };
  const rulebook = { version: 1, models: {}, caps: {}, on_breach: "deny", actions: {} };
  const tag = orderIntentHash(intent);
  const decide = async (k: Auth, details?: string) => (await (await h.request("/api/v1/guard/decide", { method: "POST", headers: k.auth, json: { action: "trade.order", target: "STOCK_A", amount_usd: "360.00", ...(details ? { details_sha256: details } : {}) } })).json()).data;
  const ask = async (k: Auth, headers: Record<string, string> = {}) => {
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, ...headers }, json: chat() });
    expect(r.status).toBe(200);
    return (await r.json()).receipt;
  };
  const lookup = async (k: Auth, query: string) => h.request(`/api/v1/guard/decisions?${query}`, { headers: k.auth });

  test("a decision names the calls in the same agent whose receipt carries its order digest, and the reverse lookup finds it", async () => {
    const parent = await h.fundedKey();
    expect((await h.request(`/api/v1/agents/${parent.hash}/policy`, { method: "PUT", headers: parent.auth, json: rulebook })).status).toBe(200);
    const session = (await (await h.request("/api/v1/sessions", { method: "POST", headers: parent.auth, json: { budget_usd: 1 } })).json()).data;
    const agent: Auth = { auth: { authorization: `Bearer ${session.key}` } };
    const informing = await ask(agent, decisionHeaders(intent));
    await ask(agent, decisionHeaders({ ...intent, quantity: "20" }));
    const untagged = await ask(agent);

    const d = await decide(agent, tag);
    expect(d.decision).toBe("allow");
    expect(d.informed_by).toEqual([{ generation_id: informing.id, receipt_id: informing.id, model: informing.payload.model, provider: informing.payload.provider, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/), receipt_url: `/api/v1/receipts/${informing.id}`, verify_url: `/verify/?r=${informing.id}` }]);
    // The linked receipt is the signed one, and its tag is the decision's digest.
    expect((await (await h.request(d.informed_by[0].receipt_url)).json()).data.payload.decision_tag).toBe(d.signed.payload.intent.details_sha256);
    // The parent key is the same agent; another key in the account is not; no digest, no link field.
    const parentDecision = await decide(parent, tag);
    expect(parentDecision.informed_by.map((c: { generation_id: string }) => c.generation_id)).toEqual([informing.id]);
    const otherKey = await h.request("/api/v1/keys", { method: "POST", headers: parent.auth, json: { name: "other agent" } });
    const other: Auth = { auth: { authorization: `Bearer ${(await otherKey.json()).key}` } };
    const otherDecision = await decide(other, tag);
    expect(otherDecision.informed_by).toEqual([]);
    expect("informed_by" in (await decide(agent))).toBe(false);

    // The reverse: from a receipt id, or the digest, to the decisions the reader may see, each with its informing calls.
    const byReceipt = (await (await lookup(parent, `receipt=${informing.id}`)).json()).data;
    // The harness's first key manages its account, so it reads every decision in it.
    expect(byReceipt).toMatchObject({ details_sha256: tag, receipt_id: informing.id, scope: "account" });
    expect(byReceipt.decisions.map((x: { decision_id: string }) => x.decision_id).sort()).toEqual([d.decision_id, parentDecision.decision_id, otherDecision.decision_id].sort());
    const mine = byReceipt.decisions.find((x: { decision_id: string }) => x.decision_id === d.decision_id);
    expect(mine).toMatchObject({ action: "trade.order", target: "STOCK_A", amount_pico: "360000000000000", decision: "allow", details_sha256: tag, outcome: null });
    expect(mine.informed_by.map((c: { generation_id: string }) => c.generation_id)).toEqual([informing.id]);
    // A session key reads only its own decisions; another key reads only its own.
    expect((await (await lookup(agent, `details_sha256=${tag}`)).json()).data.decisions.map((x: { decision_id: string }) => x.decision_id)).toEqual([d.decision_id]);
    const theirs = (await (await lookup(other, `receipt=${informing.id}`)).json()).data;
    expect([theirs.scope, theirs.decisions.map((x: { decision_id: string; informed_by: unknown[] }) => [x.decision_id, x.informed_by])]).toEqual(["key", [[otherDecision.decision_id, []]]]);
    // A receipt without a tag links nothing; bad input is refused.
    expect((await (await lookup(parent, `receipt=${untagged.id}`)).json()).data).toMatchObject({ details_sha256: null, decisions: [] });
    expect((await lookup(parent, "receipt=gen-missing")).status).toBe(404);
    for (const q of ["", `details_sha256=${tag.toUpperCase()}`, `details_sha256=${tag}&receipt=${informing.id}`]) expect((await lookup(parent, q)).status).toBe(400);
  });
});

describe("Agent Guard with DECISION_TAGS_ENABLED unset", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", AGENT_GUARD_ENABLED: "true" } }); });
  afterAll(async () => { await h?.close(); });

  test("a decision carries no link field, and the reverse lookup lists decisions without informing calls", async () => {
    const key = await h.fundedKey();
    const d = (await (await h.request("/api/v1/guard/decide", { method: "POST", headers: key.auth, json: { action: "trade.order", amount_usd: "1", details_sha256: orderIntentHash(intent) } })).json()).data;
    expect("informed_by" in d).toBe(false);
    const rev = (await (await h.request(`/api/v1/guard/decisions?details_sha256=${orderIntentHash(intent)}`, { headers: key.auth })).json()).data;
    expect(rev.decisions.map((x: { decision_id: string }) => x.decision_id)).toEqual([d.decision_id]);
    expect("informed_by" in rev.decisions[0]).toBe(false);
  });
});

describe("decision tags in a proof pack (DECISION_TAGS_ENABLED and STATEMENTS_ENABLED)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ env: { DECISION_TAGS_ENABLED: "true", STATEMENTS_ENABLED: "true" } });
    proofPackRoutes(h.app, h.ctx); // as app.ts registers it, before the first request
  });
  afterAll(async () => { await h?.close(); });
  const today = () => new Date().toISOString().slice(0, 10);
  const second = { ...intent, side: "sell", client_order_id: "7f3d" };

  test("the pack lists each tagged call with its signed tag, and the offline verifier checks the list and finds an order's call", async () => {
    const key = await h.fundedKey();
    const tagged = (await (await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...key.auth, ...decisionHeaders(intent) }, json: chat() })).json()).receipt;
    const streamed = (await sse(await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...key.auth, ...decisionHeaders(second) }, json: chat({ stream: true }) }))).events.find((e) => e.receipt).receipt;
    const plain = (await (await h.request("/api/v1/chat/completions", { method: "POST", headers: key.auth, json: chat() })).json()).receipt;
    const r = await h.request(`/api/v1/proof-pack?from=${today()}&to=${today()}`, { headers: key.auth });
    expect(r.status).toBe(200);
    const pack = (await r.json()).data;
    const rows = [{ id: tagged.id, decision_tag: orderIntentHash(intent) }, { id: streamed.id, decision_tag: orderIntentHash(second) }];
    expect([...pack.decision_tags].sort((a, b) => a.id.localeCompare(b.id))).toEqual(rows.sort((a, b) => a.id.localeCompare(b.id)));
    expect(pack.decision_tags.map((t: { id: string }) => t.id)).not.toContain(plain.id);
    expect(pack.counts.decision_tags).toBe(2);
    expect(pack.manifest.payload.decision_tags).toEqual(pack.decision_tags);
    expect(packIntentHash(intent)).toBe(orderIntentHash(intent)); // the verifier hashes orders as the helpers do

    const ok = verifyProofPack({ data: pack }, { intents: [{ name: "order.json", order: intent }] });
    expect(ok.failures).toEqual([]);
    expect(ok.summary).toMatchObject({ decision_tags: "matches", tagged_calls: 2, intents: [{ name: "order.json", tag: orderIntentHash(intent), calls: [tagged.id] }] });
    expect(ok.lines.join("\n")).toContain(`Order order.json (${orderIntentHash(intent)}): carried by the signed receipt of ${tagged.id}.`);
    // An order no receipt carries fails.
    const missing = verifyProofPack({ data: pack }, { intents: [{ name: "other.json", order: { ...intent, quantity: "20" } }] });
    expect(missing.ok).toBe(false);
    expect(missing.failures).toEqual([`order other.json: no signed receipt in this file carries its hash ${orderIntentHash({ ...intent, quantity: "20" })}`]);
    // A list that drops, changes or invents a tag fails on its own, as well as against the signed manifest.
    const edits = [pack.decision_tags.slice(1), pack.decision_tags.map((t: object, i: number) => (i ? t : { ...t, decision_tag: orderIntentHash({ ...intent, quantity: "20" }) })), [...pack.decision_tags, { id: plain.id, decision_tag: orderIntentHash(intent) }]];
    for (const decision_tags of edits) {
      const bad = verifyProofPack({ data: { ...pack, decision_tags } });
      expect(bad.ok).toBe(false);
      expect(bad.failures.some((f: string) => f.startsWith("decision tags: "))).toBe(true);
      expect(bad.failures.some((f: string) => f.startsWith("manifest: ") && f.includes("decision_tags"))).toBe(true);
    }

    // From the command line, with --intent.
    const dir = mkdtempSync(join(tmpdir(), "decision-tags-"));
    try {
      writeFileSync(join(dir, "pack.json"), JSON.stringify({ data: pack }));
      writeFileSync(join(dir, "order.json"), JSON.stringify(second));
      const out = execFileSync("node", ["scripts/verify-proof-pack.mjs", join(dir, "pack.json"), "--intent", join(dir, "order.json")], { cwd: join(import.meta.dir, ".."), encoding: "utf8" });
      expect(out).toContain(`carried by the signed receipt of ${streamed.id}.`);
      expect(out).toContain("Decision tags: 2 call(s) whose signed receipt carries one");
      expect(out).toContain("Result: every check passed.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the list check on its own: duplicates, malformed tags and unknown calls", () => {
    const t = orderIntentHash(intent);
    const signed = new Map<string, string | null>([["a", t], ["b", null]]);
    expect(decisionTagProblems([{ id: "a", decision_tag: t }], signed)).toEqual([]);
    expect(decisionTagProblems({}, signed)).toEqual(["it is not a list"]);
    expect(decisionTagProblems([], signed)).toEqual([`call a: its signed receipt carries ${t}, but the list leaves it out`]);
    expect(decisionTagProblems([{ id: "a", decision_tag: t }, { id: "a", decision_tag: t }], signed)).toEqual(["call a is listed twice"]);
    expect(decisionTagProblems([{ id: "a", decision_tag: t.toUpperCase() }], signed)[0]).toContain("is not sha256:");
    expect(decisionTagProblems([{ id: "a", decision_tag: t }, { id: "c", decision_tag: t }], signed)).toEqual(["call c: no call with a verified receipt has this id"]);
    expect(decisionTagProblems([{ id: "a", decision_tag: t }, { id: "b", decision_tag: t }], signed)).toEqual(["call b: the listed tag is not the one its signed receipt carries (none)"]);
  });
});
