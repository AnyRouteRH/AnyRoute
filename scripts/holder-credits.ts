// "Hold $ANYR, get free AI credits": snapshot $ANYR balances at one block and split a USD budget of
// inference credits across holders. DRY RUN by default (prints the table, writes nothing); --apply
// credits each holder's wallet account once per --period (re-running a period never double-credits).
//
//   bun scripts/holder-credits.ts --budget-usd 500 [--min 100000] [--max-usd 25] [--equal]
//       [--period 2026-09] [--block <n>] [--from-block <n>] [--chunk 50000] [--concurrency 4] [--exclude 0x..,0x..]
//       [--include-contracts] [--json] [--apply]
//
// Reads the router's configuration: ANYR_TOKEN_ADDRESS / ANYR_TOKEN_SYMBOL (the $ANYR escrow settings,
// which also need ANYR_POOL_LEGS), ANYR_TOKEN_DEPLOY_BLOCK, HOLDER_CREDITS_EXCLUDE and RHC_RPC_URL;
// --apply also needs DATABASE_URL (an already-migrated database).
import { formatUnits, parseUnits, type Hex } from "viem";
import { ChainService } from "../src/chain/service.ts";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/client.ts";
import { allocateCredits, applyCredits, defaultExclusions, recordRun, takeSnapshot, validPeriod, viemSnapshotChain } from "../src/holders/credits.ts";
import { picoToUsdString, usdToPico } from "../src/lib/money.ts";

const USAGE = `usage: bun scripts/holder-credits.ts --budget-usd <usd> [--min <tokens>] [--max-usd <usd>] [--equal]
         [--period <id>] [--block <n>] [--from-block <n>] [--chunk <blocks>] [--concurrency <n>] [--exclude <0x..,0x..>]
         [--include-contracts] [--json] [--apply]`;

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument ${a}.\n${USAGE}`);
    const [name, inline] = a.slice(2).split("=", 2);
    if (["equal", "apply", "json", "include-contracts", "help"].includes(name)) flags.set(name, true);
    else {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value.\n${USAGE}`);
      flags.set(name, v);
    }
  }
  const known = new Set(["budget-usd", "min", "max-usd", "equal", "period", "block", "from-block", "chunk", "concurrency", "exclude", "include-contracts", "json", "apply", "help"]);
  for (const k of flags.keys()) if (!known.has(k)) throw new Error(`Unknown flag --${k}.\n${USAGE}`);
  return flags;
}

const str = (f: Map<string, string | true>, k: string) => (typeof f.get(k) === "string" ? (f.get(k) as string) : undefined);
const usd = (v: string, name: string) => {
  if (!/^\d+(\.\d{1,6})?$/.test(v)) throw new Error(`--${name} must be a USD amount with up to 6 decimals.`);
  return usdToPico(v, "floor");
};
const block = (v: string | undefined, name: string) => {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new Error(`--${name} must be a block number.`);
  return BigInt(v);
};
const grouped = (raw: bigint, decimals: number) => {
  const [w, f = ""] = formatUnits(raw, decimals).split(".");
  const frac = f.slice(0, 4).replace(/0+$/, "");
  return w.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? "." + frac : "");
};
const money = (p: bigint) => {
  const [w, f = ""] = picoToUsdString(p).split(".");
  return "$" + w + "." + (f + "000000").slice(0, 6);
};

