import { and, desc, eq } from "drizzle-orm";
import type { Hex, PublicClient } from "viem";
import { erc20Abi } from "../chain/abis.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { kv, ledger } from "../db/schema.ts";
import { ensureAccount, post } from "../ledger/ledger.ts";
import { allocate, PICO_PER_USDG_UNIT, picoToUsd, type Pico } from "../lib/money.ts";

// "Hold $ANYR, get free AI credits". An operator runs scripts/holder-credits.ts for a period: it takes
// a snapshot of $ANYR balances at one block, splits a USD budget across eligible holders, and credits
// each holder's wallet account (w_<address>, the account wallet sign-in uses). Each credit is a ledger
// row with ref `holder-credits:<period>:<address>`; ledger.ref is unique, so re-running a period never
// credits a wallet twice. Credits are off-chain (kind `holder_credit`): spendable on inference only,
// never withdrawable as USDG, exactly like Stock Token escrow credits.

export const CREDIT_KIND = "holder_credit";
export const ZERO = "0x0000000000000000000000000000000000000000";
export const BURN = "0x000000000000000000000000000000000000dead";
const MICRO = PICO_PER_USDG_UNIT; // allocations are made in whole micro-dollars (1e6 pico)

export const walletAccount = (address: string) => `w_${address.toLowerCase().slice(2)}`;

/** Never credited: the zero and burn addresses, the token itself, the Uniswap v4 PoolManager (it holds
 *  every v4 pool's tokens, including the $ANYR/ETH pool), the escrow wallet, the CallPay treasury,
 *  HOLDER_CREDITS_EXCLUDE (other pools, treasury, team wallets...) and any extra addresses. */
export function defaultExclusions(cfg: Config, extra: string[] = []) {
  const all = [ZERO, BURN, cfg.holders.token?.address, cfg.chain.poolManager, cfg.escrow.address, cfg.chain.callPayTreasury, ...cfg.holders.exclude, ...extra];
  return new Set(all.filter((a): a is string => !!a).map((a) => a.toLowerCase()));
}
export const creditRef = (period: string, address: string) => `holder-credits:${period}:${address.toLowerCase()}`;
export const validPeriod = (p: string) => /^[A-Za-z0-9._-]{1,32}$/.test(p);

// ---- chain access (a small surface, so tests can stand in for the RPC node) ---------------------

export type TransferLog = { from: string; to: string; value: bigint };
export type SnapshotChain = {
  /** The latest block the chain reports as final. */
  finalizedBlock(): Promise<bigint>;
  headBlock(): Promise<bigint>;
  decimals(token: Hex): Promise<number>;
  /** The token's Transfer logs in [from, to]. */
  transfers(token: Hex, from: bigint, to: bigint): Promise<TransferLog[]>;
  /** balanceOf at `block`, or at the latest block when `block` is undefined. */
  balanceOf(token: Hex, holder: Hex, block?: bigint): Promise<bigint>;
  /** Whether the address has contract code now (an EIP-7702 delegated wallet is not a contract). */
  isContract(address: Hex): Promise<boolean>;
};

const transferEvent = { type: "event", name: "Transfer", inputs: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "value", type: "uint256", indexed: false }] } as const;

export function viemSnapshotChain(client: PublicClient): SnapshotChain {
  return {
    async finalizedBlock() {
      return (await client.getBlock({ blockTag: "finalized" })).number;
    },
    headBlock: () => client.getBlockNumber(),
    async decimals(token) {
      return Number(await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }));
    },
    async transfers(token, from, to) {
      const logs = await client.getLogs({ address: token, event: transferEvent, fromBlock: from, toBlock: to, strict: true });
      return logs.map((l) => ({ from: l.args.from.toLowerCase(), to: l.args.to.toLowerCase(), value: l.args.value }));
    },
    async balanceOf(token, holder, block) {
      return (await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder], ...(block === undefined ? {} : { blockNumber: block }) })) as bigint;
    },
    async isContract(address) {
      const code = await client.getCode({ address });
      return !!code && code !== "0x" && !code.toLowerCase().startsWith("0xef0100"); // 0xef0100<address>: EIP-7702 delegation
    },
  };
}

