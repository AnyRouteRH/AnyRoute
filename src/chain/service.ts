import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  http,
  type Abi,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "../config.ts";
import { fail } from "../lib/errors.ts";
import { log } from "../lib/util.ts";
import {
  AnyrStakingAbi,
  CallPayAbi,
  CreditsAbi,
  PayWithStockAbi,
  ProviderBondAbi,
  ReceiptAnchorAbi,
  RoyaltyAbi,
  erc20Abi,
} from "./abis.ts";

export type ContractName = "credits" | "callPay" | "payWithStock" | "providerBond" | "receiptAnchor" | "royalty" | "staking";
export const CONTRACT_ABIS: Record<ContractName, Abi> = {
  credits: CreditsAbi as unknown as Abi,
  callPay: CallPayAbi as unknown as Abi,
  payWithStock: PayWithStockAbi as unknown as Abi,
  providerBond: ProviderBondAbi as unknown as Abi,
  receiptAnchor: ReceiptAnchorAbi as unknown as Abi,
  royalty: RoyaltyAbi as unknown as Abi,
  staking: AnyrStakingAbi as unknown as Abi,
};

export type DecodedLog = { contract: ContractName; event: string; args: Record<string, unknown>; txHash: Hex; logIndex: number; blockNumber: bigint };
export type CallPayment = { nonce: Hex; payer: Hex; amount: bigint; blockNumber: bigint; confirmations: number; logIndex: number };

type Role = "router" | "settlement" | "anchorer" | "slasher" | "keeper" | "faucet";

export class ChainService {
  readonly chain: Chain;
  readonly client: PublicClient;
  private wallets = new Map<Role, WalletClient>();

