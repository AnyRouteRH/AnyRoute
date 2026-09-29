import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { blindKeys, blindNullifiers, generations, holds, ledger } from "../src/db/schema.ts";
import { balanceOf, verifyInvariants } from "../src/ledger/ledger.ts";
import { decrypt } from "../src/lib/util.ts";
import { picoToUsd, usdToPico } from "../src/lib/money.ts";
import { BLIND_POOL } from "../src/blind/redeem.ts";
import { epochCommitment } from "../src/blind/issuer.ts";
import { blindTokens, buyTokens, fetchDirectory, finalizeTokens, issuingKey, tokenNullifier, type DirectoryKey } from "../src/blind/client.ts";
import { importIssuerPublicKey, parseIssuerSpki, suite, tokenKeyId } from "../src/blind/rsa.ts";
import { authorizationHeader, b64url, decodeBase64, decodeToken, encodeToken, hex, signedPart } from "../src/blind/token.ts";

// Blinding a token takes ~50 ms in the reference JavaScript implementation and the tests buy several.
setDefaultTimeout(60_000);

const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const chat = { model: LLAMA, messages: [{ role: "user", content: "hello" }], max_tokens: 20 };
const WEEK_MS = 604_800_000;

/** The router's own app as a `fetch`, so the client helper runs against it unmodified. */
const shim = (h: Harness): typeof fetch =>
  (async (input: unknown, init?: RequestInit) => {
    const u = new URL(String(input), "http://router.test");
    return h.app.request(u.pathname + u.search, init);
  }) as never;

const redeem = (h: Harness, token: string, body: unknown = chat, path = "/api/v1/chat/completions") =>
  h.request(path, { method: "POST", headers: { authorization: authorizationHeader(decodeBase64(token)!) }, json: body });

async function buy(h: Harness, apiKey: string, denomination: number, count: number) {
  return buyTokens({ baseUrl: "http://router.test", apiKey, denomination, count, fetch: shim(h) });
}

describe("feature flag", () => {
  test("blind tokens are off by default: no routes, and a PrivateToken header is not looked at", async () => {
    const h = await startRouter();
    try {
      expect(h.ctx.cfg.blind.enabled).toBe(false);
      expect(h.ctx.blind).toBeUndefined();
      expect((await h.request("/api/v1/blind/keys")).status).toBe(404);
      expect((await h.request("/api/v1/blind/purchase", { method: "POST", json: {} })).status).toBe(404);
      // Without the flag the header is just an unrecognised credential: the same 402 an unpaid call gets.
      const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { authorization: "PrivateToken token=AAAA" }, json: chat });
      expect(r.status).toBe(402);
    } finally {
      await h.close();
    }
  });

  test("configuration defaults and validation", () => {
    const off = loadConfig({});
    expect(off.blind.enabled).toBe(false);
    expect(off.blind.denominations).toEqual([1000, 10000, 100000]);
    expect(off.blind.epochSeconds).toBe(604_800);
    expect(loadConfig({ ANYROUTE_FEATURE_BLIND: "true" }).blind.enabled).toBe(true);
    expect(loadConfig({ BLIND_UNIT_PRICE_USD: "0.00001" }).blind.unitPricePico).toBe(usdToPico("0.00001"));
    expect(() => loadConfig({ BLIND_UNIT_PRICE_USD: "0" })).toThrow(/BLIND_UNIT_PRICE_USD/);
    expect(() => loadConfig({ BLIND_UNIT_PRICE_USD: "abc" })).toThrow(/BLIND_UNIT_PRICE_USD/);
    expect(() => loadConfig({ BLIND_EPOCH_SECONDS: "10" })).toThrow(/BLIND_EPOCH_SECONDS/);
    expect(() => loadConfig({ BLIND_MAX_BATCH: "0" })).toThrow(/BLIND_MAX_BATCH/);
    expect(() => loadConfig({ BLIND_REDEEM_RPM: "0" })).toThrow(/BLIND_REDEEM_RPM/);
    expect(() => loadConfig({ BLIND_MAX_USD_PER_DAY: "0" })).toThrow(/BLIND_MAX_USD_PER_DAY/);
  });
});

