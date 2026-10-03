import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { startRouter, type Harness } from "./helpers.ts";
import { balanceOf, verifyInvariants } from "../src/ledger/ledger.ts";
import { generations, x402PaidResults } from "../src/db/schema.ts";
import { PaidResultStore, expirePaidResults, paidResultStore, recoveryMessage } from "../src/pay/recovery.ts";
import { requestHash } from "../src/api/chat.ts";
import { sha256 } from "../src/lib/util.ts";
import { unb64, v2Payment, xPayment, type Req, type V2Required } from "./support/x402-client.ts";

const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const PAY_TO = "0x00000000000000000000000000000000000d0402";
const CHAT = "/api/v1/chat/completions";
const acct = (a: string) => `w_${a.slice(2).toLowerCase()}`;
const chatBody = (content: string, extra: Record<string, unknown> = {}) => ({ model: LLAMA, max_tokens: 50, messages: [{ role: "user", content }], ...extra });
const bytesOf = async (r: Response) => new Uint8Array(await r.arrayBuffer());

/** What a client does to recover: sign the recovery message for its own authorization with the paying key. */
const recoverySignature = (signer: PrivateKeyAccount, nonce: string, payer: string = signer.address) => signer.signMessage({ message: recoveryMessage(4663, payer, nonce) });

