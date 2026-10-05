import { and, asc, eq, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Hex } from "viem";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { accounts, keys, teams } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { usdToPico, usdgToPico } from "../lib/money.ts";
import { log } from "../lib/util.ts";
import { escrowFinality, formatRaw, type EscrowFinal } from "../pay/escrow.ts";
import { guardUsd } from "./guard-input.ts";
import { agentProfiles } from "./profile-schema.ts";
import { profileSlug } from "./profiles.ts";
import { agentPayments, type AgentPaymentStatus } from "./pay-schema.ts";
import { lockAccount } from "./store.ts";

// Pay another agent. Anyroute never holds, routes or custodies the money: the paying agent's own wallet sends USDG on
// Robinhood Chain straight to the recipient's wallet. The router only (a) decides with the payer's rulebook through
// Agent Guard (action pay.agent), (b) finds the transfer on chain afterwards and (c) signs a receipt that links the
// decision to that transfer. No balance moves inside Anyroute.
//
// Verification reuses the escrow watcher's chain reads (src/pay/escrow.ts): the transaction's canonical receipt and
// its ERC-20 Transfer logs to the recipient, the canonical block hash, and the ESCROW_FINALITY point (with
// CHAIN_CONFIRMATIONS as a floor). A transfer above that point is "seen" (waiting for finality); at or below it, "final".
// Re-verification is lazy (every read of a seen payment, and of a final one within ESCROW_REORG_HORIZON_BLOCKS at most
// every 10 minutes) plus the agent-pay-verify job. A transfer that leaves the canonical chain makes the receipt "reversed".

export const PAY_ACTION = "pay.agent";
export const USDG_DECIMALS = 6;
const RECHECK_AFTER_MS = 10 * 60_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;

export const payInput = z.strictObject({
  to: z.string().min(1).max(64),
  amount_usd: guardUsd.refine(v => usdToPico(v, "ceil") > 0n, "amount_usd must be more than zero"),
  memo_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  approval_id: z.string().min(1).max(64).optional(),
});
export const confirmInput = z.strictObject({ tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "tx_hash must be a 0x transaction hash") });

type Row = typeof agentPayments.$inferSelect;
export type Recipient = { target: string; wallet: string; profile: string | null; keyHash: string | null };

const usdgAddress = (ctx: Ctx) => ctx.cfg.chain.usdg.toLowerCase();
/** USD amounts here carry at most 6 decimals, so they map exactly onto USDG base units. */
export const usdToUnits = (usd: string) => usdToPico(usd, "ceil") / 10n ** 6n;
export const unitsToUsd = (units: bigint) => formatRaw(units, USDG_DECIMALS);
export const payReference = (decisionId: string) => `pay-${decisionId.slice(0, 8)}`;
const live = and(eq(keys.disabled, false), sql`(${keys.expiresAt} is null or ${keys.expiresAt} > now())`);

/** A public profile id with a published payout wallet, or a raw 0x wallet (linked to an agent when exactly one live profile publishes it). */
export async function resolveRecipient(ctx: Ctx, to: string): Promise<Recipient> {
  if (ADDRESS.test(to)) {
    const wallet = to.toLowerCase();
    if (ZERO.test(wallet)) fail(400, "The recipient wallet cannot be the zero address.", "invalid_request");
    if (wallet === usdgAddress(ctx)) fail(400, "The recipient cannot be the USDG token contract.", "invalid_request");
    const agents = ctx.cfg.agentProfilesEnabled ? await ctx.db.select({ slug: agentProfiles.slug, keyHash: agentProfiles.keyHash }).from(agentProfiles).innerJoin(keys, eq(keys.keyHash, agentProfiles.keyHash))
      .where(and(live, sql`${agentProfiles.settings}->>'payout_wallet' = ${wallet}`)).limit(2) : [];
    const agent = agents.length === 1 ? agents[0]! : null;
    return { target: wallet, wallet, profile: agent?.slug ?? null, keyHash: agent?.keyHash ?? null };
  }
  if (!profileSlug.safeParse(to).success) fail(400, "Pay a public profile id or a 0x wallet address.", "invalid_request");
  if (!ctx.cfg.agentProfilesEnabled) fail(404, "Public profiles are not switched on at this router. Pay a 0x wallet address instead.", "not_found");
  const [row] = await ctx.db.select({ profile: agentProfiles }).from(agentProfiles).innerJoin(keys, eq(keys.keyHash, agentProfiles.keyHash)).where(and(eq(agentProfiles.slug, to), live));
  if (!row) fail(404, "Profile not found.", "not_found");
  const wallet = row.profile.settings.payout_wallet?.toLowerCase();
  if (!wallet || !ADDRESS.test(wallet)) fail(409, "This agent has not published a payout wallet.", "pay_no_payout_wallet");
  return { target: to, wallet, profile: to, keyHash: row.profile.keyHash };
}