  constructor(private cfg: Config) {
    this.chain = defineChain({
      id: cfg.chain.id,
      name: cfg.chain.id === 4663 ? "Robinhood Chain" : `Chain ${cfg.chain.id}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [cfg.chain.rpcUrl] } },
    });
    // cacheTime 0: viem otherwise caches eth_blockNumber for 4s, which hides fresh blocks from the
    // indexer and payment checks (RHC produces ~10 blocks per second).
    this.client = createPublicClient({ chain: this.chain, cacheTime: 0, pollingInterval: 250, transport: http(cfg.chain.rpcUrl, { retryCount: 2, timeout: 15_000 }) });
    const keys: Record<Role, Hex | undefined> = {
      router: cfg.chain.routerKey,
      settlement: cfg.chain.settlementKey,
      anchorer: cfg.chain.anchorerKey,
      slasher: cfg.chain.slasherKey,
      keeper: cfg.chain.keeperKey,
      faucet: cfg.chain.faucetKey,
    };
    for (const [role, key] of Object.entries(keys) as [Role, Hex | undefined][]) {
      if (key) this.wallets.set(role, createWalletClient({ account: privateKeyToAccount(key), chain: this.chain, transport: http(cfg.chain.rpcUrl) }));
    }
  }

  address(name: ContractName): Hex | undefined {
    return this.cfg.chain[name] as Hex | undefined;
  }

  require(name: ContractName): Hex {
    const a = this.address(name);
    if (!a) fail(503, `The ${name} contract is not configured on this router.`, "chain_unconfigured");
    return a;
  }

  wallet(role: Role): WalletClient & { account: Account } {
    const w = this.wallets.get(role);
    if (!w) fail(503, `No ${role} signing key is configured.`, "chain_unconfigured");
    return w as WalletClient & { account: Account };
  }

  roleAddress(role: Role): Hex | undefined {
    return this.wallets.get(role)?.account?.address;
  }

  status() {
    const contracts = Object.fromEntries((Object.keys(CONTRACT_ABIS) as ContractName[]).map((n) => [n, this.address(n) ?? null]));
    return {
      chain_id: this.cfg.chain.id,
      rpc: this.cfg.chain.rpcUrl.replace(/\/\/([^/@]+)@/, "//***@"),
      public_rpc: this.cfg.chain.publicRpcUrl,
      explorer: this.cfg.chain.explorerUrl,
      usdg: this.cfg.chain.usdg,
      contracts,
      signers: Object.fromEntries([...this.wallets.entries()].filter(([r]) => r !== "faucet").map(([r, w]) => [r, w.account?.address])),
    };
  }

  async blockNumber() {
    return this.client.getBlockNumber({ cacheTime: 0 });
  }

  private async send(role: Role, to: Hex, abi: Abi, functionName: string, args: unknown[]) {
    const w = this.wallet(role);
    const { request } = await this.client.simulateContract({ account: w.account, address: to, abi, functionName, args } as never);
    const hash = await w.writeContract(request as never);
    const receipt = await this.client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
    if (receipt.status !== "success") fail(502, `Transaction ${hash} reverted.`, "chain_reverted");
    return { hash, receipt };
  }

  decode(contract: ContractName, logEntry: { address: Hex; topics: Hex[]; data: Hex; transactionHash: Hex | null; logIndex: number | null; blockNumber: bigint | null }): DecodedLog | null {
    try {
      const d = decodeEventLog({ abi: CONTRACT_ABIS[contract], topics: logEntry.topics as [Hex, ...Hex[]], data: logEntry.data });
      return {
        contract,
        event: String(d.eventName),
        args: (d.args ?? {}) as Record<string, unknown>,
        txHash: logEntry.transactionHash!,
        logIndex: logEntry.logIndex!,
        blockNumber: logEntry.blockNumber!,
      };
    } catch {
      return null;
    }
  }

  /** All configured-contract events in [from, to]. */
  async logs(from: bigint, to: bigint): Promise<DecodedLog[]> {
    const names = (Object.keys(CONTRACT_ABIS) as ContractName[]).filter((n) => this.address(n));
    if (!names.length) return [];
    const byAddress = new Map(names.map((n) => [this.address(n)!.toLowerCase(), n]));
    const raw = await this.client.getLogs({ address: names.map((n) => this.address(n)!), fromBlock: from, toBlock: to });
    const out: DecodedLog[] = [];
    for (const l of raw) {
      const name = byAddress.get(l.address.toLowerCase());
      if (!name) continue;
      const d = this.decode(name, l as never);
      if (d) out.push(d);
    }
    return out;
  }

  // ---- 402 per-call payments -------------------------------------------------------------

  /** Read every CallPay payment in a transaction (the X-Payment header). Pending until confirmed. */
  async readCallPayments(txHash: Hex): Promise<CallPayment[] | { pending: true; confirmations: number }> {
    const callPay = this.require("callPay");
    const receipt = await this.client.getTransactionReceipt({ hash: txHash }).catch(() => null);
    if (!receipt) return { pending: true, confirmations: 0 };
    if (receipt.status !== "success") fail(402, "This payment transaction failed on-chain, so nothing was paid.", "payment_failed");
    const head = await this.client.getBlockNumber({ cacheTime: 0 });
    const confirmations = Number(head - receipt.blockNumber + 1n);
    const out: CallPayment[] = [];
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() !== callPay.toLowerCase()) continue;
      const d = this.decode("callPay", l as never);
      if (d?.event === "Paid") out.push({ nonce: d.args.nonce as Hex, payer: d.args.payer as Hex, amount: d.args.amount as bigint, blockNumber: receipt.blockNumber, confirmations, logIndex: d.logIndex });
    }
    if (!out.length) fail(402, "This transaction does not contain a CallPay payment.", "payment_not_found");
    if (confirmations < this.cfg.chain.confirmations) return { pending: true, confirmations };
    return out;
  }

  /** @deprecated single-payment view kept for callers that only need the first payment. */
  async readCallPayment(txHash: Hex): Promise<CallPayment | { pending: true; confirmations: number }> {
    const r = await this.readCallPayments(txHash);
    return Array.isArray(r) ? r[0] : r;
  }

  private domainCache: { name: string; version: string } | null = null;
  /** USDG's EIP-712 domain, read from the token (ERC-5267) with the configured values as fallback. */
  async usdgDomain(): Promise<{ name: string; version: string }> {
    if (this.domainCache) return this.domainCache;
    try {
      const d = (await this.client.readContract({
        address: this.cfg.chain.usdg,
        abi: [{ type: "function", name: "eip712Domain", stateMutability: "view", inputs: [], outputs: [{ type: "bytes1" }, { type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" }] }],
        functionName: "eip712Domain",
      })) as readonly unknown[];
      this.domainCache = { name: String(d[1]), version: String(d[2]) };
    } catch {
      this.domainCache = { ...this.cfg.chain.usdgDomain };
    }
    return this.domainCache;
  }

  /** Relay an EIP-3009 ReceiveWithAuthorization through CallPay.payWithAuthorization (router pays gas). */
  async payWithAuthorization(a: { nonce: Hex; amount: bigint; expiry: bigint; from: Hex; validAfter: bigint; validBefore: bigint; signature: Hex }) {
    const callPay = this.require("callPay");
    const { hash } = await this.send("router", callPay, CallPayAbi as unknown as Abi, "payWithAuthorization", [a.nonce, a.amount, a.expiry, a.from, a.validAfter, a.validBefore, a.signature]);
    return hash;
  }

  // ---- Pay with Stock Tokens ------------------------------------------------------------

  async quoteRaw(token: Hex, usdgOwed: bigint): Promise<{ rawNeeded: bigint; fairPrice18: bigint } | null> {
    const pws = this.require("payWithStock");
    try {
      const [rawNeeded, fairPrice18] = (await this.client.readContract({ address: pws, abi: PayWithStockAbi, functionName: "quoteRaw", args: [token, usdgOwed] })) as [bigint, bigint];
      return { rawNeeded, fairPrice18 };
    } catch (e) {
      log.warn("quoteRaw failed (oracle not ok?)", { token, error: (e as Error).message.slice(0, 200) });
      return null;
    }
  }

  async session(chainKeyHash: Hex) {
    const pws = this.require("payWithStock");
    const r = (await this.client.readContract({ address: pws, abi: PayWithStockAbi, functionName: "sessions", args: [chainKeyHash] })) as [Hex, Hex, bigint, bigint, bigint, boolean];
    return { wallet: r[0], token: r[1], capRawPerDay: r[2], spentRawToday: r[3], dayStart: r[4], active: r[5] };
  }

  async payCall(chainKeyHash: Hex, usdgOwed: bigint, maxSlipBps: number) {
    const pws = this.require("payWithStock");
    const { hash, receipt } = await this.send("router", pws, PayWithStockAbi as unknown as Abi, "payCall", [chainKeyHash, usdgOwed, maxSlipBps]);
    const logs = this.decodeReceipt(receipt.logs as never);
    const event = logs.find((l) => l.contract === "payWithStock" && l.event === "PaidWithStock");
    return { hash, logs, rawSpent: (event?.args.rawSpent as bigint) ?? 0n, fairPrice18: (event?.args.fairPrice18 as bigint) ?? 0n };
  }

  /** Decode every log in a receipt that belongs to a configured Anyroute contract. */
  decodeReceipt(logs: { address: Hex; topics: Hex[]; data: Hex; transactionHash: Hex | null; logIndex: number | null; blockNumber: bigint | null }[]): DecodedLog[] {
    const byAddress = new Map((Object.keys(CONTRACT_ABIS) as ContractName[]).filter((n) => this.address(n)).map((n) => [this.address(n)!.toLowerCase(), n]));
    const out: DecodedLog[] = [];
    for (const l of logs) {
      const name = byAddress.get(l.address.toLowerCase());
      const d = name ? this.decode(name, l) : null;
      if (d) out.push(d);
    }
    return out;
  }

  // ---- Receipts -------------------------------------------------------------------------

  async anchor(root: Hex, fromTs: number, toTs: number, count: number) {
    const a = this.require("receiptAnchor");
    const { hash, receipt } = await this.send("anchorer", a, ReceiptAnchorAbi as unknown as Abi, "anchor", [root, BigInt(fromTs), BigInt(toTs), count]);
    let index: bigint | null = null;
    for (const l of receipt.logs) {
      const d = l.address.toLowerCase() === a.toLowerCase() ? this.decode("receiptAnchor", l as never) : null;
      if (d?.event === "Anchored") index = d.args.index as bigint;
    }
    return { hash, index };
  }

  async anchorOnChain(index: number): Promise<{ root: Hex; fromTs: bigint; toTs: bigint; count: number } | null> {
    const a = this.address("receiptAnchor");
    if (!a) return null;
    const r = (await this.client.readContract({ address: a, abi: ReceiptAnchorAbi, functionName: "anchors", args: [BigInt(index)] })) as [Hex, bigint, bigint, number];
    return r[0] === "0x0000000000000000000000000000000000000000000000000000000000000000" ? null : { root: r[0], fromTs: r[1], toTs: r[2], count: Number(r[3]) };
  }

  async registerSigningKey(keyId: string, publicKeyHex: string, validFrom: Date) {
    const a = this.require("receiptAnchor");
    return this.send("anchorer", a, ReceiptAnchorAbi as unknown as Abi, "registerSigningKey", [
      `0x${keyId}` as Hex,
      `0x${publicKeyHex}` as Hex,
      BigInt(Math.floor(validFrom.getTime() / 1000)),
    ]);
  }

  async signingKeyOnChain(keyId: string) {
    const a = this.address("receiptAnchor");
    if (!a) return null;
    const r = (await this.client.readContract({ address: a, abi: ReceiptAnchorAbi, functionName: "signingKeys", args: [`0x${keyId}` as Hex] })) as [Hex, bigint, bigint];
    return BigInt(r[0]) === 0n ? null : { publicKey: r[0], validFrom: r[1], revokedAt: r[2] };
  }

  // ---- Settlement -----------------------------------------------------------------------

  get devFaucet() {
    return this.wallets.has("faucet");
  }

  /** Local chain only (the mock USDG has an open mint): mint, approve and deposit to a key hash. */
  async faucetDeposit(chainKeyHash: Hex, units: bigint) {
    const credits = this.require("credits");
    const w = this.wallet("faucet");
    const mintAbi = [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }] as const;
    await this.send("faucet", this.cfg.chain.usdg, mintAbi as unknown as Abi, "mint", [w.account.address, units]);
    await this.send("faucet", this.cfg.chain.usdg, erc20Abi as unknown as Abi, "approve", [credits, units]);
    return this.send("faucet", credits, CreditsAbi as unknown as Abi, "deposit", [chainKeyHash, units]);
  }

  /** Timestamp (seconds) of the latest block: the chain's own clock. */
  async latestBlockTime() {
    return Number((await this.client.getBlock({ blockTag: "latest" })).timestamp);
  }

  /** The Credits contract's current spent root (what finalizeWithdrawal checks proofs against). */
  async latestSpentRoot() {
    const credits = this.require("credits");
    const epoch = (await this.client.readContract({ address: credits, abi: CreditsAbi, functionName: "latestEpoch" })) as bigint;
    const [root, asOf] = (await this.client.readContract({ address: credits, abi: CreditsAbi, functionName: "spentRoot", args: [epoch] })) as [Hex, bigint, bigint];
    return { epoch, root, asOf: Number(asOf) };
  }

  async postSpentRoot(root: Hex, asOf: number, totalSpent: bigint) {
    return this.send("settlement", this.require("credits"), CreditsAbi as unknown as Abi, "postSpentRoot", [root, BigInt(asOf), totalSpent]);
  }
  async sweep(to: Hex, amount: bigint) {
    return this.send("settlement", this.require("credits"), CreditsAbi as unknown as Abi, "sweep", [to, amount]);
  }
  async usdgBalance(of: Hex) {
    return (await this.client.readContract({ address: this.cfg.chain.usdg, abi: erc20Abi, functionName: "balanceOf", args: [of] })) as bigint;
  }
  async ensureAllowance(role: Role, spender: Hex, amount: bigint) {
    const w = this.wallet(role);
    const current = (await this.client.readContract({ address: this.cfg.chain.usdg, abi: erc20Abi, functionName: "allowance", args: [w.account.address, spender] })) as bigint;
    if (current >= amount) return null;
    return this.send(role, this.cfg.chain.usdg, erc20Abi as unknown as Abi, "approve", [spender, amount * 10n]);
  }
  async transferUsdg(role: Role, to: Hex, amount: bigint) {
    return this.send(role, this.cfg.chain.usdg, erc20Abi as unknown as Abi, "transfer", [to, amount]);
  }
  async streamRoyalty(modelIdHash: Hex, usdg: bigint) {
    const r = this.require("royalty");
    await this.ensureAllowance("settlement", r, usdg);
    return this.send("settlement", r, RoyaltyAbi as unknown as Abi, "stream", [modelIdHash, usdg]);
  }
  async notifyMargin(usdg: bigint) {
    const s = this.require("staking");
    await this.ensureAllowance("settlement", s, usdg);
    return this.send("settlement", s, AnyrStakingAbi as unknown as Abi, "notifyMargin", [usdg]);
  }

  async buybackState() {
    const s = this.require("staking");
    const [balance, remaining] = await Promise.all([
      this.client.readContract({ address: s, abi: AnyrStakingAbi, functionName: "buybackBalance" }) as Promise<bigint>,
      this.client.readContract({ address: s, abi: AnyrStakingAbi, functionName: "buybackRemainingToday" }) as Promise<bigint>,
    ]);
    return { balance, remaining };
  }
  async executeBuyback(usdgIn: bigint, minAnyrOut: bigint) {
    return this.send("keeper", this.require("staking"), AnyrStakingAbi as unknown as Abi, "executeBuyback", [usdgIn, minAnyrOut]);
  }
  async registerRoyalty(modelIdHash: Hex, creator: Hex, bps: number) {
    return this.send("router", this.require("royalty"), RoyaltyAbi as unknown as Abi, "register", [modelIdHash, creator, bps]);
  }

  // ---- Provider bonds -------------------------------------------------------------------

  async bondOf(providerIdHash: Hex) {
    const b = this.address("providerBond");
    if (!b) return null;
    return (await this.client.readContract({ address: b, abi: ProviderBondAbi, functionName: "bondOf", args: [providerIdHash] })) as bigint;
  }

  /** Slash proposals are executed by the slasher multisig. With a dev slasher key the router
   *  submits directly; otherwise it returns the Safe transaction to propose. */
  async proposeSlash(providerIdHash: Hex, kind: number, amount: bigint, evidenceRoot: Hex, delist: boolean) {
    const b = this.require("providerBond");
    const args = [providerIdHash, kind, amount, evidenceRoot, delist];
    if (this.wallets.has("slasher")) {
      const { hash, receipt } = await this.send("slasher", b, ProviderBondAbi as unknown as Abi, "proposeSlash", args);
      let slashId: bigint | null = null;
      for (const l of receipt.logs) {
        const d = l.address.toLowerCase() === b.toLowerCase() ? this.decode("providerBond", l as never) : null;
        if (d?.event === "SlashProposed") slashId = d.args.slashId as bigint;
      }
      return { submitted: true as const, hash, slashId };
    }
    return { submitted: false as const, safeTx: { to: b, value: "0", data: encodeFunctionData({ abi: ProviderBondAbi, functionName: "proposeSlash", args: args as never }) } };
  }

  async executeSlash(slashId: bigint) {
    const b = this.require("providerBond");
    if (!this.wallets.has("slasher"))
      return { submitted: false as const, safeTx: { to: b, value: "0", data: encodeFunctionData({ abi: ProviderBondAbi, functionName: "executeSlash", args: [slashId] }) } };
    const { hash } = await this.send("slasher", b, ProviderBondAbi as unknown as Abi, "executeSlash", [slashId]);
    return { submitted: true as const, hash };
  }
}