// ---- snapshot ------------------------------------------------------------------------------------

export type Holding = { address: string; balance: bigint };
export type Snapshot = {
  block: bigint;
  decimals: number;
  /** Addresses that ever received the token up to `block`, less the excluded ones. */
  candidates: number;
  holdings: Holding[];
  /** Holders with contract code (pools, vaults...), left out unless contracts are included. */
  contracts: string[];
  /** "archive": balanceOf read at `block`. "logs": Transfer logs replayed to `block`, then checked with
   *  balanceOf at the latest block for every holder whose balance has not moved since. */
  source: "archive" | "logs";
  /** Holders whose replayed balance was confirmed by balanceOf. */
  verified: number;
  /** Holders whose balance moved after `block` (their snapshot balance comes from the replayed logs). */
  moved: number;
};

const TRANSIENT = /too many requests|429|rate.?limit|timed? ?out|timeout|ECONNRESET|socket|fetch failed|503|502/i;
/** Retry a read the node turned away for load (public RPCs rate-limit bursts): 0.5 s, 1 s, 2 s... up to 6 tries. */
export async function retrying<T>(fn: () => Promise<T>, tries = 6, baseMs = 500): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries || !TRANSIENT.test(String((err as Error)?.message ?? err))) throw err;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** (i - 1)));
    }
  }
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await retrying(() => fn(items[i]));
      }
    }),
  );
  return out;
}

/** Scan Transfer logs over [from, to] in chunks; a chunk the node refuses (too wide, too many logs) is halved. */
async function scanTransfers(chain: SnapshotChain, token: Hex, from: bigint, to: bigint, chunk: bigint, each: (l: TransferLog) => void, progress?: (msg: string) => void) {
  let size = chunk;
  for (let start = from; start <= to; ) {
    const end = start + size - 1n < to ? start + size - 1n : to;
    try {
      for (const l of await retrying(() => chain.transfers(token, start, end))) each(l);
      progress?.(`scanned blocks ${start}-${end}`);
      start = end + 1n;
    } catch (err) {
      if (size <= 1n) throw err;
      size /= 2n;
      progress?.(`getLogs refused ${start}-${end}; retrying with ${size}-block chunks`);
    }
  }
  return size;
}

/**
 * $ANYR balances at `block` (default: the latest final block). Transfer logs from `fromBlock` (the
 * deploy block) to `block` are replayed into balances. The chain then has the last word:
 * - on a node that keeps historical state, every balance is read with balanceOf at `block`;
 * - on one that does not (the public Robinhood Chain RPC keeps no state even for the final block),
 *   every holder is read with balanceOf at the latest block, and each holder whose balance has not
 *   moved since `block` must match its replayed balance exactly, or the snapshot is refused (the token
 *   would not be a plain ERC-20, or logs were missed). Holders that moved since keep the replayed value.
 * Addresses in `exclude` are skipped; with `excludeContracts` (default) holders that have contract code
 * are reported in `contracts` instead of `holdings`.
 */
