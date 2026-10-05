import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createPublicClient, custom, encodePacked, keccak256, recoverTypedDataAddress, toBytes, toHex, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApp } from "../src/app.ts";
import { ChainService, type AllowanceAuthorization, type ChargeAuthorization, type DecodedLog, type EscrowReceipt, type EscrowTransfer, type FeedReading } from "../src/chain/service.ts";
import { ALLOWANCE_TYPES, CHARGE_TYPES } from "../src/pay/paywith.ts";
import { loadConfig } from "../src/config.ts";
import { providers } from "../src/db/schema.ts";
import { runRegistry } from "../src/services/registry.ts";
import { serveMockProvider, type MockConfig } from "../src/providers/mock.ts";
import { recordEvents, processEvents } from "../src/chain/indexer.ts";
import { encrypt } from "../src/lib/util.ts";
import { RedisRateLimiter } from "../src/lib/ratelimit.ts";
import type { Ctx } from "../src/context.ts";

export const ADMIN = "test-admin-token-0123456789abcdef";
export const NVDA = "0x00000000000000000000000000000000000000aa";
export const ADDR = {
  credits: "0x00000000000000000000000000000000000c0001",
  callPay: "0x00000000000000000000000000000000000c0002",
  payWithStock: "0x00000000000000000000000000000000000c0003",
  providerBond: "0x00000000000000000000000000000000000c0004",
  receiptAnchor: "0x00000000000000000000000000000000000c0005",
} as const;

let logCounter = 0;
export const fakeTx = () => ("0x" + (++logCounter).toString(16).padStart(64, "0")) as Hex;

/** In-memory stand-in for the deployed contracts, driven through ChainService's public surface. */
export class FakeChain extends ChainService {
  payments = new Map<string, { nonce: Hex; payer: Hex; amount: bigint; pending?: boolean }>();
  fair18: bigint | null = 225n * 10n ** 18n;
  sessions = new Map<string, { wallet: Hex; token: Hex; capRawPerDay: bigint; spentRawToday: bigint; dayStart: bigint; active: boolean; epoch?: bigint }>();
  /** PayWithStock allowances (same checks as the contract) and used charge nonces / usage commitments. */
  allowances = new Map<string, { auth: AllowanceAuthorization; spentRaw: bigint }>();
  allowanceNonces = new Map<string, bigint>();
  chargeNonces = new Set<string>();
  commitments = new Set<string>();
  anchors: { root: Hex; fromTs: number; toTs: number; count: number }[] = [];
  spentRoots: { root: Hex; asOf: number; total: bigint }[] = [];
  keys = new Map<string, string>();
  payCalls: { keyHash: Hex; usdg: bigint; mode: "signature" | "allowance"; usageCommitment: Hex }[] = [];
  slashProposals: unknown[] = [];
  failPayCall = false;