async function main() {
  const f = parseArgs(process.argv.slice(2));
  if (f.has("help")) return console.log(USAGE);
  const cfg = loadConfig();
  const token = cfg.holders.token;
  if (!token) throw new Error("Set ANYR_TOKEN_ADDRESS (with ANYR_POOL_LEGS, as for $ANYR escrow payments) first.");
  const budgetArg = str(f, "budget-usd");
  if (!budgetArg) throw new Error(`--budget-usd is required.\n${USAGE}`);
  const budget = usd(budgetArg, "budget-usd");
  if (budget <= 0n) throw new Error("--budget-usd must be positive.");
  const max = str(f, "max-usd") ? usd(str(f, "max-usd")!, "max-usd") : null;
  if (max !== null && max <= 0n) throw new Error("--max-usd must be positive.");
  const minTokens = str(f, "min") ?? "0";
  if (!/^\d+(\.\d{1,18})?$/.test(minTokens)) throw new Error("--min must be a token amount, e.g. 100000.");
  const apply = f.has("apply");
  const period = str(f, "period") ?? new Date().toISOString().slice(0, 7);
  if (!validPeriod(period)) throw new Error("--period must be 1-32 characters of letters, digits, '.', '_' or '-'.");
  if (apply && !str(f, "period")) throw new Error("--apply needs an explicit --period (for example --period 2026-09): the period is what makes a re-run credit nobody twice.");
  const fromBlock = block(str(f, "from-block"), "from-block") ?? cfg.holders.deployBlock;
  if (fromBlock === undefined) throw new Error("Set ANYR_TOKEN_DEPLOY_BLOCK (or pass --from-block): the block the token was deployed in.");
  const chunk = block(str(f, "chunk"), "chunk") ?? 50_000n;
  if (chunk <= 0n) throw new Error("--chunk must be positive.");
  const concurrency = Number(str(f, "concurrency") ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("--concurrency must be a whole number from 1 to 32 (parallel RPC reads).");
  const extra = (str(f, "exclude") ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  if (extra.some((a) => !/^0x[0-9a-fA-F]{40}$/.test(a))) throw new Error("--exclude must be a comma list of 0x addresses.");
  const exclude = defaultExclusions(cfg, extra);
  const json = f.has("json");
  const progress = (m: string) => json || console.error(m);

  const chain = viemSnapshotChain(new ChainService(cfg).client);
  const decimals = await chain.decimals(token.address as Hex);
  const minRaw = parseUnits(minTokens, decimals);
  const snap = await takeSnapshot(chain, { token: token.address as Hex, fromBlock, block: block(str(f, "block"), "block"), chunk, exclude, excludeContracts: !f.has("include-contracts"), minRaw, concurrency, progress });
  const split = f.has("equal") ? "equal" : "pro-rata";
  const alloc = allocateCredits({ holdings: snap.holdings, minRaw, budget, max, split, exclude });
  const settings = { token: token.address, symbol: token.symbol, block: snap.block.toString(), from_block: fromBlock.toString(), min_tokens: minTokens, budget_usd: picoToUsdString(budget), max_usd: max === null ? null : picoToUsdString(max), split };

  let applied: Awaited<ReturnType<typeof applyCredits>> | null = null;
  let runKey: string | null = null;
  if (apply) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("--apply needs DATABASE_URL.");
    const h = await openDatabase(url, { migrate: false });
    try {
      applied = await applyCredits(h.db, { period, symbol: token.symbol, rows: alloc.rows });
      runKey = await recordRun(h.db, period, {
        ...settings,
        holders: snap.holdings.length,
        eligible: alloc.eligible,
        contracts_excluded: snap.contracts.length,
        allocated_usd: picoToUsdString(alloc.total),
        credited: applied.credited,
        already_credited: applied.alreadyCredited,
        credited_usd: picoToUsdString(applied.creditedTotal),
      });
    } finally {
      await h.close();
    }
  }

  if (json) {
    const out = { period, dry_run: !apply, ...settings, balance_source: snap.source, verified: snap.verified, moved_since_snapshot: snap.moved, holders: snap.holdings.length, eligible: alloc.eligible, below_min: alloc.belowMin, contracts_excluded: snap.contracts, allocated_usd: picoToUsdString(alloc.total), unallocated_usd: picoToUsdString(alloc.unallocated), rows: alloc.rows.map((r) => ({ address: r.address, balance: formatUnits(r.balance, snap.decimals), credit_usd: picoToUsdString(r.credit), capped: r.capped })), applied: applied && { credited: applied.credited, already_credited: applied.alreadyCredited, credited_usd: picoToUsdString(applied.creditedTotal), run: runKey } };
    return console.log(JSON.stringify(out, null, 2));
  }
  console.log(`\n$${token.symbol} holder credits · period ${period} · snapshot at block ${snap.block} · ${split}${max !== null ? ` · cap ${money(max)} per wallet` : ""}`);
  console.log(`${"address".padEnd(44)}${("balance " + token.symbol).padStart(26)}${"credit".padStart(16)}`);
  for (const r of alloc.rows) console.log(`${r.address.padEnd(44)}${grouped(r.balance, snap.decimals).padStart(26)}${money(r.credit).padStart(16)}${r.capped ? "  capped" : ""}`);
  console.log(
    [
      "",
      snap.source === "archive"
        ? `balances: balanceOf at block ${snap.block}`
        : `balances: Transfer logs replayed to block ${snap.block} (this RPC keeps no state there); ${snap.verified} confirmed by balanceOf now, ${snap.moved} moved since the snapshot`,
      `holders with a balance: ${snap.holdings.length} (of ${snap.candidates} addresses that received the token from block ${fromBlock})`,
      `eligible (>= ${minTokens} ${token.symbol}): ${alloc.eligible} · below min: ${alloc.belowMin}`,
      `excluded: ${exclude.size} listed addresses, ${snap.contracts.length} contracts${snap.contracts.length ? ` (${snap.contracts.join(", ")})` : ""}`,
      `allocated: ${money(alloc.total)} of ${money(budget)}${alloc.unallocated > 0n ? ` (${money(alloc.unallocated)} unallocated)` : ""}`,
      applied
        ? `APPLIED: credited ${applied.credited} wallets ${money(applied.creditedTotal)}; ${applied.alreadyCredited} already credited for ${period}. Summary: kv ${runKey}`
        : `DRY RUN: nothing was written. Re-run with --apply --period ${period} to credit these wallets.`,
    ].join("\n"),
  );
  if (max === null && alloc.eligible > 1) console.log("note: no --max-usd cap, so the largest holders take most of the budget.");
}

main().catch((err) => {
  console.error(`holder-credits: ${(err as Error).message}`);
  process.exit(1);
});