/** Wallets linked to an account: its wallet sign-in wallet, and the signature-verified owner wallet of each organisation it owns. */
export async function linkedWallets(db: Db | Tx, accountId: string): Promise<string[]> {
  const [account] = await db.select({ wallet: accounts.wallet }).from(accounts).where(eq(accounts.id, accountId));
  const owned = await db.select({ wallet: teams.ownerAddress }).from(teams).where(and(eq(teams.ownerAccount, accountId), isNotNull(teams.ownerAddress), isNotNull(teams.ownerVerifiedAt)));
  return [...new Set([account?.wallet, ...owned.map(o => o.wallet)].filter((w): w is string => !!w && ADDRESS.test(w)).map(w => w.toLowerCase()))].sort();
}

export const NOT_LINKED = "No wallet is linked to this account. Pay from the wallet you signed in with (wallet sign-in creates the account), or from the verified owner wallet of an organisation this account owns.";

/** What the paying wallet sends. An unsigned ERC-20 transfer only: the router never signs or sends a transaction here. */
export function payInstructions(ctx: Ctx, row: Pick<Row, "decisionId" | "recipientWallet" | "recipientProfile" | "amountUnits">, from: string[]) {
  const token = usdgAddress(ctx);
  const data = "0xa9059cbb" + row.recipientWallet.slice(2).padStart(64, "0") + row.amountUnits.toString(16).padStart(64, "0");
  return {
    chain_id: ctx.cfg.chain.id, chain_name: ctx.cfg.chain.id === 4663 ? "Robinhood Chain" : `Chain ${ctx.cfg.chain.id}`, rpc_url: ctx.cfg.chain.publicRpcUrl, explorer_url: ctx.cfg.chain.explorerUrl,
    token: { symbol: "USDG", address: token, decimals: USDG_DECIMALS },
    to: row.recipientWallet, recipient: { wallet: row.recipientWallet, profile_id: row.recipientProfile },
    amount: unitsToUsd(row.amountUnits), amount_units: row.amountUnits.toString(), reference: payReference(row.decisionId),
    from, ...(from.length ? {} : { warning: NOT_LINKED }),
    transfer_call: { to: token, data, value: "0x0" },
    confirm: `/api/v1/agents/pay/${row.decisionId}/confirm`,
    custody: "Anyroute never holds the money. Send it from your own wallet straight to the recipient, then confirm with the transaction hash.",
  };
}

const STATUS_TEXT: Record<AgentPaymentStatus, string> = {
  awaiting_transfer: "Waiting for the transfer from your wallet",
  seen: "Seen, waiting for finality",
  final: "Final",
  reversed: "Reversed: the transfer left the canonical chain",
};
export const payStatusText = (status: AgentPaymentStatus) => STATUS_TEXT[status];