  constructor(env: Record<string, unknown>) {
    const cfg = loadConfig(env);
    super(cfg);
    // Code that reads the chain client directly (not through an overridden method) must not reach the real RPC:
    // that made results depend on the network and stalled tests on a slow link. None of the fixture contracts
    // exist, so answer as a chain without them would: the configured chain id, no code and empty call data.
    (this as { client: PublicClient }).client = createPublicClient({
      chain: this.chain,
      cacheTime: 0,
      transport: custom({
        async request({ method }: { method: string }) {
          if (method === "eth_chainId") return toHex(cfg.chain.id);
          if (method === "eth_call" || method === "eth_getCode") return "0x";
          if (method === "eth_getTransactionReceipt" || method === "eth_getTransactionByHash") return null;
          throw new Error(`FakeChain has no RPC for ${method}; override the ChainService method or stub ctx.chain.client.`);
        },
      }, { retryCount: 0 }),
    });
  }
  /** Run without the CallPay contract, as an x402-only router does. */
  noCallPay = false;
  override address(name: string) {
    if (name === "callPay" && this.noCallPay) return undefined;
    return (ADDR as Record<string, Hex>)[name];
  }
  override roleAddress() {
    return "0x0000000000000000000000000000000000000001" as Hex;
  }
  override async blockNumber() {
    return this.escrowHead;
  }
  override async blockTimestamp() {
    return Math.floor(Date.now() / 1000);
  }
  override async readCallPayments(txHash: Hex) {
    const p = this.payments.get(txHash);
    if (!p) throw Object.assign(new Error("not found"), {});
    if (p.pending) return { pending: true as const, confirmations: 0 };
    return [{ nonce: p.nonce, payer: p.payer, amount: p.amount, blockNumber: 1n, confirmations: 5, logIndex: 0 }];
  }
  /** x402: USDG balances, used EIP-3009 nonces and the authorizations relayed by transferWithAuthorization. */
  usdgBalances = new Map<string, bigint>();
  usedAuthorizations = new Set<string>();
  x402Relays: { from: Hex; to: Hex; value: bigint; nonce: Hex; hash: Hex; role: "router" | "facilitator" }[] = [];
  failX402Relay = false;
  /** Native gas of every relaying key (the facilitator's balance floor reads it), and the gas a relay reports. */
  relayBalanceWei = 10n ** 18n;
  relayGas = { gasUsed: 80_000n, effectiveGasPrice: 10_000_000n }; // 0.01 gwei
  override async nativeBalance() {
    return this.relayBalanceWei;
  }
  override async gasPrice() {
    return this.relayGas.effectiveGasPrice;
  }
  override async usdgDomain() {
    return { name: "Global Dollar", version: "1" };
  }
  override async usdgBalance(of: Hex) {
    return this.usdgBalances.get(of.toLowerCase()) ?? 10n ** 12n;
  }
  override async authorizationUsed(authorizer: Hex, nonce: Hex) {
    return this.usedAuthorizations.has(`${authorizer}:${nonce}`.toLowerCase());
  }
  override async transferWithAuthorization(a: { from: Hex; to: Hex; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex; signature: Hex }, role: "router" | "facilitator" = "router") {
    if (this.failX402Relay) throw new Error("execution reverted: transfer amount exceeds balance");
    const id = `${a.from}:${a.nonce}`.toLowerCase();
    if (this.usedAuthorizations.has(id)) throw new Error("AuthorizationUsed()");
    this.usedAuthorizations.add(id);
    const hash = fakeTx();
    this.usdgBalances.set(a.from.toLowerCase(), (await this.usdgBalance(a.from)) - a.value);
    this.x402Relays.push({ from: a.from, to: a.to, value: a.value, nonce: a.nonce, hash, role });
    return { hash, blockNumber: 1n, ...this.relayGas };
  }
  override async quoteRaw(_token: Hex, usdgOwed: bigint) {
    if (!this.fair18) return null;
    return { rawNeeded: (usdgOwed * 10n ** 18n * 10n ** 18n) / (this.fair18 * 10n ** 6n), fairPrice18: this.fair18 };
  }
  override async quoteMaxIn(token: Hex, usdgOwed: bigint, slipBps: number) {
    const q = await this.quoteRaw(token, usdgOwed);
    return q ? { maxIn: (q.rawNeeded * BigInt(10_000 + slipBps) + 9_999n) / 10_000n, rawNeeded: q.rawNeeded, fairPrice18: q.fairPrice18 } : null;
  }
  override async session(keyHash: Hex) {
    const s = this.sessions.get(keyHash);
    if (!s) throw new Error("no session");
    return { ...s, epoch: s.epoch ?? 1n };
  }
  /** Revoke the session's authorizations (PayWithStock.revokeAuthorizations / closeSession). */
  revoke(keyHash: Hex) {
    const s = this.sessions.get(keyHash)!;
    s.epoch = (s.epoch ?? 1n) + 1n;
    this.allowances.delete(keyHash);
  }
  override async allowance(keyHash: Hex) {
    const a = this.allowances.get(keyHash);
    const nextNonce = this.allowanceNonces.get(keyHash) ?? 0n;
    if (!a) return { maxRawTotal: 0n, maxRawPerCharge: 0n, spentRaw: 0n, nonce: 0n, validUntil: 0n, epoch: 0n, router: "0x0000000000000000000000000000000000000000" as Hex, nextNonce };
    return { maxRawTotal: a.auth.maxRawTotal, maxRawPerCharge: a.auth.maxRawPerCharge, spentRaw: a.spentRaw, nonce: a.auth.nonce, validUntil: a.auth.validUntil, epoch: a.auth.epoch, router: a.auth.router, nextNonce };
  }
  override async commitmentCharged(keyHash: Hex, usageCommitment: Hex) {
    return this.commitments.has(`${keyHash}:${usageCommitment}`.toLowerCase());
  }
  // EOA signatures only (no RPC in unit tests).
  override async verifyWalletSignature(wallet: Hex, typedData: Parameters<ChainService["verifyWalletSignature"]>[1], signature: Hex) {
    try {
      return (await recoverTypedDataAddress({ ...typedData, signature } as never)).toLowerCase() === wallet.toLowerCase();
    } catch {
      return false;
    }
  }
  override async setAllowance(auth: AllowanceAuthorization, signature: Hex) {
    const s = await this.session(auth.keyHash);
    const typed = { domain: this.payWithStockDomain(), types: ALLOWANCE_TYPES, primaryType: "AllowanceAuthorization" as const, message: auth };
    if (!s.active || auth.epoch !== s.epoch || auth.token.toLowerCase() !== s.token.toLowerCase()) throw new Error("StaleEpoch()");
    if (auth.nonce !== (this.allowanceNonces.get(auth.keyHash) ?? 0n)) throw new Error("InvalidNonce()");
    if (!(await this.verifyWalletSignature(s.wallet, typed, signature))) throw new Error("BadSignature()");
    this.allowanceNonces.set(auth.keyHash, auth.nonce + 1n);
    this.allowances.set(auth.keyHash, { auth, spentRaw: 0n });
    return fakeTx();
  }
  override async payCall(auth: ChargeAuthorization, signature: Hex, _maxSlipBps: number) {
    if (this.failPayCall) throw new Error("swap reverted: SlippageTooHigh");
    const s = await this.session(auth.keyHash);
    const typed = { domain: this.payWithStockDomain(), types: CHARGE_TYPES, primaryType: "ChargeAuthorization" as const, message: auth };
    if (!s.active || auth.epoch !== s.epoch) throw new Error("StaleEpoch()");
    if (BigInt(Math.floor(Date.now() / 1000)) > auth.deadline) throw new Error("AuthorizationExpired()");
    if (!(await this.verifyWalletSignature(s.wallet, typed, signature))) throw new Error("BadSignature()");
    const nonceId = `${auth.keyHash}:${auth.nonce}`;
    if (this.chargeNonces.has(nonceId)) throw new Error("NonceUsed()");
    this.useCommitment(auth.keyHash, auth.usageCommitment);
    this.chargeNonces.add(nonceId);
    return this.paid(auth.keyHash, auth.usdgAmount, auth.usageCommitment, "signature");
  }
  override async payCallWithAllowance(keyHash: Hex, usdgOwed: bigint, usageCommitment: Hex, _maxSlipBps: number) {
    if (this.failPayCall) throw new Error("swap reverted: SlippageTooHigh");
    const s = await this.session(keyHash);
    const a = this.allowances.get(keyHash);
    if (!a) throw new Error("NoAllowance()");
    if (usdgOwed > 5_000_000n) throw new Error("ChargeTooLarge()");
    if (!s.active || a.auth.epoch !== s.epoch) throw new Error("StaleEpoch()");
    if (BigInt(Math.floor(Date.now() / 1000)) > a.auth.validUntil) throw new Error("AuthorizationExpired()");
    const raw = this.rawFor(usdgOwed);
    if (raw > a.auth.maxRawPerCharge || a.spentRaw + raw > a.auth.maxRawTotal) throw new Error("SwapFailed()");
    this.useCommitment(keyHash, usageCommitment);
    a.spentRaw += raw;
    return this.paid(keyHash, usdgOwed, usageCommitment, "allowance");
  }
  private useCommitment(keyHash: Hex, usageCommitment: Hex) {
    const id = `${keyHash}:${usageCommitment}`.toLowerCase();
    if (this.commitments.has(id)) throw new Error("CommitmentUsed()");
    this.commitments.add(id);
  }
  private rawFor(usdgOwed: bigint) {
    return (usdgOwed * 10n ** 18n * 10n ** 18n) / (this.fair18! * 10n ** 6n) + 1000n;
  }
  private paid(keyHash: Hex, usdgOwed: bigint, usageCommitment: Hex, mode: "signature" | "allowance") {
    this.payCalls.push({ keyHash, usdg: usdgOwed, mode, usageCommitment });
    const hash = fakeTx();
    const rawSpent = this.rawFor(usdgOwed);
    const s = this.sessions.get(keyHash);
    if (s) s.spentRawToday += rawSpent;
    const logs: DecodedLog[] = [
      { contract: "credits", event: "Credited", args: { keyHash, source: ADDR.payWithStock, amount: usdgOwed }, txHash: hash, logIndex: 0, blockNumber: 101n },
      { contract: "payWithStock", event: "PaidWithStock", args: { keyHash, wallet: s?.wallet, usageCommitment, token: NVDA, rawSpent, fairPrice18: this.fair18!, usdgOwed, nonce: 0n, viaAllowance: mode === "allowance" }, txHash: hash, logIndex: 1, blockNumber: 101n },
    ];
    return { hash, logs, rawSpent, fairPrice18: this.fair18! };
  }
  override async anchor(root: Hex, fromTs: number, toTs: number, count: number) {
    this.anchors.push({ root, fromTs, toTs, count });
    return { hash: fakeTx(), index: BigInt(this.anchors.length - 1) };
  }
  override async anchorOnChain(index: number) {
    const a = this.anchors[index];
    return a ? { root: a.root, fromTs: BigInt(a.fromTs), toTs: BigInt(a.toTs), count: a.count } : null;
  }
  override async registerSigningKey(keyId: string, pub: string) {
    this.keys.set(keyId, pub);
    return { hash: fakeTx(), receipt: {} as never };
  }
  override async signingKeyOnChain(keyId: string) {
    const pub = this.keys.get(keyId);
    return pub ? { publicKey: ("0x" + pub) as Hex, validFrom: 0n, revokedAt: 0n } : null;
  }
  /** Chain clock offset from wall time in seconds (negative = the chain trails); failNextSpentRoot simulates a dropped tx. */
  clockOffsetSec = 0;
  failNextSpentRoot = false;
  override async latestBlockTime() {
    return Math.floor(Date.now() / 1000) + this.clockOffsetSec;
  }
  override async latestSpentRoot() {
    const r = this.spentRoots.at(-1);
    return { epoch: BigInt(this.spentRoots.length), root: (r?.root ?? "0x" + "00".repeat(32)) as Hex, asOf: r?.asOf ?? 0, totalSpent: r?.total ?? 0n };
  }
  controlsReady = true;
  override async custodyControlsReady() { return this.controlsReady; }
  approveSpentRoots = true;
  override async isSpentRootApproved() { return this.approveSpentRoots; }
  override async postSpentRoot(root: Hex, asOf: number, total: bigint) {
    // Same checks as Credits.postSpentRoot.
    if (this.failNextSpentRoot) {
      this.failNextSpentRoot = false;
      throw new Error("transaction dropped");
    }
    if (asOf > (await this.latestBlockTime())) throw new Error("RootInFuture()");
    if (asOf <= (this.spentRoots.at(-1)?.asOf ?? 0)) throw new Error("StaleRoot()");
    this.spentRoots.push({ root, asOf, total });
    return { hash: fakeTx(), receipt: {} as never };
  }
  override async bondOf() {
    return 20_000n * 10n ** 6n;
  }
  override async proposeSlash(...args: unknown[]) {
    this.slashProposals.push(args);
    return { submitted: true as const, hash: fakeTx(), slashId: BigInt(this.slashProposals.length) };
  }
  executeSlashSubmitted = true;
  override async executeSlash() {
    if (!this.executeSlashSubmitted) return { submitted: false as const, safeTx: { to: this.address("providerBond")!, value: "0", data: "0x" as Hex } };
    return { submitted: true as const, hash: fakeTx() };
  }