export async function takeSnapshot(
  chain: SnapshotChain,
  o: { token: Hex; fromBlock: bigint; block?: bigint; chunk?: bigint; exclude?: Set<string>; excludeContracts?: boolean; minRaw?: bigint; concurrency?: number; progress?: (msg: string) => void },
): Promise<Snapshot> {
  const block = o.block ?? (await chain.finalizedBlock());
  if (o.fromBlock > block) throw new Error(`The deploy block ${o.fromBlock} is after the snapshot block ${block}.`);
  const token = o.token;
  const decimals = await chain.decimals(token);
  const conc = o.concurrency ?? 4;
  const replay = new Map<string, bigint>();
  const chunk = await scanTransfers(chain, token, o.fromBlock, block, o.chunk ?? 50_000n, (l) => {
    replay.set(l.from, (replay.get(l.from) ?? 0n) - l.value);
    replay.set(l.to, (replay.get(l.to) ?? 0n) + l.value);
  }, o.progress);
  const exclude = o.exclude ?? new Set<string>();
  const candidates = [...replay.keys()].filter((a) => a !== ZERO && !exclude.has(a)).sort();
  const negative = candidates.find((a) => replay.get(a)! < 0n);
  if (negative) throw new Error(`Replaying Transfer logs left ${negative} with a negative balance; check the deploy block (ANYR_TOKEN_DEPLOY_BLOCK / --from-block).`);

  let source: Snapshot["source"] = "archive";
  let balances: bigint[] = [];
  let verified = 0;
  let moved = 0;
  if (candidates.length) {
    try {
      await retrying(() => chain.balanceOf(token, candidates[0] as Hex, block));
    } catch {
      source = "logs"; // this node keeps no state at `block` (the checked path below is safe either way)
    }
  }
  if (source === "archive") {
    balances = await pool(candidates, conc, (a) => chain.balanceOf(token, a as Hex, block));
    verified = candidates.filter((a, i) => balances[i] === replay.get(a)).length;
  } else {
    o.progress?.(`the RPC node has no state at block ${block}; checking replayed balances against the latest state`);
    const latest = await pool(candidates, conc, (a) => chain.balanceOf(token, a as Hex));
    // Read after the balances, so any transfer that could have changed one of them is in this range.
    const head = await chain.headBlock();
    const touched = new Set<string>();
    if (head > block) await scanTransfers(chain, token, block + 1n, head, chunk, (l) => (touched.add(l.from), touched.add(l.to)), o.progress);
    const wrong: string[] = [];
    candidates.forEach((a, i) => {
      if (touched.has(a)) moved++;
      else if (latest[i] === replay.get(a)) verified++;
      else wrong.push(`${a} (logs ${replay.get(a)}, balanceOf ${latest[i]})`);
    });
    if (wrong.length)
      throw new Error(`Transfer logs and balanceOf disagree for ${wrong.length} holder(s), e.g. ${wrong.slice(0, 3).join(", ")}. The token may not be a plain ERC-20; use an RPC node with historical state (RHC_RPC_URL) so balances are read at the snapshot block.`);
    balances = candidates.map((a) => replay.get(a)!);
  }
  let holdings = candidates.map((address, i) => ({ address, balance: balances[i] })).filter((h) => h.balance > 0n);
  const contracts: string[] = [];
  if (o.excludeContracts ?? true) {
    const check = holdings.filter((h) => h.balance >= (o.minRaw ?? 0n)); // only holders that could be credited
    const code = await pool(check, conc, (h) => chain.isContract(h.address as Hex));
    check.forEach((h, i) => code[i] && contracts.push(h.address));
    const drop = new Set(contracts);
    holdings = holdings.filter((h) => !drop.has(h.address));
  }
  return { block, decimals, candidates: candidates.length, holdings, contracts, source, verified, moved };
}

// ---- allocation (pure) ---------------------------------------------------------------------------

export type Split = "pro-rata" | "equal";
export type AllocationRow = { address: string; balance: bigint; credit: Pico; capped: boolean };
export type Allocation = { rows: AllocationRow[]; eligible: number; belowMin: number; excluded: number; total: Pico; unallocated: Pico };

/**
 * Split `budget` (pico-USD, spent in whole micro-dollars) across holdings with balance >= `minRaw`.
 * Pro-rata by balance by default, or equally. With `max`, no wallet gets more than `max`: whatever a
 * capped wallet would have received beyond the cap is re-split among the others, and only what no
 * one can take (everyone capped) is left unallocated. Excluded addresses never receive anything.
 */
