import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { startRouter, type Harness } from "./helpers.ts";
import { verifyInvariants, post } from "../src/ledger/ledger.ts";
import { usdToPico } from "../src/lib/money.ts";
import { BLIND_POOL } from "../src/blind/redeem.ts";
import { generations } from "../src/db/schema.ts";
import { eq } from "drizzle-orm";
import { blindTokens as libBlind, finalizeTokens as libFinalize, fetchDirectory, issuingKey } from "../src/blind/client.ts";
import { blindTokens as pageBlind, finalizeTokens as pageFinalize } from "../web/lib/blind-rsa.js";
import { PurseFlow } from "../web/lib/purse.js";
import { parseTokenFile as pageParse, serializeTokenFile as pageSerialize } from "../web/lib/purse-file.js";
import { openPurse } from "../web/lib/purse-store.js";
import { ApiError } from "../web/lib/api.js";
import { fakeIndexedDB, fakeStorage, fakeWallet } from "../web/tests/purse-helpers.mjs";
import { parseTokenFile as sdkParse, serializeTokenFile as sdkSerialize } from "../packages/client/src/index.ts";
import { authorizationHeader, b64url, decodeBase64 } from "../src/blind/privacy-token.ts";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The Private tokens page (web/lib/purse.js, blind-rsa.js, purse-file.js) against the real router: the page's own blinding
// is signed by the router's issuer, the tokens it finishes are accepted by the router, the key it made is switched off,
// and the token file it writes is read by the SDK. The router side is unchanged; this only checks the two fit.

setDefaultTimeout(120_000);

const chat = { model: "meta-llama/llama-3.3-70b-instruct", messages: [{ role: "user", content: "hello" }], max_tokens: 20 };

/** The router's own app as the page's `api`, with the page's error type. */
const routerApi = (h: Harness) =>
  async (path: string, o: { key?: string; method?: string; body?: unknown } = {}) => {
    const res = await h.app.request(path, {
      method: o.method ?? "GET",
      headers: { ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.key ? { authorization: `Bearer ${o.key}` } : {}) },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err: any = new ApiError(res.status, json?.error?.message ?? `Request failed (${res.status}).`, json?.error?.type ?? "error", json?.error?.metadata);
      err.retryAfter = res.headers.get("retry-after");
      throw err;
    }
    return json;
  };