  // Stock escrow: transfers already sent to the escrow address, one price feed for every token,
  // and the on-chain decimals the watcher verifies before crediting. Blocks have hashes; reorg(n)
  // replaces block n and every block after it, as a real reorganization does. The finality point
  // trails the head by escrowFinalLag blocks (~10 blocks per second, as on Robinhood Chain).
  escrowLogs: Omit<EscrowTransfer, "blockHash">[] = [];
  escrowHead = 100n;
  escrowFinalLag = 0n;
  escrowForks: bigint[] = [];
  escrowReverted = new Set<string>();
  escrowMissingReceipts = new Set<string>();
  feedReading: FeedReading | null = { answer: 180n * 10n ** 8n, decimals: 8, updatedAt: Math.floor(Date.now() / 1000) };
  escrowDecimals = 18;
  escrowBlockHash(n: bigint): Hex | null {
    if (n < 0n || n > this.escrowHead) return null;
    return keccak256(toBytes(`block:${n}:fork:${this.escrowForks.filter((f) => f <= n).length}`));
  }
  /** Replace block `from` and all later blocks; `edit` changes which transfers the new branch holds. */
  reorg(from: bigint, edit?: (logs: Omit<EscrowTransfer, "blockHash">[]) => Omit<EscrowTransfer, "blockHash">[]) {
    this.escrowForks.push(from);
    if (edit) this.escrowLogs = edit(this.escrowLogs);
  }
  override async escrowTransfers(tokens: Hex[], _escrow: Hex, from: bigint, to: bigint) {
    const allowed = tokens.map((t) => t.toLowerCase());
    return this.escrowLogs
      .filter((l) => l.blockNumber >= from && l.blockNumber <= to && l.blockNumber <= this.escrowHead && allowed.includes(l.token.toLowerCase()))
      .map((l) => ({ ...l, blockHash: this.escrowBlockHash(l.blockNumber)! }));
  }
  override async escrowFinality() {
    const now = Math.floor(Date.now() / 1000);
    const final = this.escrowHead - this.escrowFinalLag;
    return { head: this.escrowHead, headTime: now, final, finalHash: this.escrowBlockHash(final)!, finalTime: now - Number(this.escrowFinalLag / 10n) };
  }
  override async blockHashAt(n: bigint) {
    return this.escrowBlockHash(n);
  }
  override async escrowReceipt(txHash: Hex): Promise<EscrowReceipt | null> {
    const logs = this.escrowLogs.filter((l) => l.txHash === txHash && l.blockNumber <= this.escrowHead);
    if (!logs.length || this.escrowMissingReceipts.has(txHash)) return null;
    const reverted = this.escrowReverted.has(txHash);
    return {
      success: !reverted,
      blockNumber: logs[0].blockNumber,
      blockHash: this.escrowBlockHash(logs[0].blockNumber)!,
      transfers: reverted ? [] : logs.map((l) => ({ token: l.token, from: l.from, value: l.value, logIndex: l.logIndex })),
    };
  }
  override async readFeed() {
    if (!this.feedReading) throw new Error("feed unreadable");
    return { ...this.feedReading };
  }
  override async tokenDecimals() {
    return this.escrowDecimals;
  }