describe("x402 payment recovery (PAYMENT-RECOVERY)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ env: { X402_PAY_TO: PAY_TO } });
    h.chain.noCallPay = true;
  });
  afterAll(async () => h.close());

  const send = (json: unknown, headers: Record<string, string>, path = CHAT) => h.request(path, { method: "POST", headers, json });
  /** A paid call: ask, sign the requirement (v1 X-PAYMENT, or v2 PAYMENT-SIGNATURE) and pay. */
  const paid = async (o: { json?: unknown; path?: string; v2?: boolean } = {}) => {
    const json = o.json ?? chatBody("recover " + randomBytes(4).toString("hex"));
    const path = o.path ?? CHAT;
    const ask = await h.request(path, { method: "POST", json });
    expect(ask.status).toBe(402);
    const pay = o.v2 ? await v2Payment(unb64(ask.headers.get("payment-required")) as V2Required) : await xPayment((await ask.json()).accepts[0] as Req);
    const header = o.v2 ? { "payment-signature": pay.header } : { "x-payment": pay.header };
    const first = await send(json, header, path);
    return { json, path, pay, header, first };
  };
  const rowOf = async (payer: string, nonce: string) => (await h.ctx.db.select().from(x402PaidResults).where(and(eq(x402PaidResults.payer, payer.toLowerCase()), eq(x402PaidResults.nonce, nonce.toLowerCase()))))[0];

  test("a lost answer is sent again byte for byte, settles nothing twice and charges nothing twice", async () => {
    const { json, pay, header, first } = await paid();
    expect(first.status).toBe(200);
    const original = await bytesOf(first);
    const relays = h.chain.x402Relays.length;
    const balance = (await balanceOf(h.ctx.db, acct(pay.signer.address))).balance;
    const calls = (await h.ctx.db.select({ n: sql<number>`count(*)::int` }).from(generations))[0].n;

    const again = await send(json, { ...header, "payment-recovery": await recoverySignature(pay.signer, pay.authorization.nonce) });
    expect(again.status).toBe(200);
    expect(await bytesOf(again)).toEqual(original);
    for (const name of ["x-payment-response", "payment-response", "x-receipt-id", "content-type"]) expect(again.headers.get(name)).toBe(first.headers.get(name));
    // A second recovery is the same answer again.
    const twice = await send(json, { ...header, "payment-recovery": await recoverySignature(pay.signer, pay.authorization.nonce) });
    expect(await bytesOf(twice)).toEqual(original);

    expect(h.chain.x402Relays.length).toBe(relays);
    expect((await balanceOf(h.ctx.db, acct(pay.signer.address))).balance).toBe(balance);
    expect((await h.ctx.db.select({ n: sql<number>`count(*)::int` }).from(generations))[0].n).toBe(calls);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);

    // Postgres keeps hashes and a key name; the answer is sealed elsewhere.
    const row = await rowOf(pay.signer.address, pay.authorization.nonce);
    const receipt = JSON.parse(new TextDecoder().decode(original)).receipt.payload;
    expect(row).toMatchObject({ payer: pay.signer.address.toLowerCase(), nonce: pay.authorization.nonce.toLowerCase(), requestSha256: requestHash(json as Record<string, unknown>), responseSha256: sha256(original) });
    expect(row.requestSha256).toBe(receipt.request_sha256);
    expect(row.bodyRef).toMatch(/^x402paid:[0-9a-f]{64}$/);
    const content = JSON.parse(new TextDecoder().decode(original)).choices[0].message.content as string;
    expect(content.length).toBeGreaterThan(0);
    expect(JSON.stringify(row)).not.toContain(content);
    const sealed = (await paidResultStore(h.ctx).sealedAt(row.bodyRef))!;
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain(content);
    expect(Buffer.from(sealed.split(".")[3], "base64url").toString("utf8")).not.toContain(content);
  });

  test("v2 payments recover too, and a streamed answer comes back as the same event stream", async () => {
    const { json, pay, header, first } = await paid({ v2: true, json: chatBody("stream recover", { stream: true }) });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/event-stream");
    const original = await bytesOf(first);
    expect(new TextDecoder().decode(original)).toContain("[DONE]");
    const relays = h.chain.x402Relays.length;
    const again = await send(json, { ...header, "payment-recovery": await recoverySignature(pay.signer, pay.authorization.nonce) });
    expect(again.status).toBe(200);
    expect(again.headers.get("content-type")).toContain("text/event-stream");
    expect(again.headers.get("payment-response")).toBe(first.headers.get("payment-response"));
    expect(await bytesOf(again)).toEqual(original);
    expect(h.chain.x402Relays.length).toBe(relays);
  });

  test("embeddings recover byte for byte", async () => {
    const { json, path, pay, header, first } = await paid({ path: "/api/v1/embeddings", json: { model: "acme/embed-small", input: ["recover me"] } });
    expect(first.status).toBe(200);
    const original = await bytesOf(first);
    const again = await send(json, { ...header, "payment-recovery": await recoverySignature(pay.signer, pay.authorization.nonce) }, path);
    expect(again.status).toBe(200);
    expect(await bytesOf(again)).toEqual(original);
  });

  test("only the payer can recover: another signer, another nonce's signature or no valid signature is refused", async () => {
    const { json, pay, header, first } = await paid();
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    const relays = h.chain.x402Relays.length;
    const stranger = privateKeyToAccount(generatePrivateKey());
    const bad = [
      await recoverySignature(stranger, pay.authorization.nonce, pay.signer.address), // someone else signs the payer's message
      await recoverySignature(pay.signer, `0x${randomBytes(32).toString("hex")}`), // the payer, for another authorization
      "0x1234",
    ];
    for (const signature of bad) {
      const r = await send(json, { ...header, "payment-recovery": signature });
      expect(r.status).toBe(401);
      const e = (await r.json()).error;
      expect(e.type).toBe("invalid_payment_recovery");
      expect(e.message).toContain(recoveryMessage(4663, pay.signer.address, pay.authorization.nonce));
    }
    // Without the payment it recovers nothing either.
    const bare = await send(json, { "payment-recovery": await recoverySignature(pay.signer, pay.authorization.nonce) });
    expect(bare.status).toBe(400);
    expect((await bare.json()).error.type).toBe("invalid_payment_recovery");
    expect(h.chain.x402Relays.length).toBe(relays);
  });

  test("a recovery for a different request is refused and settles nothing", async () => {
    const { pay, header, first } = await paid();
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    const relays = h.chain.x402Relays.length;
    const r = await send(chatBody("a different question"), { ...header, "payment-recovery": await recoverySignature(pay.signer, pay.authorization.nonce) });
    expect(r.status).toBe(409);
    expect((await r.json()).error.type).toBe("payment_request_mismatch");
    expect(h.chain.x402Relays.length).toBe(relays);
  });

  test("an authorization that was never settled has nothing to recover, and recovery does not settle it", async () => {
    const json = chatBody("never paid");
    const ask = await h.request(CHAT, { method: "POST", json });
    const pay = await xPayment((await ask.json()).accepts[0] as Req);
    const relays = h.chain.x402Relays.length;
    const r = await send(json, { "x-payment": pay.header, "payment-recovery": await recoverySignature(pay.signer, pay.authorization.nonce) });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toMatchObject({ type: "payment_recovery_not_found", metadata: { settled: false, transaction: null } });
    expect(h.chain.x402Relays.length).toBe(relays);
    // It still pays normally afterwards.
    expect((await send(json, { "x-payment": pay.header })).status).toBe(200);
  });

  test("a call the client gave up on is finished and kept, so its answer can be recovered", async () => {
    const json = chatBody("slow answer");
    const ask = await h.request(CHAT, { method: "POST", json });
    const pay = await xPayment((await ask.json()).accepts[0] as Req);
    const gaveUp = new AbortController();
    h.mocks.alpha.cfg.delayMs = 300;
    try {
      const pending = h.request(CHAT, { method: "POST", headers: { "x-payment": pay.header }, json, signal: gaveUp.signal });
      setTimeout(() => gaveUp.abort(), 50);
      const served = await pending;
      expect(served.status).toBe(200);
      await served.arrayBuffer();
    } finally {
      h.mocks.alpha.cfg.delayMs = 0;
    }
    const again = await send(json, { "x-payment": pay.header, "payment-recovery": await recoverySignature(pay.signer, pay.authorization.nonce) });
    expect(again.status).toBe(200);
    expect(JSON.parse(await again.text()).receipt.payload.payer).toBe(pay.signer.address.toLowerCase());
  });

  test("after 24 hours nothing is sent again, and the expiry job deletes the row and the sealed answer", async () => {
    const { json, pay, header, first } = await paid();
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    const row = await rowOf(pay.signer.address, pay.authorization.nonce);
    expect(await paidResultStore(h.ctx).sealedAt(row.bodyRef)).toBeTruthy();
    // A fresh row is not touched by the job.
    expect((await expirePaidResults(h.ctx)).expired).toBe(0);
    await h.ctx.db.update(x402PaidResults).set({ createdAt: new Date(Date.now() - 24 * 3_600_000 - 1_000) }).where(eq(x402PaidResults.bodyRef, row.bodyRef));
    const late = await send(json, { ...header, "payment-recovery": await recoverySignature(pay.signer, pay.authorization.nonce) });
    expect(late.status).toBe(404);
    expect((await late.json()).error).toMatchObject({ type: "payment_recovery_not_found", metadata: { settled: true } });
    expect((await expirePaidResults(h.ctx)).expired).toBe(1);
    expect(await rowOf(pay.signer.address, pay.authorization.nonce)).toBeUndefined();
    expect(await paidResultStore(h.ctx).sealedAt(row.bodyRef)).toBeNull();
    // Still never relayed twice: the original payment stays used.
    expect((await send(json, header)).status).toBe(402);
  });

  test("/status says recovery is available, with its header, signed message and 24-hour window", async () => {
    const x402 = (await (await h.request("/api/v1/status")).json()).data.per_call.x402;
    expect(x402.recovery).toEqual({ available: true, header: "PAYMENT-RECOVERY", message: "anyroute:x402-recovery:4663:<payer>:<nonce>", ttl_s: 86_400 });
  });
});