export function allocateCredits(o: { holdings: Holding[]; minRaw: bigint; budget: Pico; max?: Pico | null; split?: Split; exclude?: Set<string> }): Allocation {
  const exclude = o.exclude ?? new Set<string>();
  const kept = o.holdings.filter((h) => !exclude.has(h.address.toLowerCase()));
  const eligible = kept
    .filter((h) => h.balance > 0n && h.balance >= o.minRaw)
    .sort((a, b) => (a.balance === b.balance ? (a.address < b.address ? -1 : 1) : a.balance > b.balance ? -1 : 1));
  const budget = o.budget / MICRO;
  const cap = o.max == null ? null : o.max / MICRO;
  const credit = new Map<string, { micro: bigint; capped: boolean }>();
  let remaining = budget;
  let open = eligible;
  while (open.length && remaining > 0n) {
    const shares = allocate(remaining, open.map((h) => (o.split === "equal" ? 1n : h.balance)));
    const over = cap == null ? [] : open.filter((_, i) => shares[i] > cap);
    if (!over.length) {
      open.forEach((h, i) => credit.set(h.address, { micro: shares[i], capped: false }));
      remaining = 0n;
      break;
    }
    for (const h of over) credit.set(h.address, { micro: cap!, capped: true });
    remaining -= cap! * BigInt(over.length);
    const capped = new Set(over.map((h) => h.address));
    open = open.filter((h) => !capped.has(h.address));
  }
  const rows = eligible.map((h) => {
    const c = credit.get(h.address) ?? { micro: 0n, capped: false };
    return { address: h.address.toLowerCase(), balance: h.balance, credit: c.micro * MICRO, capped: c.capped };
  });
  const total = rows.reduce((s, r) => s + r.credit, 0n);
  return { rows, eligible: eligible.length, belowMin: kept.length - eligible.length, excluded: o.holdings.length - kept.length, total, unallocated: o.budget - total };
}

// ---- apply (idempotent) --------------------------------------------------------------------------

export type ApplyResult = { credited: number; alreadyCredited: number; creditedTotal: Pico; skippedZero: number };

/** Credit each row to its wallet account. A (period, address) pair is credited at most once, ever. */
export async function applyCredits(db: Db, o: { period: string; symbol: string; rows: AllocationRow[] }): Promise<ApplyResult> {
  if (!validPeriod(o.period)) throw new Error("period must be 1-32 characters of letters, digits, '.', '_' or '-'.");
  const res: ApplyResult = { credited: 0, alreadyCredited: 0, creditedTotal: 0n, skippedZero: 0 };
  for (const r of o.rows) {
    if (r.credit <= 0n) {
      res.skippedZero++;
      continue;
    }
    const address = r.address.toLowerCase();
    const inserted = await db.transaction(async (tx) => {
      await ensureAccount(tx, walletAccount(address), "wallet", address);
      return post(tx, { accountId: walletAccount(address), amount: r.credit, kind: CREDIT_KIND, ref: creditRef(o.period, address), description: `$${o.symbol} holder credits for ${o.period}` });
    });
    if (inserted) {
      res.credited++;
      res.creditedTotal += r.credit;
    } else res.alreadyCredited++;
  }
  return res;
}

/** One queryable summary row per --apply run: kv key `holder-credits-run:<period>:<ISO time>`. */
export async function recordRun(db: Db, period: string, summary: Record<string, unknown>) {
  const at = new Date().toISOString();
  const key = `holder-credits-run:${period}:${at}`;
  await db.insert(kv).values({ key, value: { period, at, ...summary } });
  return key;
}

/** Holder credits a wallet account received, newest first. */
export async function holderCreditsFor(db: Db, accountId: string) {
  const rows = await db
    .select({ ref: ledger.ref, amount: ledger.amount, at: ledger.createdAt })
    .from(ledger)
    .where(and(eq(ledger.accountId, accountId), eq(ledger.kind, CREDIT_KIND)))
    .orderBy(desc(ledger.createdAt), desc(ledger.ref))
    .limit(100);
  return rows.map((r) => ({ period: r.ref.split(":")[1] ?? "", usd: picoToUsd(r.amount), at: r.at.toISOString() }));
}
