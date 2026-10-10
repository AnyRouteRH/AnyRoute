// B123: observe credits independently of the escrow crediting transaction.
import { and, eq, gt, isNull, isNotNull, inArray, sql } from "drizzle-orm";
import { formatUnits } from "viem";
import type { Ctx } from "../context.ts";
import { escrowDeposits, kv } from "../db/schema.ts";
import { acceptedTokens } from "./escrow.ts";
import { accountLinks, validPrincipal } from "../telegram/linking.ts";
import { sendLinkedAlert } from "../telegram/delivery.ts";
import { balanceOf } from "../ledger/ledger.ts";
import { picoToUsdString } from "../lib/money.ts";
import { activityAccess } from "../activity/access.ts";
export const depositPingKey = (ctx: Ctx, id: string) => `deposit-ping:${ctx.cfg.chain.id}:${id}`;
export type DepositPing = { accountId: string; depositId: string; at: string; amount: string };
const money = (pico: bigint) => {
  const cents = ((pico < 0n ? -pico : pico) + 5_000_000_000n) / 10_000_000_000n;
  return `${pico < 0n ? "-" : ""}$${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
};
export function depositPingText(amount: string, symbol: string, credited: bigint, balance: bigint) {
  const [whole, fraction] = amount.split(".");
  const tokens = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? `.${fraction}` : "");
  return `Your deposit of ${tokens} ${symbol === "ANYR" ? "$ANYR" : symbol} is credited: ${money(credited)} added. Balance: ${money(balance)}.`;
}
export async function runDepositPings(ctx: Ctx, fetchImpl?: typeof fetch) {
  if (!ctx.cfg.depositPingsEnabled || ctx.cfg.runtimeRole === "api") return { skipped: true };
  const tokens = acceptedTokens(ctx).filter(t => t.kind !== "usdg");
  if (!tokens.length) return { recorded: 0, sent: 0 };
  // Catch up to one day of credits; permanent markers prevent repeats across restarts and replicas.
  const rows = await ctx.db.select({ deposit: escrowDeposits }).from(escrowDeposits).leftJoin(kv, sql`${kv.key} = ${`deposit-ping:${ctx.cfg.chain.id}:`} || ${escrowDeposits.id}`).where(and(
    inArray(escrowDeposits.token, tokens.map(t => t.address.toLowerCase())), isNotNull(escrowDeposits.accountId), gt(escrowDeposits.credited, 0n),
    inArray(escrowDeposits.status, ["credited", "provisional"]), gt(escrowDeposits.creditedAt, new Date(Date.now() - 86_400_000)), isNull(kv.key),
  )).orderBy(escrowDeposits.creditedAt, escrowDeposits.id).limit(100);
  let recorded = 0, sent = 0;
  for (const { deposit } of rows) {
    const token = tokens.find(t => t.address.toLowerCase() === deposit.token);
    if (!deposit.accountId || deposit.credited === null || deposit.credited <= 0n || !token) continue;
    const value: DepositPing = { accountId: deposit.accountId, depositId: deposit.id, at: new Date().toISOString(), amount: picoToUsdString(deposit.credited) };
    // Claim commits before outbound delivery: interruptions can lose a send, never retry it ambiguously.
    const claim = await ctx.db.insert(kv).values({ key: depositPingKey(ctx, deposit.id), value }).onConflictDoNothing().returning({ key: kv.key });
    if (!claim.length) continue;
    recorded++;
    if (!ctx.cfg.telegram.linkingEnabled || !ctx.cfg.telegram.botToken) continue;
    const balance = (await balanceOf(ctx.db, deposit.accountId)).balance;
    const text = depositPingText(formatUnits(BigInt(deposit.rawAmount), token.decimals), deposit.symbol, deposit.credited, balance);
    for (const link of await accountLinks(ctx.db, deposit.accountId)) {
      // Only account-wide principals may receive the account balance. The existing sender rechecks unlink and authority.
      try {
        const principal = await validPrincipal(ctx, link);
        if (!(await activityAccess(ctx, principal)).whole || Date.parse(link.linked_at) > deposit.creditedAt!.getTime()) continue;
        if (await sendLinkedAlert(ctx, link, text, link.key_hash, fetchImpl, undefined, "deposits")) sent++; // E146
      } catch { /* Unavailable authority receives nothing. No account data enters logs. */ }
    }
  }
  return { recorded, sent };
}
