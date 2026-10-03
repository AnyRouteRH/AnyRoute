import { publishJuryStatementKey } from "./key-publication.ts";
import { and, eq } from "drizzle-orm";
import { createWalletClient, encodeFunctionData, http, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Ctx } from "../context.ts";
import { decrypt, encrypt } from "../lib/util.ts";
import { disputeOracleAbi } from "./abi.ts";
import { agreementJury } from "./schema.ts";
import { lockAgreementCursor } from "./indexer.ts";
import { readAgreement } from "./evidence.ts";
import { agreementScope } from "./state.ts";
import { guardAgreementSigners, signAgreementTally } from "./tally.ts";
import { recordJuryHeartbeat } from "./status.ts";
import type { Vote, Verdict } from "./jury.ts";
export type RulingTransport = { receipt?(hash: Hex): Promise<"pending" | "posted" | "reverted">; guard(): Promise<void>; prepare(id: string, root: Hex, votes: Vote[]): Promise<{ raw: Hex; hash: Hex }>; broadcast(raw: Hex, hash: Hex): Promise<"pending" | "posted" | "reverted"> };
export function rulingTransport(ctx: Ctx): RulingTransport {
  const cfg = ctx.cfg.agreements;
  const receipt = async (hash: Hex): Promise<"pending" | "posted" | "reverted"> => {
    try { const receipt = await ctx.chain.client.getTransactionReceipt({ hash }); return receipt.status === "success" ? "posted" : "reverted"; }
    catch (e) { if ((e as Error).name !== "TransactionReceiptNotFoundError") throw new Error("Agreement ruling receipt lookup unavailable."); return "pending"; }
  };
  return {
    receipt,
    guard: async () => {
      if (!cfg.signerKeys?.[0] || !cfg.oracle || !cfg.escrow) throw new Error("Agreement ruling configuration missing.");
      await guardAgreementSigners(ctx.chain.client, cfg.oracle, cfg.signerKeys!, cfg.threshold);
    },
    prepare: async (id, root, votes) => {
      const account = privateKeyToAccount(cfg.signerKeys?.[0]!);
      const wallet = createWalletClient({ account, chain: ctx.chain.chain, transport: http(ctx.cfg.chain.rpcUrl) });
      const [agreementId, milestone] = id.split(".").map(BigInt);
      const tally = await signAgreementTally(ctx.chain.client, cfg.escrow!, cfg.oracle!, agreementId, milestone, root, cfg.signerKeys!, votes);
      const args = [cfg.escrow!, agreementId, milestone, root, tally] as const;
      await ctx.chain.client.simulateContract({ account, address: cfg.oracle!, abi: disputeOracleAbi, functionName: "postRuling", args });
      const prepared = await wallet.prepareTransactionRequest({ account, chain: ctx.chain.chain, to: cfg.oracle!, data: encodeFunctionData({ abi: disputeOracleAbi, functionName: "postRuling", args }) });
      const raw = await wallet.signTransaction(prepared as never);
      return { raw, hash: keccak256(raw) };
    },
    broadcast: async (raw, hash) => {
      const status = await receipt(hash);
      if (status !== "pending") return status;
      try { await ctx.chain.client.sendRawTransaction({ serializedTransaction: raw }); } catch { throw new Error("Agreement ruling broadcast unresolved; durable intent retained."); }
      return "pending";
    },
  };
}
/** Never signs in dry run; signed bytes are committed before broadcast and reused on retries. */
export async function postAgreementRuling(ctx: Ctx, transport = rulingTransport(ctx)) {
  const cfg = ctx.cfg.agreements;
  if (!cfg.enabled) return { skipped: "disabled" };
  if (!cfg.rulings || !cfg.signerKeys?.[0]) return { skipped: "dry run" };
  if (!ctx.tlog) return { skipped: "jury key log required" };
  await transport.guard();
  // The keys match the oracle's jury on chain: tell the public API (GET /api/v1/status agreements.rulings).
  await recordJuryHeartbeat(ctx);
  const scope = agreementScope(ctx.cfg);
  const intent = await ctx.db.transaction(async tx => {
    const cursor = await lockAgreementCursor(tx, scope, cfg.startBlock);
    if (Date.now() - cursor.checkedAt.getTime() > 120000 || !cursor.blockHash || (await ctx.chain.blockHashAt(cursor.block))?.toLowerCase() !== cursor.blockHash) return null;
    const rows = await tx.select().from(agreementJury).where(eq(agreementJury.scope, scope)).orderBy(agreementJury.createdAt);
    // Only one outstanding chain nonce per isolated signer. Resolve it before preparing another ruling.
    const pending = rows.find(r => r.status === "submitted");
    for (const row of pending ? [pending] : rows.filter(r => r.status === "dry_run" || r.status === "panel")) {
      const a = await readAgreement(tx, scope, row.agreementId);
      if (row.status === "submitted" && row.postingTx && transport.receipt) {
        const status = await transport.receipt(row.postingTx as Hex);
        if (status !== "pending") {
          await tx.update(agreementJury).set({ status: status === "posted" ? "posted" : "posting_failed" }).where(and(eq(agreementJury.scope, scope), eq(agreementJury.agreementId, row.agreementId), eq(agreementJury.dispute, row.dispute)));
          return { finalized: status, hash: row.postingTx };
        }
      }
      if (!a || a.dispute !== row.dispute || a.state !== "disputed") { if (row.status === "submitted") return null; continue; }
      const statement = row.statement as { verdict: Verdict | null; votes: Vote[]; tally_bitmap: string; evidence_root: string; scope: string; dispute: string };
      if (statement.votes.length !== cfg.size || statement.votes.some(v => !v.verdict || v.verdict.verdict === "abstain" || !v.receipt_id || v.failure)) continue;
      if (statement.scope !== scope || statement.dispute !== row.dispute || statement.evidence_root !== row.root || !await ctx.signer.verify(row.statement, row.signature, row.keyId)) throw new Error("Invalid signed jury statement.");
      await publishJuryStatementKey(ctx, row.keyId);
      const prepared = row.postingRaw ? { raw: decrypt(ctx.cfg.appSecret, row.postingRaw) as Hex, hash: row.postingTx as Hex } : await transport.prepare(row.agreementId, row.root as Hex, statement.votes);
      if (!row.postingRaw) await tx.update(agreementJury).set({ status: "submitted", postingRaw: encrypt(ctx.cfg.appSecret, prepared.raw), postingTx: prepared.hash }).where(and(eq(agreementJury.scope, scope), eq(agreementJury.agreementId, row.agreementId), eq(agreementJury.dispute, row.dispute)));
      return { ...prepared, id: row.agreementId, dispute: row.dispute };
    }
    return null;
  });
  if (!intent) return { skipped: "nothing canonical and ready" };
  if ("finalized" in intent) return { status: intent.finalized, tx: intent.hash };
  // Recheck canonical state under the index lock before every broadcast, including durable retries.
  return ctx.db.transaction(async tx => {
    const cursor = await lockAgreementCursor(tx, scope, cfg.startBlock), a = await readAgreement(tx, scope, intent.id);
    if (!a || a.state !== "disputed" || a.dispute !== intent.dispute || !cursor.blockHash || Date.now() - cursor.checkedAt.getTime() > 120000 || (await ctx.chain.blockHashAt(cursor.block))?.toLowerCase() !== cursor.blockHash) return { skipped: "canonical state changed" };
    await transport.guard();
    const status = await transport.broadcast(intent.raw, intent.hash);
    if (status !== "pending") await tx.update(agreementJury).set({ status: status === "reverted" ? "posting_failed" : "posted" }).where(and(eq(agreementJury.scope, scope), eq(agreementJury.agreementId, intent.id), eq(agreementJury.dispute, intent.dispute)));
    return { status, tx: intent.hash };
  });
}
