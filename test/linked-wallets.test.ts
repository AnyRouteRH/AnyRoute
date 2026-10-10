import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { Hex } from "viem";
import { fakeTx, NVDA, startRouter, type Harness } from "./helpers.ts";
import { escrowDeposits, kv, teams } from "../src/db/schema.ts";
import { accountLinkedWallets } from "../src/wallets/schema.ts";
import { linkedWallets } from "../src/agents/pay.ts";
import { balanceOf } from "../src/ledger/ledger.ts";
import { clearEscrowPriceCache, pollEscrow } from "../src/pay/escrow.ts";
import { walletAccount } from "../src/wallets/store.ts";
let h: Harness;
let owner: Awaited<ReturnType<Harness["newKey"]>>;
const wallet = () => privateKeyToAccount(generatePrivateKey());
const path = "/api/v1/account/wallets";
const challenge = async (w: ReturnType<typeof wallet>, auth = owner.auth) => {
  const response = await h.request(path + "/challenge", { method: "POST", headers: auth, json: { address: w.address } });
  return { response, body: await response.json() };
};
const verify = (nonce: string, signature: string, auth = owner.auth) => h.request(path, { method: "POST", headers: auth, json: { nonce, signature } });
async function link(w: ReturnType<typeof wallet>) {
  const { response, body } = await challenge(w);
  expect(response.status).toBe(200);
  const signature = await w.signMessage({ message: body.data.message });
  const result = await verify(body.data.nonce, signature);
  expect(result.status).toBe(201);
  return { nonce: body.data.nonce, signature };
}
async function signIn(w: ReturnType<typeof wallet>) {
  const { data } = await (await h.request("/api/v1/auth/wallet/challenge", { method: "POST", json: { address: w.address } })).json();
  return h.request("/api/v1/auth/wallet", { method: "POST", json: { address: w.address, nonce: data.nonce, signature: await w.signMessage({ message: data.message }) } });
}
const unlink = (w: ReturnType<typeof wallet>, auth = owner.auth, confirm = true) => h.request(path + "/" + w.address, { method: "DELETE", headers: auth, json: { confirm } });
beforeAll(async () => {
  h = await startRouter({ env: { PAYMENTS_MODE: "escrow", ESCROW_ADDRESS: "0x00000000000000000000000000000000000e5c20", ESCROW_START_BLOCK: "1", ESCROW_TOKENS: JSON.stringify([{ symbol: "NVDA", address: NVDA, decimals: 18, feed: "0x00000000000000000000000000000000000fee01" }]), ESCROW_HAIRCUT_BPS: "300" } });
  owner = await h.newKey();
});
afterAll(async () => h?.close());

test("owner authentication, ordinary keys refused, empty by default and no response changes to unrelated accounts", async () => {
  for (const [method, endpoint, json] of [["GET", path, undefined], ["POST", path, {}], ["POST", path + "/challenge", {}], ["DELETE", path + "/0x" + "1".repeat(40), { confirm: true }]] as const) {
    expect((await h.request(endpoint, { method, ...(json ? { json } : {}) })).status).toBe(401);
  }
  expect((await (await h.request(path, { headers: owner.auth })).json()).data).toEqual([]);
  const child = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "sample-agent" } })).json();
  const auth = { authorization: `Bearer ${child.key}` };
  for (const method of ["GET", "POST"] as const) expect((await h.request(path, { method, headers: auth, ...(method === "POST" ? { json: {} } : {}) })).status).toBe(403);
  expect((await challenge(wallet(), auth)).response.status).toBe(403);
  expect((await unlink(wallet(), auth)).status).toBe(403);
  const deposits = (await (await h.request("/api/v1/escrow/deposits", { headers: owner.auth })).json()).data;
  expect(deposits.deposits).toEqual([]); expect(deposits.hint).toContain("Sign in with that wallet");
});