  /** Simulate a Credits.Deposited event for a chain key hash. */
  async deposit(ctx: Ctx, chainKeyHash: string, usdgUnits: bigint) {
    const tx = fakeTx();
    await recordEvents(ctx, [{ contract: "credits", event: "Deposited", args: { keyHash: chainKeyHash, from: "0x0000000000000000000000000000000000000abc", amount: usdgUnits }, txHash: tx, logIndex: 0, blockNumber: 50n }]);
    await processEvents(ctx);
    return tx;
  }
}

export const MODELS = {
  llama: { id: "llama-3.3-70b", slug: "meta-llama/llama-3.3-70b-instruct", prompt: "0.0000001", completion: "0.00000032" },
  llamaPricey: { id: "llama-3.3-70b", slug: "meta-llama/llama-3.3-70b-instruct", prompt: "0.0000004", completion: "0.0000008" },
  qwen: { id: "qwen3-32b", slug: "qwen/qwen3-32b", prompt: "0.0000002", completion: "0.0000006" },
  embed: { id: "embed-small", slug: "acme/embed-small", prompt: "0.00000002", completion: "0", output: ["embeddings"] },
};

export function fixtureEdgeInit(h: { ctx: Ctx }, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (h.ctx.cfg.hardening.originLockEnabled && !headers.has("x-origin-lock")) headers.set("x-origin-lock", h.ctx.cfg.hardening.originLockSecret!);
  return { ...init, headers };
}

