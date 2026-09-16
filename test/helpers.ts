import { eq } from "drizzle-orm";
import { encodePacked, keccak256, toBytes, type Hex } from "viem";
import { createApp } from "../src/app.ts";
import { ChainService, type DecodedLog } from "../src/chain/service.ts";
import { loadConfig } from "../src/config.ts";
import { providers } from "../src/db/schema.ts";
import { runRegistry } from "../src/services/registry.ts";
import { serveMockProvider, type MockConfig } from "../src/providers/mock.ts";
import { recordEvents, processEvents } from "../src/chain/indexer.ts";
import { encrypt } from "../src/lib/util.ts";
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
  sessions = new Map<string, { wallet: Hex; token: Hex; capRawPerDay: bigint; spentRawToday: bigint; dayStart: bigint; active: boolean }>();
  anchors: { root: Hex; fromTs: number; toTs: number; count: number }[] = [];
  spentRoots: { root: Hex; asOf: number; total: bigint }[] = [];
  keys = new Map<string, string>();
  payCalls: { keyHash: Hex; usdg: bigint }[] = [];
  slashProposals: unknown[] = [];
  failPayCall = false;

  constructor(env: Record<string, unknown>) {
    super(loadConfig(env));
  }
  override address(name: string) {
    return (ADDR as Record<string, Hex>)[name];
  }
  override roleAddress() {
    return "0x0000000000000000000000000000000000000001" as Hex;
  }
  override async blockNumber() {
    return 100n;
  }
  override async readCallPayments(txHash: Hex) {
    const p = this.payments.get(txHash);
    if (!p) throw Object.assign(new Error("not found"), {});
    if (p.pending) return { pending: true as const, confirmations: 0 };
    return [{ nonce: p.nonce, payer: p.payer, amount: p.amount, blockNumber: 1n, confirmations: 5, logIndex: 0 }];
  }
  override async quoteRaw(_token: Hex, usdgOwed: bigint) {
    if (!this.fair18) return null;
    return { rawNeeded: (usdgOwed * 10n ** 18n * 10n ** 18n) / (this.fair18 * 10n ** 6n), fairPrice18: this.fair18 };
  }
  override async session(keyHash: Hex) {
    const s = this.sessions.get(keyHash);
    if (!s) throw new Error("no session");
    return s;
  }
  override async payCall(keyHash: Hex, usdgOwed: bigint) {
    if (this.failPayCall) throw new Error("swap reverted: SlippageTooHigh");
    this.payCalls.push({ keyHash, usdg: usdgOwed });
    const hash = fakeTx();
    const rawSpent = (usdgOwed * 10n ** 18n * 10n ** 18n) / (this.fair18! * 10n ** 6n) + 1000n;
    const s = this.sessions.get(keyHash);
    if (s) s.spentRawToday += rawSpent;
    const logs: DecodedLog[] = [
      { contract: "credits", event: "Credited", args: { keyHash, source: ADDR.payWithStock, amount: usdgOwed }, txHash: hash, logIndex: 0, blockNumber: 101n },
      { contract: "payWithStock", event: "PaidWithStock", args: { keyHash, token: NVDA, rawSpent, fairPrice18: this.fair18!, usdgOwed }, txHash: hash, logIndex: 1, blockNumber: 101n },
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
    return { epoch: BigInt(this.spentRoots.length), root: (r?.root ?? "0x" + "00".repeat(32)) as Hex, asOf: r?.asOf ?? 0 };
  }
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
  override async executeSlash() {
    return { submitted: true as const, hash: fakeTx() };
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

export type Harness = Awaited<ReturnType<typeof startRouter>>;

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