describe("Private tokens page against the router", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ env: { ANYROUTE_FEATURE_BLIND: "true", BLIND_PURCHASE_RPM: "1000", CREDITS_ADDRESS: "0x" + "c1".repeat(20), USDG_ADDRESS: "0x" + "d2".repeat(20) } });
  });
  afterAll(async () => {
    await h.close();
  });

  const page = (walletFlags: Record<string, unknown> = {}) => {
    const session = fakeStorage();
    const idb = fakeIndexedDB();
    const wallet = fakeWallet(walletFlags);
    const flow = new PurseFlow({ api: routerApi(h), wallet, session, openPurse: () => openPurse({ indexedDB: idb }), sleep: async () => undefined });
    return { flow, session, idb, wallet };
  };

  test("USDG: a one-time key is funded from a wallet, bought with, and switched off; the tokens are spendable once", async () => {
    const { flow, session, wallet } = page();
    await flow.init();
    expect(flow.info.blind).toBe("available");
    await flow.begin("usdg");
    const secret = flow.recoveryKey();
    const keyRow = await h.ctx.db.query.keys.findFirst({ where: (t, { eq }) => eq(t.keyHash, flow.meta.hash) });
    expect(keyRow?.disabled).toBe(false);
    expect(keyRow?.management).toBe(true);

    // The wallet is handed the router's own approve + deposit transactions; the harness chain then confirms the deposit.
    wallet.flags.onSend = async (txs: { to: string }[]) => {
      expect(txs).toHaveLength(2);
      await h.chain.deposit(h.ctx, flow.state.keyHash, 3_000_000n);
    };
    await flow.payUsdg("3");
    expect(await flow.waitForCredit()).toBe(true);
    expect(flow.state.spendablePico).toBe(usdToPico("3").toString());

    await flow.mint("medium");
    expect(flow.state.phase).toBe("discarded");
    const held = flow.info.tokens;
    expect(held.length).toBe(150); // 3.00 / 0.02
    expect(held.every((t: any) => t.value_usd === "0.02")).toBe(true);

    // The key is dead: memory, tab storage and the router.
    expect(flow.getSnapshot().holdsKey).toBe(false);
    expect([...session.map.keys()]).toEqual([]);
    const after = await h.ctx.db.query.keys.findFirst({ where: (t, { eq }) => eq(t.keyHash, keyRow!.keyHash) });
    expect(after?.disabled).toBe(true);
    expect((await h.request("/api/v1/credits", { headers: { authorization: `Bearer ${secret}` } })).status).toBe(401);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);

    // A token from the page is accepted by the router, once, and the call records no key, account or wallet.
    const first = held[0].token;
    const res = await h.request("/api/v1/chat/completions", { method: "POST", headers: { authorization: authorizationHeader(decodeBase64(first)!) }, json: chat });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.blind.denomination).toBe(10_000);
    expect(out.receipt.payload.payer).toBeNull();
    expect(JSON.stringify(out)).not.toContain(keyRow!.keyHash);
    expect(JSON.stringify(out)).not.toContain(keyRow!.accountId);
    const [gen] = await h.ctx.db.select().from(generations).where(eq(generations.id, out.id));
    expect([gen.accountId, gen.keyHash]).toEqual([BLIND_POOL, null]);
    const again = await h.request("/api/v1/chat/completions", { method: "POST", headers: { authorization: authorizationHeader(decodeBase64(first)!) }, json: chat });
    expect(again.status).toBe(401);
    expect((await again.json()).error.type).toBe("token_spent");

    // The token file the page writes is read by the SDK, and the SDK's file is read by the page.
    const file = flow.tokenFile();
    expect(file.name).toBe("anyroute-tokens.json");
    const viaSdk = sdkParse(file.text);
    expect(viaSdk.tokens.map((t) => t.token).sort()).toEqual(held.map((t: any) => t.token).sort());
    expect(viaSdk.unconfirmed).toEqual([]);
    expect(pageParse(sdkSerialize(viaSdk)).tokens).toEqual(viaSdk.tokens);
    expect(sdkSerialize(sdkParse(pageSerialize(pageParse(file.text))))).toBe(file.text);
  });

  // The private proxy keeps its tokens in ~/.anyroute/tokens.json in this same format. Its reader (packages/private/src/store.ts
  // on the private-proxy branch) accepts an entry only when all of these hold; the file the page writes must pass it.
  const proxyAccepts = (t: any) =>
    !!t && typeof t.token === "string" && /^[A-Za-z0-9_-]{300,}$/.test(t.token) && typeof t.key_id === "string" && Number.isInteger(t.denomination) && Number.isInteger(t.epoch) && typeof t.value_usd === "string" && typeof t.redeem_until === "string" && !Number.isNaN(Date.parse(t.redeem_until)) && typeof t.bought_at === "string";

  test("the file the page writes is the file the private proxy reads", async () => {
    const k = await h.fundedKey(1n);
    const { flow, wallet } = page();
    await flow.init();
    await flow.begin("usdg");
    wallet.flags.onSend = async () => h.chain.deposit(h.ctx, flow.state.keyHash, 1_000_000n);
    await flow.payUsdg("1");
    await flow.waitForCredit();
    await flow.mint("balanced");
    const doc = JSON.parse(flow.tokenFile().text);
    expect(Object.keys(doc)).toEqual(["version", "tokens", "unconfirmed"]);
    expect(doc.version).toBe(1);
    expect(doc.tokens.length).toBeGreaterThan(0);
    expect(doc.tokens.every(proxyAccepts)).toBe(true);
    expect(doc.unconfirmed).toEqual([]);
    expect(k.secret).toBeTruthy();

    // When the proxy's own store is in this tree, read the same file with it: it must see every token, and lease one.
    const storePath = path.join(import.meta.dir, "..", "packages", "private", "src", "store.ts");
    if (existsSync(storePath)) {
      const { TokenStore } = await import(storePath);
      const dir = mkdtempSync(path.join(tmpdir(), "tokens-"));
      try {
        writeFileSync(path.join(dir, "tokens.json"), flow.tokenFile().text, { mode: 0o600 });
        const store = new TokenStore(dir);
        const summary = await store.summary();
        expect(summary.usable).toBe(doc.tokens.length);
        const lease = await store.lease();
        expect(lease?.token.token).toBeTruthy();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("the page's blinding and the SDK library's blinding finish each other's requests", async () => {
    const k = await h.fundedKey(2n);
    const base = "http://router.test";
    const shim = (async (input: unknown, init?: RequestInit) => h.app.request(new URL(String(input), base).pathname, init)) as never;
    const dir = await fetchDirectory(base, shim);
    const key = issuingKey(dir, 10_000);
    const buy = async (pending: { blindedMsg: Uint8Array }[]) => {
      const res = await h.request("/api/v1/blind/purchase", { method: "POST", headers: k.auth, json: { token_key_id: key.token_key_id, blinded_msgs: pending.map((p) => b64url(p.blindedMsg)) } });
      expect(res.status).toBe(200);
      return (await res.json()).data.signatures as string[];
    };
    // page blinds, library unblinds
    const p1 = await pageBlind(key, dir.challenge_digest, 2);
    const t1 = await libFinalize(key, p1, await buy(p1));
    // library blinds, page unblinds
    const p2 = await libBlind(key, dir.challenge_digest, 2);
    const t2 = await pageFinalize(key, p2, await buy(p2));
    for (const t of [...t1, ...t2]) {
      const res = await h.request("/api/v1/chat/completions", { method: "POST", headers: { authorization: authorizationHeader(decodeBase64(t)!) }, json: chat });
      expect(res.status).toBe(200);
    }
  });

  test("$ANYR route: the wallet's key is made with a real signature, sees only the newly credited amount, and is switched off", async () => {
    const account = privateKeyToAccount(("0x" + "5a".repeat(32)) as `0x${string}`);
    const { flow, wallet } = page({ address: account.address, sign: (message: string) => account.signMessage({ message }) });
    await flow.init();
    await flow.begin("anyr");
    expect(flow.wallet.toLowerCase()).toBe(account.address.toLowerCase());
    const accountId = `w_${account.address.slice(2).toLowerCase()}`;
    const keyRow = await h.ctx.db.query.keys.findFirst({ where: (t, { eq }) => eq(t.keyHash, flow.meta.hash) });
    expect(keyRow?.accountId).toBe(accountId);

    // $5.00 was on the account already; $0.60 arrives from escrow.
    await post(h.ctx.db, { accountId, amount: usdToPico("5"), kind: "deposit", ref: "earlier-balance", description: "earlier" });
    flow.meta.baselinePico = usdToPico("5").toString();
    flow.markSent(0.6);
    await post(h.ctx.db, { accountId, amount: usdToPico("0.6"), kind: "credit", ref: "escrow-credit", description: "escrow" });
    await flow.useArrivedBalance();
    expect(flow.state.spendablePico).toBe(usdToPico("0.6").toString());

    await flow.mint("small");
    expect(flow.state.phase).toBe("discarded");
    const bought = flow.info.tokens.reduce((n: bigint, t: any) => n + usdToPico(t.value_usd), 0n);
    expect(bought).toBeGreaterThan(usdToPico("0.598"));
    expect(bought).toBeLessThanOrEqual(usdToPico("0.6"));
    const { balanceOf } = await import("../src/ledger/ledger.ts");
    expect((await balanceOf(h.ctx.db, accountId)).balance).toBeGreaterThanOrEqual(usdToPico("5"));
    const after = await h.ctx.db.query.keys.findFirst({ where: (t, { eq }) => eq(t.keyHash, keyRow!.keyHash) });
    expect(after?.disabled).toBe(true);
    expect(wallet.calls).toContain("personalSign");
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("a purchase interrupted after the router charged is finished by sending the same request, and the router charges once", async () => {
    const { flow, wallet } = page();
    await flow.init();
    await flow.begin("usdg");
    wallet.flags.onSend = async () => h.chain.deposit(h.ctx, flow.state.keyHash, 1_000_000n);
    await flow.payUsdg("1");
    await flow.waitForCredit();
    // The first response is lost after the router handled it.
    const real = flow.d.api;
    let lost = false;
    flow.d.api = async (path: string, o: any) => {
      const r = await real(path, o);
      if (path === "/api/v1/blind/purchase" && !lost) {
        lost = true;
        throw new ApiError(0, "The Anyroute API could not be reached.", "unreachable");
      }
      return r;
    };
    await flow.mint("large");
    expect(lost).toBe(true);
    expect(flow.info.tokens).toHaveLength(5);
    expect(flow.state.phase).toBe("discarded");
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });
});