export type Harness = Awaited<ReturnType<typeof startRouter>>;

type ApiTypedData = { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, string> };

/** Sign typed data as the API returns it for eth_signTypedData_v4 (integers as decimal strings). */
export async function signApiTypedData(account: PrivateKeyAccount, td: ApiTypedData) {
  const message = Object.fromEntries(td.types[td.primaryType].map((f) => [f.name, f.type.startsWith("uint") ? BigInt(td.message[f.name]) : td.message[f.name]]));
  const { EIP712Domain: _, ...types } = td.types;
  return account.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message } as never);
}

/** Ask the router for an allowance to sign, sign it with the session wallet and hand it back. */
export async function signAllowance(h: Harness, k: { auth: Record<string, string> }, account: PrivateKeyAccount, body: Record<string, unknown> = {}) {
  const td = (await (await h.request("/api/v1/paywith/allowance/typed-data", { method: "POST", headers: k.auth, json: body })).json()).data.typed_data as ApiTypedData;
  const r = await h.request("/api/v1/paywith/allowance", { method: "POST", headers: k.auth, json: { message: td.message, signature: await signApiTypedData(account, td) } });
  if (r.status !== 201) throw new Error(`allowance rejected: ${await r.text()}`);
  return td;
}

/** A new key with a PayWithStock session opened (and indexed) from a real wallet, optionally with a signed allowance. */
export async function paywithKey(h: Harness, opts: { capRaw?: bigint; allowance?: boolean } = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const k = await h.newKey(); // empty prepaid balance: every call must be paid with NVDA
  const capRaw = opts.capRaw ?? 10n ** 18n;
  await h.request("/api/v1/paywith/open", { method: "POST", headers: k.auth, json: { token: "NVDA", cap_raw_per_day: capRaw.toString(), wallet: account.address } });
  h.chain.sessions.set(k.chainKeyHash, { wallet: account.address, token: NVDA, capRawPerDay: capRaw, spentRawToday: 0n, dayStart: BigInt(Math.floor(Date.now() / 86_400_000) * 86_400), active: true, epoch: 1n });
  await recordEvents(h.ctx, [{ contract: "payWithStock", event: "SessionOpened", args: { keyHash: k.chainKeyHash, wallet: account.address, token: NVDA, capRawPerDay: capRaw }, txHash: fakeTx(), logIndex: 0, blockNumber: 60n }]);
  await processEvents(h.ctx);
  if (opts.allowance) await signAllowance(h, k, account);
  return { ...k, account };
}