describe("the sealed answer store", () => {
  test("with Redis an answer is set once with a 24-hour expiry, opens only under its own scope, and is deleted", async () => {
    const kv = new Map<string, string>();
    const sets: unknown[][] = [];
    const redis = {
      set: async (...a: string[]) => (sets.push(a), kv.has(a[0]) ? null : (kv.set(a[0], a[1]), "OK")),
      get: async (k: string) => kv.get(k) ?? null,
      del: async (...ks: string[]) => ks.filter((k) => kv.delete(k)).length,
    };
    const store = new PaidResultStore("fixture-secret", redis as never);
    const kept = { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"answer":"kept text"}').toString("base64") };
    expect(await store.put("x402paid:one", "payer:nonce:request", kept)).toBe(true);
    expect(sets[0].slice(2)).toEqual(["PX", 86_400_000, "NX"]);
    expect(await store.put("x402paid:one", "payer:nonce:request", { ...kept, status: 500 })).toBe(false);
    expect(kv.get("x402paid:one")).not.toContain("kept text");
    expect(await store.get("x402paid:one", "payer:nonce:request")).toEqual(kept);
    await expect(store.get("x402paid:one", "payer:nonce:another request")).rejects.toThrow();
    await store.del(["x402paid:one"]);
    expect(await store.get("x402paid:one", "payer:nonce:request")).toBeNull();
  });
});

describe("x402 payment recovery with x402 off", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter()));
  afterAll(async () => h.close());

  test("PAYMENT-RECOVERY is refused and /status says recovery is not available", async () => {
    const r = await h.request(CHAT, { method: "POST", headers: { "x-payment": "e30=", "payment-recovery": "0x00" }, json: chatBody("off") });
    expect(r.status).toBe(400);
    expect((await r.json()).error.type).toBe("x402_unavailable");
    expect((await (await h.request("/api/v1/status")).json()).data.per_call.x402.recovery.available).toBe(false);
  });
});