/** The signed statement: this decision, under this rulebook, is linked to this on-chain transfer. */
export function receiptPayload(ctx: Ctx, row: Row) {
  return {
    type: "anyroute.agent.payment.v1", status: row.status, decision_id: row.decisionId, policy_sha256: row.policySha256,
    payer: { account_id: row.accountId, key_hash: row.keyHash, wallet: row.payerWallet },
    recipient: { wallet: row.recipientWallet, profile_id: row.recipientProfile },
    amount: { token: "USDG", token_address: usdgAddress(ctx), decimals: USDG_DECIMALS, allowed_units: row.amountUnits.toString(), paid_units: row.paidUnits?.toString() ?? null, allowed_usd: unitsToUsd(row.amountUnits), paid_usd: row.paidUnits === null ? null : unitsToUsd(row.paidUnits) },
    memo_sha256: row.memoSha256, chain_id: ctx.cfg.chain.id, tx_hash: row.txHash, log_index: row.logIndex,
    block: { number: row.blockNumber?.toString() ?? null, hash: row.blockHash },
    verified_at: row.verifiedAt?.toISOString() ?? null, status_at: row.statusAt.toISOString(), ...(row.reason ? { reason: row.reason } : {}),
    custody: "none: sent wallet to wallet; Anyroute never held the money",
  };
}
function signed(ctx: Ctx, row: Row) {
  const payload = receiptPayload(ctx, row);
  const s = ctx.signer.sign(payload);
  return { receipt: payload, receiptSig: s.sig, receiptKeyId: s.keyId };
}

export function paymentJson(ctx: Ctx, row: Row, from: string[] = []) {
  return {
    decision_id: row.decisionId, status: row.status, status_text: payStatusText(row.status), status_at: row.statusAt.toISOString(),
    recipient: { wallet: row.recipientWallet, profile_id: row.recipientProfile }, amount: unitsToUsd(row.amountUnits), amount_units: row.amountUnits.toString(),
    paid: row.paidUnits === null ? null : unitsToUsd(row.paidUnits), tx_hash: row.txHash, block_number: row.blockNumber?.toString() ?? null,
    payer_wallet: row.payerWallet, verified_at: row.verifiedAt?.toISOString() ?? null, ...(row.reason ? { reason: row.reason } : {}),
    ...(row.status === "awaiting_transfer" ? { instructions: payInstructions(ctx, row, from) } : {}),
    receipt: row.receiptSig ? { payload: row.receipt, alg: "Ed25519", key_id: row.receiptKeyId, sig: row.receiptSig, verify: "/api/v1/receipts/verify" } : null,
  };
}

const rightChain = new WeakMap<Ctx, Promise<boolean>>();
/** The router reads the chain it is configured for (CHAIN_ID); checked once per process, again after a failure. */
async function onConfiguredChain(ctx: Ctx) {
  let p = rightChain.get(ctx);
  if (!p) { p = ctx.chain.client.getChainId().then(id => id === ctx.cfg.chain.id); rightChain.set(ctx, p); }
  const ok = await p.catch(() => false);
  if (!ok) rightChain.delete(ctx);
  return ok;
}

type Found = { blockNumber: bigint; blockHash: string; logIndex: number; from: string; value: bigint };
/**
 * The USDG Transfer in `txHash` that pays this decision: sent to the recipient, from one of `wallets`, for at least the
 * decided amount, in a successful transaction whose block is canonical. Fails with the specific reason otherwise.
 */
async function findTransfer(ctx: Ctx, row: Row, txHash: string, wallets: string[], used: Set<number>): Promise<Found> {
  if (!(await onConfiguredChain(ctx))) fail(503, "The router could not confirm it is reading Robinhood Chain. Nothing was verified; confirm again shortly.", "pay_chain_unavailable");
  const r = await ctx.chain.escrowReceipt(txHash as Hex, row.recipientWallet as Hex);
  if (!r) fail(409, "That transaction is not on the chain yet. Wait until it is mined, then confirm again.", "pay_tx_not_found");
  if (!r.success) fail(422, "That transaction failed on chain, so no USDG moved.", "pay_tx_failed");
  const canonical = (await ctx.chain.blockHashAt(r.blockNumber))?.toLowerCase();
  if (!canonical || canonical !== r.blockHash.toLowerCase()) fail(503, "The chain node returned inconsistent block data. Confirm again shortly.", "pay_chain_unavailable");
  const usdg = r.transfers.filter(t => t.token.toLowerCase() === usdgAddress(ctx) && t.value > 0n);
  if (!usdg.length) fail(422, `That transaction has no USDG transfer to ${row.recipientWallet}.`, "pay_transfer_not_found");
  const linked = usdg.filter(t => wallets.includes(t.from.toLowerCase()));
  if (!linked.length) fail(403, `The USDG was sent from ${usdg[0]!.from.toLowerCase()}, which is not linked to this account. ${NOT_LINKED}`, "pay_wallet_not_linked");
  const enough = linked.filter(t => t.value >= row.amountUnits);
  if (!enough.length) fail(422, `The transfer is less than the ${unitsToUsd(row.amountUnits)} USDG this payment was allowed for.`, "pay_amount_short");
  const t = enough.filter(t => !used.has(t.logIndex)).sort((a, b) => a.logIndex - b.logIndex)[0];
  if (!t) fail(409, "That transfer already confirms another payment.", "pay_transfer_used");
  return { blockNumber: r.blockNumber, blockHash: canonical, logIndex: t.logIndex, from: t.from.toLowerCase(), value: t.value };
}