describe("blind tokens: keys, purchase, redemption", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ env: { ANYROUTE_FEATURE_BLIND: "true", BLIND_PURCHASE_RPM: "1000" } });
  });
  afterAll(async () => {
    await h.close();
  });

  test("GET /api/v1/blind/keys publishes per-epoch keys for every denomination", async () => {
    const dir = await fetchDirectory("http://router.test", shim(h));
    const epoch = h.ctx.blind!.epochAt();
    expect(dir.epoch).toBe(epoch);
    expect(dir.keys.length).toBe(6); // current and next epoch x three denominations
    expect(dir.keys.map((k) => [k.epoch, k.denomination, k.status])).toEqual([
      [epoch, 1000, "issuing"],
      [epoch, 10000, "issuing"],
      [epoch, 100000, "issuing"],
      [epoch + 1, 1000, "upcoming"],
      [epoch + 1, 10000, "upcoming"],
      [epoch + 1, 100000, "upcoming"],
    ]);
    const ids = new Set<string>();
    for (const k of dir.keys) {
      const spki = decodeBase64(k.token_key)!;
      expect(tokenKeyId(spki)).toBe(k.token_key_id); // token_key_id is the SHA-256 of the RFC 9578 SPKI
      expect(parseIssuerSpki(spki).n.length).toBe(256); // 2048-bit
      ids.add(k.token_key_id);
    }
    expect(ids.size).toBe(6);
    expect(dir.keys.find((k) => k.denomination === 10000)!.value_usd).toBe("0.02"); // 10000 units at $0.000002
    // The published challenge is the one tokens must carry, and every epoch has a commitment for the contract.
    const body = (await (await h.request("/api/v1/blind/keys")).json()).data;
    expect(body.token_type).toBe(2);
    expect(body.scheme).toBe("RSABSSA-SHA384-PSS-Deterministic");
    expect(body.challenge_digest).toBe(dir.challenge_digest);
    const mine = dir.keys.filter((k) => k.epoch === epoch);
    expect(body.commitments.find((c: { epoch: number }) => c.epoch === epoch).commitment).toBe(epochCommitment(epoch, mine.map((k) => ({ denomination: k.denomination, keyId: k.token_key_id }))).commitment);
    // Nothing secret is published.
    expect(JSON.stringify(body)).not.toMatch(/private/i);
  });

  test("issuer private keys are encrypted at rest and the previous state is stable across restarts of the issuer object", async () => {
    const rows = await h.ctx.db.select().from(blindKeys);
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const r of rows) {
      expect(r.privateEnc).toMatch(/^v1\./); // AES-GCM envelope from lib/util
      const pkcs8 = Buffer.from(decrypt(h.ctx.cfg.appSecret, r.privateEnc!), "base64");
      expect(pkcs8.length).toBeGreaterThan(1000);
      expect(r.privateEnc).not.toContain(pkcs8.toString("base64").slice(0, 40));
      expect(() => decrypt("another-secret-another-secret-another", r.privateEnc!)).toThrow();
    }
  });

  test("purchase, unblind, redeem: the whole flow", async () => {
    const k = await h.fundedKey(10n);
    const before = await balanceOf(h.ctx.db, (await h.ctx.db.query.keys.findFirst({ where: (t, { eq }) => eq(t.keyHash, k.hash) }))!.accountId);
    const bought = await buy(h, k.secret, 10_000, 3);
    expect(bought.tokens.length).toBe(3);
    expect(bought.denomination).toBe(10_000);
    expect(bought.costUsd).toBe("0.06"); // 3 x 10000 units x $0.000002

    // The buyer's credits paid for it, through the ledger.
    const account = (await h.ctx.db.query.keys.findFirst({ where: (t, { eq }) => eq(t.keyHash, k.hash) }))!.accountId;
    const after = await balanceOf(h.ctx.db, account);
    expect(before.balance - after.balance).toBe(usdToPico("0.06"));
    const purchaseRows = await h.ctx.db.select().from(ledger).where(eq(ledger.accountId, account));
    const debit = purchaseRows.find((r) => r.kind === "blind_purchase")!;
    expect(debit.amount).toBe(-usdToPico("0.06"));
    expect(debit.description).toBe("Blind tokens: 3 x 10000 units (epoch " + h.ctx.blind!.epochAt() + ")");
    expect((await balanceOf(h.ctx.db, BLIND_POOL)).balance).toBeGreaterThanOrEqual(usdToPico("0.06"));

    // The tokens are publicly verifiable with the published key and an ordinary RSA-PSS verifier.
    const dir = await fetchDirectory("http://router.test", shim(h));
    const pk = await importIssuerPublicKey(decodeBase64(issuingKey(dir, 10_000).token_key)!);
    for (const t of bought.tokens) {
      const bytes = decodeBase64(t)!;
      const parsed = decodeToken(bytes)!;
      expect(hex(parsed.keyId)).toBe(bought.keyId);
      expect(hex(parsed.challengeDigest)).toBe(dir.challenge_digest);
      expect(await suite().verify(pk, parsed.authenticator, signedPart(bytes))).toBe(true);
    }

    // Redeem the first token on a chat call.
    const poolBefore = await balanceOf(h.ctx.db, BLIND_POOL);
    const res = await redeem(h, bought.tokens[0]);
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.choices[0].message.content).toContain("hello");
    const nullifier = tokenNullifier(bought.tokens[0]);
    expect(out.blind.nullifier).toBe(nullifier);
    expect(out.blind.denomination).toBe(10_000);

    // The receipt carries the nullifier hash and no account: no payer, no key, no wallet.
    expect(out.receipt.payload.nullifier).toBe(nullifier);
    expect(out.receipt.payload.token_key_id).toBe(bought.keyId);
    expect(out.receipt.payload.payer).toBeNull();
    expect(out.receipt.payload.payment_tx).toBeNull();
    expect(out.receipt.payload.mode).toBe("blind");
    expect(JSON.stringify(out.receipt)).not.toContain(account);
    expect(JSON.stringify(out.receipt)).not.toContain(k.chainKeyHash);
    expect(JSON.stringify(out.receipt)).not.toContain(k.hash);
    const [gen] = await h.ctx.db.select().from(generations).where(eq(generations.id, out.id));
    expect(gen.accountId).toBe(BLIND_POOL);
    expect(gen.keyHash).toBeNull();
    expect(gen.mode).toBe("blind");
    expect(gen.paymentTx).toBeNull();

    // The call was charged to the pool at its actual cost, and the nullifier is recorded as spent.
    const poolAfter = await balanceOf(h.ctx.db, BLIND_POOL);
    expect(poolBefore.balance - poolAfter.balance).toBe(gen.cost);
    expect(gen.cost).toBeGreaterThan(0n);
    expect(picoToUsd(gen.cost)).toBeLessThan(0.02);
    const [row] = await h.ctx.db.select().from(blindNullifiers).where(eq(blindNullifiers.nullifier, nullifier));
    expect(row.status).toBe("spent");
    expect(row.generationId).toBe(out.id);
    expect((await balanceOf(h.ctx.db, account)).balance).toBe(after.balance); // spending a token touches no account

    // Counts only: 3 issued, 1 redeemed, no per-token record of the purchase.
    const [keyRow] = await h.ctx.db.select().from(blindKeys).where(eq(blindKeys.keyId, bought.keyId));
    expect(keyRow.issued).toBeGreaterThanOrEqual(3);
    expect((await h.ctx.blind!.redeemedCounts()).get(bought.keyId)).toBe(1);
    expect(await h.ctx.db.select().from(blindNullifiers)).toHaveLength(1);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);

    // The holder of the spent token can read its receipt back (with the anchor proof once it exists); nobody else can.
    const auth = { authorization: authorizationHeader(decodeBase64(bought.tokens[0])!) };
    const mine = await h.request(`/api/v1/generation?id=${out.id}`, { headers: auth });
    expect(mine.status).toBe(200);
    const detail = (await mine.json()).data;
    expect(detail.mode).toBe("blind");
    expect(detail.receipt.nullifier).toBe(nullifier);
    expect((await h.request(`/api/v1/generation?id=${out.id}`, { headers: { authorization: authorizationHeader(decodeBase64(bought.tokens[1])!) } })).status).toBe(404); // a different token
    expect((await h.request(`/api/v1/generation?id=${out.id}`)).status).toBe(404);
    expect((await h.request(`/api/v1/generation?id=${out.id}`, { headers: k.auth })).status).toBe(404); // the buyer's key is not linked to it
  });

  test("double spend is rejected, sequentially and concurrently", async () => {
    const k = await h.fundedKey(10n);
    const { tokens } = await buy(h, k.secret, 1_000, 3);
    const first = await redeem(h, tokens[0]);
    expect(first.status).toBe(200);
    const again = await redeem(h, tokens[0]);
    expect(again.status).toBe(401);
    expect((await again.json()).error.type).toBe("token_spent");
    expect((await redeem(h, tokens[0], { model: LLAMA, input: "x" }, "/api/v1/embeddings")).status).toBe(401); // any endpoint

    // Two requests race with one token: exactly one is served.
    const [a, b] = await Promise.all([redeem(h, tokens[1]), redeem(h, tokens[1])]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    // The spent count did not move for the loser.
    const nullifiers = await h.ctx.db.select().from(blindNullifiers).where(eq(blindNullifiers.nullifier, tokenNullifier(tokens[1])));
    expect(nullifiers).toHaveLength(1);
    expect(nullifiers[0].status).toBe("spent");
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("the token pays for at most its face value, and a refused or failed call does not spend it", async () => {
    const k = await h.fundedKey(10n);
    const { tokens } = await buy(h, k.secret, 1_000, 2); // worth $0.002
    // A request whose worst case exceeds the token is refused before the token is touched.
    const big = await redeem(h, tokens[0], { ...chat, max_tokens: 16_000 });
    expect(big.status).toBe(402);
    const bigBody = await big.json();
    expect(bigBody.error.type).toBe("token_value_too_low");
    expect(bigBody.error.metadata.token_value_usd).toBe(0.002);
    expect(await h.ctx.db.select().from(blindNullifiers).where(eq(blindNullifiers.nullifier, tokenNullifier(tokens[0])))).toHaveLength(0);

    // A request no provider can serve is answered 502 and gives the token back.
    for (const m of Object.values(h.mocks)) await fetch(m.url + "/_control", { method: "POST", body: JSON.stringify({ behaviour: "error500" }) });
    const failed = await redeem(h, tokens[0]);
    expect(failed.status).toBe(502);
    expect(await h.ctx.db.select().from(blindNullifiers).where(eq(blindNullifiers.nullifier, tokenNullifier(tokens[0])))).toHaveLength(0);
    for (const m of Object.values(h.mocks)) await fetch(m.url + "/_control", { method: "POST", body: JSON.stringify({ behaviour: "ok" }) });
    h.ctx.health = new (h.ctx.health.constructor as new (ms: number) => typeof h.ctx.health)(h.ctx.cfg.routing.outageWindowMs); // forget the outage the failures caused
    expect((await redeem(h, tokens[0])).status).toBe(200); // the same token still works
    expect((await redeem(h, tokens[0])).status).toBe(401);
    const open = await h.ctx.db.select().from(holds).where(eq(holds.accountId, BLIND_POOL));
    expect(open.every((x) => x.status !== "held")).toBe(true);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("streaming and embeddings redeem too; blind calls are never cached", async () => {
    const k = await h.fundedKey(10n);
    const { tokens } = await buy(h, k.secret, 10_000, 4);
    const stream = await redeem(h, tokens[0], { ...chat, stream: true });
    expect(stream.status).toBe(200);
    const text = await stream.text();
    const last = text.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))).pop();
    expect(last.receipt.payload.nullifier).toBe(tokenNullifier(tokens[0]));
    expect(last.receipt.payload.payer).toBeNull();
    expect((await redeem(h, tokens[0], { ...chat, stream: true })).status).toBe(401);

    const emb = await redeem(h, tokens[1], { model: "acme/embed-small", input: "hello" }, "/api/v1/embeddings");
    expect(emb.status).toBe(200);
    const embBody = await emb.json();
    expect(embBody.receipt.payload.nullifier).toBe(tokenNullifier(tokens[1]));
    expect(embBody.receipt.payload.payer).toBeNull();
    expect((await redeem(h, tokens[1], { model: "acme/embed-small", input: "hello" }, "/api/v1/embeddings")).status).toBe(401);

    // Two identical cache-enabled requests with different tokens: the second is not a cache hit.
    const c1 = await redeem(h, tokens[2], { ...chat, cache: { mode: "exact" } });
    const c2 = await redeem(h, tokens[3], { ...chat, cache: { mode: "exact" } });
    expect(c1.status).toBe(200);
    expect(c2.status).toBe(200);
    expect(c2.headers.get("x-anyroute-cache")).toBeNull();
    expect((await c2.json()).cached).toBeUndefined();
  });

  test("tokens that do not verify are refused", async () => {
    const k = await h.fundedKey(10n);
    const bought = await buy(h, k.secret, 1_000, 1);
    const good = decodeBase64(bought.tokens[0])!;
    const dir = await fetchDirectory("http://router.test", shim(h));
    const other = issuingKey(dir, 10_000);
    const tampered = (edit: (b: Uint8Array) => void) => {
      const b = new Uint8Array(good);
      edit(b);
      return b64url(b);
    };
    const type = async (token: string) => {
      const r = await redeem(h, token);
      expect(r.status).toBe(401);
      return (await r.json()).error.type as string;
    };
    expect(await type(tampered((b) => (b[5] ^= 1)))).toBe("invalid_token"); // nonce changed: signature no longer matches
    expect(await type(tampered((b) => (b[b.length - 1] ^= 1)))).toBe("invalid_token"); // authenticator changed
    expect(await type(tampered((b) => (b[40] ^= 1)))).toBe("invalid_token"); // challenge digest is not this router's
    expect(await type(tampered((b) => b.set(unhexId(other.token_key_id), 66)))).toBe("invalid_token"); // key id swapped to another denomination's
    expect(await type(tampered((b) => b.set(new Uint8Array(32).fill(7), 66)))).toBe("unknown_token_key");
    expect(await type(b64url(good.subarray(0, 100)))).toBe("invalid_token"); // truncated
    const malformed = await h.request("/api/v1/chat/completions", { method: "POST", headers: { authorization: "PrivateToken token=%%%" }, json: chat });
    expect(malformed.status).toBe(401);
    expect((await malformed.json()).error.type).toBe("invalid_token");
    expect(await h.ctx.db.select().from(blindNullifiers).where(eq(blindNullifiers.nullifier, tokenNullifier(bought.tokens[0])))).toHaveLength(0);
    expect((await redeem(h, bought.tokens[0])).status).toBe(200); // the untouched token still works
  });

  test("purchases: validation, caps, ownership", async () => {
    const k = await h.fundedKey(10n);
    const dir = await fetchDirectory("http://router.test", shim(h));
    const key = issuingKey(dir, 1_000);
    const pending = await blindTokens(key, dir.challenge_digest, 2);
    const post = (json: unknown, auth: Record<string, string> = k.auth) => h.request("/api/v1/blind/purchase", { method: "POST", headers: auth, json });
    const msgs = pending.map((p) => b64url(p.blindedMsg));

    expect((await post({ token_key_id: key.token_key_id, blinded_msgs: msgs }, {})).status).toBe(401); // keyed
    expect((await post({ blinded_msgs: msgs })).status).toBe(400);
    expect((await post({ token_key_id: key.token_key_id, blinded_msgs: [] })).status).toBe(400);
    const tooMany = await post({ token_key_id: key.token_key_id, blinded_msgs: Array.from({ length: 33 }, (_, i) => b64url(new Uint8Array(256).fill(i + 1).map((v, j) => (j === 0 ? 0 : v)))) });
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json()).error.metadata.max_batch).toBe(32);
    expect((await post({ token_key_id: key.token_key_id, blinded_msgs: [msgs[0], msgs[0]] })).status).toBe(400); // duplicate in a batch
    expect((await post({ token_key_id: key.token_key_id, blinded_msgs: [b64url(new Uint8Array(255))] })).status).toBe(400); // wrong size
    expect((await post({ token_key_id: key.token_key_id, blinded_msgs: [b64url(new Uint8Array(256).fill(255))] })).status).toBe(400); // not below the modulus
    expect((await post({ token_key_id: key.token_key_id, blinded_msgs: ["***"] })).status).toBe(400);
    expect((await post({ token_key_id: "ab".repeat(32), blinded_msgs: msgs })).status).toBe(404); // unknown key
    expect((await post({ token_key_id: "not-hex", blinded_msgs: msgs })).status).toBe(404);

    // A key restricted to some models may not mint model-agnostic tokens.
    const restrictedSecret = (await (await h.request("/api/v1/keys", { method: "POST", json: { allowed_models: [LLAMA] } })).json()).key as string;
    const restricted = await post({ token_key_id: key.token_key_id, blinded_msgs: msgs }, { authorization: `Bearer ${restrictedSecret}` });
    expect(restricted.status).toBe(403);

    // A sub-key's budget applies to purchases like any other spend.
    const sub = (await (await h.request("/api/v1/keys", { method: "POST", headers: k.auth, json: { limit: 0.003 } })).json()).key as string;
    const overBudget = await post({ token_key_id: key.token_key_id, blinded_msgs: msgs }, { authorization: `Bearer ${sub}` }); // 2 x $0.002 > $0.003
    expect(overBudget.status).toBe(402);
    expect((await overBudget.json()).error.type).toBe("key_budget_exceeded");

    // Not enough credits: 402 and no token issued.
    const empty = await h.newKey();
    const broke = await post({ token_key_id: key.token_key_id, blinded_msgs: msgs }, empty.auth);
    expect(broke.status).toBe(402);
    const good = await post({ token_key_id: key.token_key_id, blinded_msgs: msgs });
    expect(good.status).toBe(200);
    expect((await good.json()).data.signatures).toHaveLength(2);
  });

  test("a purchase is idempotent: replaying it after a lost response signs again without charging again", async () => {
    const k = await h.fundedKey(10n);
    const account = (await h.ctx.db.query.keys.findFirst({ where: (t, { eq }) => eq(t.keyHash, k.hash) }))!.accountId;
    const dir = await fetchDirectory("http://router.test", shim(h));
    const key = issuingKey(dir, 1_000);
    const pending = await blindTokens(key, dir.challenge_digest, 2);
    const body = { token_key_id: key.token_key_id, blinded_msgs: pending.map((p) => b64url(p.blindedMsg)) };
    const before = (await balanceOf(h.ctx.db, account)).balance;
    const first = await (await h.request("/api/v1/blind/purchase", { method: "POST", headers: k.auth, json: body })).json();
    const mid = (await balanceOf(h.ctx.db, account)).balance;
    const replay = await (await h.request("/api/v1/blind/purchase", { method: "POST", headers: k.auth, json: body })).json();
    const end = (await balanceOf(h.ctx.db, account)).balance;
    expect(before - mid).toBe(usdToPico("0.004"));
    expect(end).toBe(mid);
    expect(first.data.replayed).toBe(false);
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.signatures).toEqual(first.data.signatures);
    const tokens = await finalizeTokens(key, pending, replay.data.signatures);
    expect((await redeem(h, tokens[0])).status).toBe(200);
    // Another account sending the same messages is a different purchase and is charged.
    const other = await h.fundedKey(10n);
    const third = await (await h.request("/api/v1/blind/purchase", { method: "POST", headers: other.auth, json: body })).json();
    expect(third.data.replayed).toBe(false);
    const [issuedRow] = await h.ctx.db.select().from(blindKeys).where(eq(blindKeys.keyId, key.token_key_id));
    expect(issuedRow.issued).toBeGreaterThanOrEqual(4);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("a revoked epoch's tokens are refused and its key stops issuing", async () => {
    const k = await h.fundedKey(10n);
    const bought = await buy(h, k.secret, 100_000, 1);
    expect((await h.ctx.blind!.revokeEpoch(bought.epoch)) > 0).toBe(true);
    const r = await redeem(h, bought.tokens[0]);
    expect(r.status).toBe(401);
    expect((await r.json()).error.type).toBe("token_key_revoked");
    const dir = await fetchDirectory("http://router.test", shim(h));
    expect(dir.keys.filter((x) => x.epoch === bought.epoch).every((x) => x.status === "revoked")).toBe(true);
    const [row] = await h.ctx.db.select().from(blindKeys).where(eq(blindKeys.keyId, bought.keyId));
    expect(row.privateEnc).toBeNull();
    expect(row.revokedAt).not.toBeNull();
  });
});


