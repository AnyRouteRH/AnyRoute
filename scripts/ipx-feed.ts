// Compute the latest hourly IPX value for one class and, only with --send, post it to an IPXFeed.
// DRY RUN by default: prints the snapshot and the IPXFeed.update arguments, sends nothing.
//
//   bun scripts/ipx-feed.ts --class IPX-OPEN-70B [--json]
//   bun scripts/ipx-feed.ts --class IPX-OPEN-70B --feed 0x... --send
//
// Reads the router's configuration (IPX_CLASSES, IPX_THIN_USDG, IPX_MAX_ACCOUNT_SHARE_BPS,
// IPX_ATTESTED_ONLY, DATABASE_URL, RHC_RPC_URL, CHAIN_ID). --send also needs IPX_KEEPER_PRIVATE_KEY, the
// key of the feed's keeper; run it from a worker that holds no other signing key. It skips an hour the
// feed already has an update for, and never posts when there is no price or no receipt root.
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/client.ts";
import { decimalString, feedUpdate, ipxFeedAbi, ipxSnapshot, snapshotJson } from "../src/services/ipx.ts";

const USAGE = "usage: bun scripts/ipx-feed.ts --class <IPX-...> [--feed <0x..> --send] [--json]";

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument ${a}.\n${USAGE}`);
    const name = a.slice(2);
    if (["send", "json", "help"].includes(name)) flags.set(name, true);
    else if (["class", "feed"].includes(name)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value.\n${USAGE}`);
      flags.set(name, v);
    } else throw new Error(`Unknown flag --${name}.\n${USAGE}`);
  }
  return flags;
}

async function main() {
  const f = parseArgs(process.argv.slice(2));
  if (f.has("help")) return console.log(USAGE);
  const cfg = loadConfig();
  const className = String(f.get("class") ?? "").toUpperCase();
  const cls = cfg.ipx.classes.find((k) => k.id === className);
  if (!cls) throw new Error(`--class must be one of: ${cfg.ipx.classes.map((k) => k.id).join(", ")}.`);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required.");
  const send = f.has("send");
  const feed = f.get("feed");
  if (send && !(typeof feed === "string" && /^0x[0-9a-fA-F]{40}$/.test(feed))) throw new Error("--send needs --feed <feed address>.");

  const h = await openDatabase(url, { migrate: false });
  let snapshot;
  try {
    snapshot = await ipxSnapshot({ db: h.db, cfg }, cls);
  } finally {
    await h.close();
  }
  const update = feedUpdate(snapshot);
  const out = { ...snapshotJson(snapshot, cls, cfg), dry_run: !send };
  if (f.has("json")) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`${out.description} · window ${out.window.from} to ${out.window.to}`);
    console.log(`price ${out.price ?? "none"} USDG per 1M tokens · 24h volume ${out.volume_usdg_24h} USDG · ${out.fills_24h} fills · ${out.thin ? "THIN" : "not thin"}`);
    console.log(update ? `update(answer=${update.answer}, receiptRoot=${update.receiptRoot}, volumeUsdg=${update.volumeUsdg})` : "nothing to post (no price or no receipt root for this hour)");
  }
  if (!send) return console.log("\nDry run: nothing was sent. Add --feed <address> --send to post it.");
  if (!update) return;

  const key = process.env.IPX_KEEPER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("--send needs IPX_KEEPER_PRIVATE_KEY (a 0x-prefixed 32-byte key).");
  const chain = defineChain({ id: cfg.chain.id, name: `Chain ${cfg.chain.id}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [cfg.chain.rpcUrl] } } });
  const pub = createPublicClient({ chain, transport: http(cfg.chain.rpcUrl) });
  const wallet = createWalletClient({ account: privateKeyToAccount(key as Hex), chain, transport: http(cfg.chain.rpcUrl) });
  const address = feed as Hex;
  const last = await pub.readContract({ address, abi: ipxFeedAbi, functionName: "latestRoundData" }).catch(() => null);
  if (last && Number(last[3]) >= Math.floor(snapshot.asOf.getTime() / 1000)) return console.log(`The feed already has an update for this hour (round ${last[0]}, answer ${decimalString(last[1], 8)}). Not sending.`);
  const hash = await wallet.writeContract({ address, abi: ipxFeedAbi, functionName: "update", args: [update.answer, update.receiptRoot, update.volumeUsdg] });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`Posted: ${hash}`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
