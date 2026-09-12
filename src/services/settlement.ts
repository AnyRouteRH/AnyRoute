import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { keccak256, toBytes, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { accounts, chainEvents, generations, keys, kv, ledger, models, payouts, providers, royalties, settlements, spentRoots } from "../db/schema.ts";
import { mulBps, picoToUsdg, PICO_PER_USDG_UNIT } from "../lib/money.ts";
import { log, uid } from "../lib/util.ts";
import { MerkleTree, spentLeaf } from "../receipts/merkle.ts";

// settlement (hourly):
//  1. provider invoices from receipts (per provider per hour): upstream cost, 2% provider-side fee
//  2. weekly USDG payouts to providers that opted into on-chain payout
//  3. creator royalty streams per model per hour
//  4. prepaid spent roots: every funded key's cumulative on-chain spend, merkle-rooted and posted to
//     Credits so self-custodial withdrawals are provably bounded
//  5. protocol margin -> AnyrStaking.notifyMargin (50% buyback to stakers / 50% attestor+canary ops)

const hourKey = (d: Date) => d.toISOString().slice(0, 13);
const USAGE_KINDS = new Set(["usage"]);