/** Confirm an allowed payment with its transaction. The caller has checked ownership. */
export async function confirmPayment(ctx: Ctx, row: Row, txHash: string, recordOutcome: (tx: Tx, paidPico: bigint, now: Date) => Promise<void>) {
  const hash = txHash.toLowerCase();
  if (row.txHash) {
    if (row.txHash !== hash) fail(409, "This payment is already confirmed by another transaction.", "pay_already_confirmed");
    return refreshPayment(ctx, row);
  }
  const wallets = await linkedWallets(ctx.db, row.accountId);
  if (!wallets.length) fail(403, NOT_LINKED, "pay_wallet_not_linked");
  const used = new Set((await ctx.db.select({ logIndex: agentPayments.logIndex }).from(agentPayments).where(eq(agentPayments.txHash, hash))).map(r => r.logIndex!));
  const found = await findTransfer(ctx, row, hash, wallets, used);
  const fin = await escrowFinality(ctx);
  const status: AgentPaymentStatus = found.blockNumber <= fin.creditable ? "final" : "seen";
  const now = new Date();
  try {
    return await ctx.db.transaction(async tx => {
      await lockAccount(tx, row.accountId);
      const [current] = await tx.select().from(agentPayments).where(eq(agentPayments.decisionId, row.decisionId)).for("update");
      if (!current || current.status !== "awaiting_transfer") fail(409, "This payment was confirmed in the meantime. Read it again.", "pay_already_confirmed");
      const next: Row = { ...current, status, statusAt: now, txHash: hash, logIndex: found.logIndex, blockNumber: found.blockNumber, blockHash: found.blockHash, payerWallet: found.from, paidUnits: found.value, verifiedAt: now, checkedAt: now, reason: null };
      await recordOutcome(tx, usdgToPico(found.value), now);
      const [saved] = await tx.update(agentPayments).set({ ...pick(next), ...signed(ctx, next) }).where(eq(agentPayments.decisionId, row.decisionId)).returning();
      return saved!;
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505" || /agent_payments_transfer_uq/.test(String((e as Error).message))) fail(409, "That transfer already confirms another payment.", "pay_transfer_used");
    throw e;
  }
}
const pick = (r: Row) => ({ status: r.status, statusAt: r.statusAt, txHash: r.txHash, logIndex: r.logIndex, blockNumber: r.blockNumber, blockHash: r.blockHash, payerWallet: r.payerWallet, paidUnits: r.paidUnits, verifiedAt: r.verifiedAt, checkedAt: r.checkedAt, reason: r.reason });

type Recheck = { status: AgentPaymentStatus; blockNumber: bigint; blockHash: string; logIndex: number; reason: string | null } | { unknown: string };
/** Where the recorded transfer stands now: still canonical (and final or not), moved to another block, or gone. */
async function recheck(ctx: Ctx, row: Row, fin: EscrowFinal): Promise<Recheck> {
  const recorded = row.blockNumber!, canonical = (await ctx.chain.blockHashAt(recorded))?.toLowerCase();
  if (!canonical) return { unknown: `block ${recorded} is not available from the chain node yet` };
  let at = { blockNumber: recorded, blockHash: canonical, logIndex: row.logIndex! };
  if (canonical !== row.blockHash || (row.status === "seen" && recorded <= fin.creditable)) {
    const r = await ctx.chain.escrowReceipt(row.txHash as Hex, row.recipientWallet as Hex);
    const reversed = (reason: string): Recheck => ({ status: "reversed", ...at, reason });
    if (!r) return reversed("the transaction is no longer on the canonical chain");
    if (!r.success) return reversed("the transaction reverted");
    const same = (t: { token: Hex; from: Hex; value: bigint }) => t.token.toLowerCase() === usdgAddress(ctx) && t.from.toLowerCase() === row.payerWallet && t.value === row.paidUnits;
    const log = r.transfers.find(t => t.logIndex === row.logIndex && same(t)) ?? r.transfers.find(same);
    if (!log) return reversed("the transaction no longer contains this transfer");
    const hash = r.blockNumber === recorded ? canonical : (await ctx.chain.blockHashAt(r.blockNumber))?.toLowerCase();
    if (!hash || hash !== r.blockHash.toLowerCase()) return { unknown: "the chain node returned inconsistent block and receipt data" };
    at = { blockNumber: r.blockNumber, blockHash: hash, logIndex: log.logIndex };
  }
  if (row.status === "final" && at.blockNumber > fin.creditable) return { unknown: `the transaction moved to block ${at.blockNumber}, which is not final yet` };
  return { status: at.blockNumber <= fin.creditable ? "final" : "seen", ...at, reason: null };
}

/** Lazy re-verification on read: every seen payment, and a final one inside the reorganization horizon when due. */
export async function refreshPayment(ctx: Ctx, row: Row, opts: { fin?: EscrowFinal; force?: boolean } = {}): Promise<Row> {
  if (row.status !== "seen" && row.status !== "final") return row;
  const fin = opts.fin ?? (await escrowFinality(ctx));
  if (row.status === "final") {
    const inHorizon = row.blockNumber! >= fin.final - BigInt(ctx.cfg.escrow.reorgHorizonBlocks);
    const due = !row.checkedAt || row.checkedAt.getTime() < Date.now() - RECHECK_AFTER_MS;
    if (!inHorizon || (!due && !opts.force)) return row;
  }
  const v = await recheck(ctx, row, fin);
  if ("unknown" in v) {
    log.warn("agent payment could not be re-verified yet", { id: row.decisionId, reason: v.unknown });
    return row;
  }
  const now = new Date(), changed = v.status !== row.status || v.blockNumber !== row.blockNumber || v.blockHash !== row.blockHash || v.logIndex !== row.logIndex;
  const next: Row = { ...row, checkedAt: now, blockNumber: v.blockNumber, blockHash: v.blockHash, logIndex: v.logIndex, ...(v.status !== row.status ? { status: v.status, statusAt: now, reason: v.reason } : {}) };
  const set = changed ? { ...pick(next), ...signed(ctx, next) } : { checkedAt: now };
  const [saved] = await ctx.db.update(agentPayments).set(set).where(and(eq(agentPayments.decisionId, row.decisionId), eq(agentPayments.status, row.status), eq(agentPayments.txHash, row.txHash!))).returning();
  if (saved && v.status === "reversed") log.error("agent payment reversed: its transfer left the canonical chain", { id: row.decisionId, tx: row.txHash, reason: v.reason });
  return saved ?? row;
}

/** The agent-pay-verify job: settle seen payments and re-check final ones inside the horizon. */
export async function runAgentPayVerify(ctx: Ctx, limit = 100) {
  const fin = await escrowFinality(ctx);
  const p = agentPayments, horizon = fin.final - BigInt(ctx.cfg.escrow.reorgHorizonBlocks);
  const due = or(isNull(p.checkedAt), lt(p.checkedAt, new Date(Date.now() - RECHECK_AFTER_MS)));
  const rows = await ctx.db.select().from(p).where(or(eq(p.status, "seen"), and(eq(p.status, "final"), gte(p.blockNumber, horizon), due))).orderBy(sql`${p.checkedAt} asc nulls first`, asc(p.blockNumber)).limit(limit);
  const out = { checked: rows.length, final: 0, reversed: 0, unknown: 0 };
  for (const row of rows) {
    try {
      const next = await refreshPayment(ctx, row, { fin, force: true });
      if (next.status === "final" && row.status !== "final") out.final++;
      else if (next.status === "reversed") out.reversed++;
      else if (next === row) out.unknown++;
    } catch (err) {
      out.unknown++;
      log.warn("agent payment re-verification failed", { id: row.decisionId, reason: (err as Error).message.slice(0, 200) });
    }
  }
  return out;
}