test("signature verified for exact origin, chain, account and purpose; replay and expired challenges refused", async () => {
  const w = wallet(), other = wallet();
  const { body } = await challenge(w);
  expect(body.data.message).toContain(`Origin: ${new URL(h.ctx.cfg.publicUrl).origin}`);
  expect(body.data.message).toContain(`Chain ID: ${h.ctx.cfg.chain.id}`);
  expect(body.data.message).toContain("Action: link wallet");
  expect(Date.parse(body.data.expires_at) - Date.now()).toBeLessThanOrEqual(300_000);
  expect((await verify(body.data.nonce, await other.signMessage({ message: body.data.message }))).status).toBe(401);
  expect((await verify(body.data.nonce, await w.signMessage({ message: body.data.message + " changed" }))).status).toBe(401);
  const stranger = await h.newKey();
  const sig = await w.signMessage({ message: body.data.message });
  expect((await verify(body.data.nonce, sig, stranger.auth)).status).toBe(401);
  expect((await verify(body.data.nonce, sig)).status).toBe(201);
  expect((await verify(body.data.nonce, sig)).status).toBe(401);
  expect((await h.ctx.db.select().from(accountLinkedWallets).where(eq(accountLinkedWallets.wallet, w.address.toLowerCase())))[0].accountId).toBe(`k_${owner.chainKeyHash.slice(2, 34)}`);
  for (const change of [{ expires: Date.now() - 1 }, { origin: "https://another.example" }, { chainId: h.ctx.cfg.chain.id + 1 }]) {
    const freshWallet = wallet();
    const fresh = await challenge(freshWallet);
    const freshSignature = await freshWallet.signMessage({ message: fresh.body.data.message });
    const [row] = await h.ctx.db.select().from(kv).where(eq(kv.key, `wallet-link:${fresh.body.data.nonce}`));
    await h.ctx.db.update(kv).set({ value: { ...(row.value as object), ...change } }).where(eq(kv.key, row.key));
    expect((await verify(fresh.body.data.nonce, freshSignature)).status).toBe(401);
  }
});

test("refuses existing accounts, own sign-in wallet, links elsewhere and account creation after linking", async () => {
  const existing = wallet(); expect((await signIn(existing)).status).toBe(201);
  const r = await challenge(existing); expect(r.response.status).toBe(409); expect(r.body.error.message).toContain("cannot be merged");
  const secondary = wallet(); await link(secondary);
  const stranger = await h.newKey();
  expect((await challenge(secondary, stranger.auth)).response.status).toBe(409);
  expect((await signIn(secondary)).status).toBe(409);
  const late = wallet(), issued = await challenge(late);
  expect((await signIn(late)).status).toBe(201);
  expect((await verify(issued.body.data.nonce, await late.signMessage({ message: issued.body.data.message }))).status).toBe(409);
});

test("linked wallet credits the owner exactly once, is eligible for agent payments; confirmed unlink preserves past credits", async () => {
  const w = wallet(); await link(w);
  const address = w.address.toLowerCase() as Hex;
  expect(await linkedWallets(h.ctx.db, `k_${owner.chainKeyHash.slice(2, 34)}`)).toContain(address);
  const listed = (await (await h.request(path, { headers: owner.auth })).json()).data;
  expect(listed.find((l: { wallet: string }) => l.wallet === address).linked_at).toMatch(/^\d{4}-/);
  clearEscrowPriceCache(); h.chain.feedReading = { answer: 180n * 10n ** 8n, decimals: 8, updatedAt: Math.floor(Date.now() / 1000) };
  const send = () => { h.chain.escrowHead += 10n; const t = { token: NVDA as Hex, from: address, value: 10n ** 18n, txHash: fakeTx(), logIndex: 0, blockNumber: h.chain.escrowHead - 3n }; h.chain.escrowLogs.push(t); return t; };
  const t = send(); const before = (await balanceOf(h.ctx.db, `k_${owner.chainKeyHash.slice(2, 34)}`)).balance;
  expect(await pollEscrow(h.ctx)).toMatchObject({ credited: 1 });
  expect((await balanceOf(h.ctx.db, `k_${owner.chainKeyHash.slice(2, 34)}`)).balance - before).toBe(174_600_000_000_000n);
  expect((await balanceOf(h.ctx.db, walletAccount(address))).balance).toBe(0n);
  expect((await h.ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.txHash, t.txHash)))[0].accountId).toBe(`k_${owner.chainKeyHash.slice(2, 34)}`);
  expect((await pollEscrow(h.ctx)).credited).toBe(0);
  expect((await unlink(w, owner.auth, false)).status).toBe(400);
  expect((await unlink(w, (await h.newKey()).auth)).status).toBe(404);
  expect((await unlink(w)).status).toBe(200);
  expect(await linkedWallets(h.ctx.db, `k_${owner.chainKeyHash.slice(2, 34)}`)).not.toContain(address);
  send(); expect((await pollEscrow(h.ctx)).credited).toBe(1);
  expect((await balanceOf(h.ctx.db, walletAccount(address))).balance).toBe(174_600_000_000_000n);
  expect((await balanceOf(h.ctx.db, `k_${owner.chainKeyHash.slice(2, 34)}`)).balance - before).toBe(174_600_000_000_000n);
  const deposits = (await (await h.request("/api/v1/escrow/deposits", { headers: owner.auth })).json()).data.deposits;
  expect(deposits.some((d: { tx_hash: string }) => d.tx_hash === t.txHash)).toBe(true);
});