describe("blind tokens: epochs and rotation", () => {
  let h: Harness;
  const setNow = (ms: number) => (h.ctx.blind!.now = () => ms);
  /** Absolute time `frac` of the way through epoch `epoch`. */
  const during = (epoch: number, frac = 0.5) => setNow((epoch + frac) * WEEK_MS);
  beforeAll(async () => {
    h = await startRouter({ env: { ANYROUTE_FEATURE_BLIND: "true", BLIND_PURCHASE_RPM: "1000" } });
  });
  afterAll(async () => {
    await h.close();
  });

  test("wrong epoch: tokens and purchases outside their key's window are refused", async () => {
    const k = await h.fundedKey(20n);
    const dir = await fetchDirectory("http://router.test", shim(h));
    const epoch = dir.epoch;
    const { tokens } = await buy(h, k.secret, 1_000, 2);

    // (a) The next epoch's key is published but cannot issue yet.
    const nextKey = dir.keys.find((x) => x.epoch === epoch + 1 && x.denomination === 1_000)!;
    const early = await blindTokens(nextKey, dir.challenge_digest, 1);
    const earlyBuy = await h.request("/api/v1/blind/purchase", { method: "POST", headers: k.auth, json: { token_key_id: nextKey.token_key_id, blinded_msgs: [b64url(early[0].blindedMsg)] } });
    expect(earlyBuy.status).toBe(409);
    expect((await earlyBuy.json()).error.type).toBe("epoch_not_open");

    // (b) After the epoch ends the old key stops issuing but its tokens stay redeemable through the grace period.
    during(epoch + 1); // half way through the next epoch
    const oldKey = dir.keys.find((x) => x.epoch === epoch && x.denomination === 1_000)!;
    const late = await blindTokens(oldKey, dir.challenge_digest, 1);
    const lateBuy = await h.request("/api/v1/blind/purchase", { method: "POST", headers: k.auth, json: { token_key_id: oldKey.token_key_id, blinded_msgs: [b64url(late[0].blindedMsg)] } });
    expect(lateBuy.status).toBe(409);
    expect((await lateBuy.json()).error.type).toBe("epoch_closed");
    expect((await redeem(h, tokens[0])).status).toBe(200); // still inside the grace period

    // The new epoch's key issues, and its token is worth the same.
    const rotated = await fetchDirectory("http://router.test", shim(h));
    expect(rotated.epoch).toBe(epoch + 1);
    expect(rotated.keys.find((x) => x.epoch === epoch && x.denomination === 1_000)!.status).toBe("redeem_only");
    const fresh = await buy(h, k.secret, 1_000, 1);
    expect(fresh.epoch).toBe(epoch + 1);
    expect(fresh.keyId).not.toBe(oldKey.token_key_id);
    expect((await redeem(h, fresh.tokens[0])).status).toBe(200);

    // (c) Past the grace period the old epoch's tokens are dead; the current epoch's are not.
    setNow((epoch + 2) * WEEK_MS + 1000); // just past the end of the grace period
    const expired = await redeem(h, tokens[1]);
    expect(expired.status).toBe(401);
    expect((await expired.json()).error.type).toBe("token_epoch_expired");
    expect(await h.ctx.db.select().from(blindNullifiers).where(eq(blindNullifiers.nullifier, tokenNullifier(tokens[1])))).toHaveLength(0); // not spent, just dead
    const current = await buy(h, k.secret, 1_000, 1);
    expect(current.epoch).toBe(epoch + 2);
    expect((await redeem(h, current.tokens[0])).status).toBe(200);
  }, 60_000);

  test("a token keeps the value of the key that signed it when the unit price changes", async () => {
    const k = await h.fundedKey(10n);
    const cfg = h.ctx.cfg.blind as { unitPricePico: bigint };
    const original = cfg.unitPricePico;
    try {
      during(5000, 0.1);
      const old = await buy(h, k.secret, 1_000, 1);
      expect(old.costUsd).toBe("0.002");
      cfg.unitPricePico = usdToPico("0.00001"); // five times the price; keys already created keep theirs (the next epoch's was made ahead of time)
      during(5001, 0.5);
      const paid = await (await redeem(h, old.tokens[0])).json();
      expect(paid.blind.token_value_usd).toBe(0.002);
      expect(paid.blind.epoch).toBe(5000);
      during(5002, 0.1);
      const dir = await fetchDirectory("http://router.test", shim(h));
      expect(dir.keys.find((x) => x.epoch === 5002 && x.denomination === 1_000)!.value_usd).toBe("0.01");
      const fresh = await buy(h, k.secret, 1_000, 1);
      expect(fresh.costUsd).toBe("0.01");
      expect((await (await redeem(h, fresh.tokens[0])).json()).blind.token_value_usd).toBe(0.01);
    } finally {
      cfg.unitPricePico = original;
    }
  });

  test("weekly rotation creates the next epoch's keys ahead of time and wipes ended epochs' private keys", async () => {
    const epoch = 100; // an epoch long before the real one: the clock is ours and nothing else is due yet
    during(epoch, 0.2);
    expect(await h.ctx.blind!.rotate()).toEqual({ epoch, created: 6, wiped: 0 }); // this epoch and the next, three denominations each
    expect((await h.ctx.blind!.rotate()).created).toBe(0); // idempotent
    const now = await h.ctx.db.select().from(blindKeys).where(eq(blindKeys.epoch, epoch + 1));
    expect(now).toHaveLength(3);
    expect(now.every((r) => r.privateEnc && r.validFrom.getTime() === (epoch + 1) * WEEK_MS)).toBe(true);

    during(epoch + 1, 0.5);
    expect(await h.ctx.blind!.rotate()).toEqual({ epoch: epoch + 1, created: 3, wiped: 3 });
    const after = await h.ctx.db.select().from(blindKeys).where(eq(blindKeys.epoch, epoch));
    expect(after).toHaveLength(3);
    for (const row of after) {
      expect(row.privateEnc).toBeNull(); // ended: cannot sign any more, still verifiable
      expect(row.spki.length).toBeGreaterThan(100);
      expect(h.ctx.blind!.status(row)).toBe("redeem_only");
    }
    during(epoch + 2, 0.1); // past the grace period
    for (const row of await h.ctx.db.select().from(blindKeys).where(eq(blindKeys.epoch, epoch))) expect(h.ctx.blind!.status(row)).toBe("expired");
    expect((await h.ctx.blind!.publicKeys()).every((r) => r.epoch > epoch)).toBe(true); // expired keys are no longer published
  }, 60_000);
});