/** With TEST_PG_URL set, every harness gets its own fresh database on a real Postgres server. */
async function freshDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const base = process.env.TEST_PG_URL;
  if (!base) return { url: "pglite://memory", drop: async () => {} };
  const postgres = (await import("postgres")).default;
  const name = "ar_test_" + Math.random().toString(36).slice(2, 10);
  const admin = postgres(base, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(base);
  u.pathname = "/" + name;
  return {
    url: u.toString(),
    drop: async () => {
      const a = postgres(base, { max: 1, onnotice: () => {} });
      await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export async function startRouter(opts: { providers?: (MockConfig & { id: string; live?: boolean; attested?: boolean; policy?: Record<string, unknown> })[]; env?: Record<string, string>; fakeChain?: boolean; rand?: () => number } = {}) {
  const mocks = (opts.providers ?? [
    { id: "alpha", name: "Alpha", models: [MODELS.llama, MODELS.qwen, MODELS.embed] },
    { id: "beta", name: "Beta", models: [MODELS.llamaPricey] },
  ]).map((p) => ({ spec: p, server: serveMockProvider(p) }));
  const database = await freshDatabase();
  const env: Record<string, string> = {
    ANYROUTE_ENV: "test",
    DATABASE_URL: database.url,
    ...(process.env.TEST_REDIS_URL ? { REDIS_URL: process.env.TEST_REDIS_URL } : {}),
    PAYMENT_WAIT_MS: "500",
    WORKERS: "false",
    HEALTH_PROBES: "false",
    CANARIES: "false",
    APP_SECRET: "test-secret-test-secret-test-secret-1234",
    ADMIN_TOKEN: ADMIN,
    LOG_LEVEL: "error",
    PAYWITH_TOKENS: JSON.stringify([{ symbol: "NVDA", address: NVDA, decimals: 18 }]),
    ALLOW_DEV_ATTESTATION: "true",
    NEW_KEYS_PER_HOUR: "100000",
    UNAUTH_RPM: "100000",
    ANON_RATE_PER_MIN: "100000", // Dedicated hardening cases override this workload allowance.
    ...opts.env,
  };
  const chain = opts.fakeChain === false ? undefined : new FakeChain(env);
  const { app, ctx, close } = await createApp({ env, chain, rand: opts.rand, startJobs: false });
  // The in-memory limiter belongs to one router, and the tests are written against that. A Redis limiter's counters
  // outlive the router and are shared by every harness and every run within the same window (fixed hour, minute), so a
  // limit reached by one test file, or by an earlier run, would fail another. Give each router its own key namespace.
  if (ctx.limiter instanceof RedisRateLimiter) {
    const shared = ctx.limiter;
    const namespace = `t${randomBytes(6).toString("hex")}:`;
    ctx.limiter = { take: (key, amount, limit, windowMs) => shared.take(namespace + key, amount, limit, windowMs), close: () => shared.close() };
  }
  for (const { spec, server } of mocks) {
    await ctx.db.insert(providers).values({
      id: spec.id,
      name: spec.name,
      baseUrl: server.url,
      apiKeyEnc: encrypt(ctx.cfg.appSecret, `upstream-key-${spec.id}`),
      status: spec.live === false ? "applied" : "live",
      dataPolicy: spec.policy ?? { training: false, retains_prompts: false, zdr: true },
      teeKind: spec.tee ?? null,
      attestationUrl: spec.tee ? server.url + "/attestation" : null,
    });
  }
  await runRegistry(ctx);
  const request = (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    if (ctx.cfg.hardening.originLockEnabled && !headers.has("x-origin-lock")) headers.set("x-origin-lock", ctx.cfg.hardening.originLockSecret!); // Emulate the configured public edge.
    if (init.json !== undefined) headers.set("content-type", "application/json");
    return app.request(path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  };
  const newKey = async () => {
    const r = await request("/api/v1/keys", { method: "POST", json: { name: "test" } });
    const j = (await r.json()) as { key: string; data: { hash: string; chain_key_hash: string } };
    return { secret: j.key, hash: j.data.hash, chainKeyHash: j.data.chain_key_hash, auth: { authorization: `Bearer ${j.key}` } };
  };
  const fundedKey = async (usdg = 10n) => {
    const k = await newKey();
    await (chain as FakeChain).deposit(ctx, k.chainKeyHash, usdg * 1_000_000n);
    return k;
  };
  return {
    app,
    ctx,
    chain: chain as FakeChain,
    mocks: Object.fromEntries(mocks.map((m) => [m.spec.id, m.server])),
    request,
    newKey,
    fundedKey,
    close: async () => {
      await close();
      for (const m of mocks) m.server.stop();
      await database.drop();
    },
  };
}

export async function sse(res: Response) {
  const text = await res.text();
  const events = text
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith("data:"))
    .map((b) => b.slice(5).trim());
  return { raw: text, done: events.includes("[DONE]"), events: events.filter((e) => e !== "[DONE]").map((e) => JSON.parse(e)) };
}

export const providerIdHash = (id: string) => keccak256(toBytes(id));
export { encodePacked, eq };