test("a previously issued challenge refuses a wallet credited before verification", async () => {
  const w = wallet(), issued = await challenge(w);
  h.chain.escrowHead += 10n;
  h.chain.escrowLogs.push({ token: NVDA as Hex, from: w.address.toLowerCase() as Hex, value: 10n ** 18n, txHash: fakeTx(), logIndex: 0, blockNumber: h.chain.escrowHead - 3n });
  await pollEscrow(h.ctx);
  expect((await verify(issued.body.data.nonce, await w.signMessage({ message: issued.body.data.message }))).status).toBe(409);
});

test("fast credit stays with the linked account through unlink, final settlement and a reorganization", async () => {
  const cfg = h.ctx.cfg.fastCredit.enabled, lag = h.chain.escrowFinalLag;
  try {
    h.ctx.cfg.fastCredit.enabled = true;
    h.chain.escrowFinalLag = 50n;
    h.chain.escrowHead += 100n;
    const w = wallet(); await link(w);
    const address = w.address.toLowerCase() as Hex;
    const accountId = `k_${owner.chainKeyHash.slice(2, 34)}`;
    const before = (await balanceOf(h.ctx.db, accountId)).balance;
    const txHash = fakeTx(), blockNumber = h.chain.escrowHead - 20n;
    h.chain.escrowLogs.push({ token: NVDA as Hex, from: address, value: 10n ** 18n, txHash, logIndex: 0, blockNumber });
    await pollEscrow(h.ctx);
    expect((await balanceOf(h.ctx.db, accountId)).balance - before).toBe(25_000_000_000_000n);
    expect((await unlink(w)).status).toBe(200);
    h.chain.escrowFinalLag = 0n;
    await pollEscrow(h.ctx);
    expect((await balanceOf(h.ctx.db, accountId)).balance - before).toBe(174_600_000_000_000n);
    expect((await balanceOf(h.ctx.db, walletAccount(address))).balance).toBe(0n);
    h.chain.reorg(blockNumber, logs => logs.filter(l => l.txHash !== txHash));
    await pollEscrow(h.ctx);
    expect((await balanceOf(h.ctx.db, accountId)).balance).toBe(before);
    expect((await balanceOf(h.ctx.db, walletAccount(address))).balance).toBe(0n);
  } finally { h.ctx.cfg.fastCredit.enabled = cfg; h.chain.escrowFinalLag = lag; }
});


test("refuses verified organisation wallets linked to other accounts, and preserves this account’s separate organisation payment eligibility", async () => {
  const elsewhere = wallet(), own = wallet(), stranger = await h.newKey();
  await h.ctx.db.insert(teams).values([
    { id: "e154-other-organisation", name: "Other organisation", ownerAccount: `k_${stranger.chainKeyHash.slice(2, 34)}`, ownerAddress: elsewhere.address.toLowerCase(), ownerVerifiedAt: new Date() },
    { id: "e154-own-organisation", name: "Own organisation", ownerAccount: `k_${owner.chainKeyHash.slice(2, 34)}`, ownerAddress: own.address.toLowerCase(), ownerVerifiedAt: new Date() },
  ]);
  const result = await challenge(elsewhere);
  expect(result.response.status).toBe(409); expect(result.body.error.message).toContain("another account");
  await link(own);
  expect((await unlink(own)).status).toBe(200);
  expect(await linkedWallets(h.ctx.db, `k_${owner.chainKeyHash.slice(2, 34)}`)).toContain(own.address.toLowerCase());
});