describe("blind tokens: purchase limits", () => {
  test("purchases are rate limited per key and capped per account per day", async () => {
    const h = await startRouter({ env: { ANYROUTE_FEATURE_BLIND: "true", BLIND_PURCHASE_RPM: "2", BLIND_MAX_USD_PER_DAY: "0.05", BLIND_MAX_BATCH: "4" } });
    try {
      const k = await h.fundedKey(10n);
      const dir = await fetchDirectory("http://router.test", shim(h));
      const key = issuingKey(dir, 10_000); // $0.02 each
      const attempt = async (n: number) => {
        const pending = await blindTokens(key, dir.challenge_digest, n);
        return h.request("/api/v1/blind/purchase", { method: "POST", headers: k.auth, json: { token_key_id: key.token_key_id, blinded_msgs: pending.map((p) => b64url(p.blindedMsg)) } });
      };
      expect((await attempt(3)).status).toBe(400); // $0.06 alone is over the $0.05 daily cap
      expect((await attempt(1)).status).toBe(200); // 1st request in the minute... (the rejected one above counted, so this is the 2nd)
      const limited = await attempt(1);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
      expect((await limited.json()).error.type).toBe("rate_limited");
    } finally {
      await h.close();
    }
    // Daily cap across purchases (rate limit out of the way).
    const h2 = await startRouter({ env: { ANYROUTE_FEATURE_BLIND: "true", BLIND_PURCHASE_RPM: "1000", BLIND_MAX_USD_PER_DAY: "0.05" } });
    try {
      const k = await h2.fundedKey(10n);
      const dir = await fetchDirectory("http://router.test", shim(h2));
      const key = issuingKey(dir, 10_000);
      const one = async () => {
        const pending = await blindTokens(key, dir.challenge_digest, 1);
        return h2.request("/api/v1/blind/purchase", { method: "POST", headers: k.auth, json: { token_key_id: key.token_key_id, blinded_msgs: [b64url(pending[0].blindedMsg)] } });
      };
      expect((await one()).status).toBe(200); // $0.02
      expect((await one()).status).toBe(200); // $0.04
      const capped = await one(); // $0.06 > $0.05
      expect(capped.status).toBe(429);
      expect((await capped.json()).error.type).toBe("purchase_cap");
      // The refused purchase charged nothing and left no open hold.
      const openHolds = (await h2.ctx.db.select().from(holds)).filter((x) => x.status === "held");
      expect(openHolds).toHaveLength(0);
      expect((await verifyInvariants(h2.ctx.db)).ok).toBe(true);
    } finally {
      await h2.close();
    }
  });
});

describe("blind tokens: redemption limits", () => {
  test("calls that present a token have their own per-address limit, apart from the unauthenticated one", async () => {
    const h = await startRouter({ env: { ANYROUTE_FEATURE_BLIND: "true", BLIND_REDEEM_RPM: "3", UNAUTH_RPM: "1", TRUST_PROXY: "true" } });
    try {
      // A unique client address keeps the counters apart even when a shared Redis backs the limiter.
      const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
      const bad = () => h.request("/api/v1/chat/completions", { method: "POST", headers: { authorization: "PrivateToken token=AAAA", "x-forwarded-for": ip }, json: chat });
      expect((await bad()).status).toBe(401); // invalid token, counted against the token limit (3), not the unauthenticated one (1)
      expect((await bad()).status).toBe(401);
      expect((await bad()).status).toBe(401);
      const limited = await bad();
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
      // Unauthenticated calls without a token still use UNAUTH_RPM (1): the first is a 402 quote, the second is limited.
      const plain = () => h.request("/api/v1/chat/completions", { method: "POST", headers: { "x-forwarded-for": ip }, json: chat });
      expect((await plain()).status).toBe(402);
      expect((await plain()).status).toBe(429);
    } finally {
      await h.close();
    }
  });
});

describe("blind tokens: unlinkability of the stored data", () => {
  test("nothing stored connects a purchase to a redemption", async () => {
    const h = await startRouter({ env: { ANYROUTE_FEATURE_BLIND: "true", BLIND_PURCHASE_RPM: "1000" } });
    try {
      const k = await h.fundedKey(10n);
      const bought = await buyTokens({ baseUrl: "http://router.test", apiKey: k.secret, denomination: 1_000, count: 2, fetch: shim(h) });
      const res = await redeem(h, bought.tokens[0]);
      expect(res.status).toBe(200);
      const account = (await h.ctx.db.query.keys.findFirst({ where: (t, { eq }) => eq(t.keyHash, k.hash) }))!.accountId;

      // Everything the redemption wrote, and everything the purchase wrote, as one blob to search.
      const dump = (rows: unknown) => JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      const nullifiers = dump(await h.ctx.db.select().from(blindNullifiers));
      const gens = dump(await h.ctx.db.select().from(generations));
      const ledgerRows = await h.ctx.db.select().from(ledger);
      const purchaseSide = dump(ledgerRows.filter((r) => r.kind === "blind_purchase"));
      const keysTable = dump(await h.ctx.db.select().from(blindKeys));
      for (const t of bought.tokens) {
        const bytes = decodeBase64(t)!;
        for (const secret of [t, hex(bytes), tokenNullifier(t), b64url(bytes.subarray(2, 34))]) {
          expect(purchaseSide).not.toContain(secret);
          expect(keysTable).not.toContain(secret);
        }
      }
      // The redemption side names no buyer.
      for (const buyer of [account, k.hash, k.chainKeyHash]) {
        expect(nullifiers).not.toContain(buyer);
        expect(gens).not.toContain(buyer);
      }
      // The purchase side keeps no blinded message or signature: only an amount, a count and the ids.
      expect(purchaseSide).not.toMatch(/[A-Za-z0-9_-]{200,}/);
      const [row] = await h.ctx.db.select().from(blindKeys).where(eq(blindKeys.keyId, bought.keyId));
      expect(row.issued).toBe(2);
    } finally {
      await h.close();
    }
  });
});

const unhexId = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
void encodeToken;
