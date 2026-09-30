import { and, eq } from "drizzle-orm";
import { encodeFunctionData, keccak256, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { providers } from "../db/schema.ts";
import { canonicalJson, decrypt, encrypt, log, sha256 } from "../lib/util.ts";
import type { HostPolicyBindings } from "./policy.ts";
import type { QueuedLeaf, HostBinding } from "../services/host-anchor.ts";
import { guardHostSlasher } from "./bond-config.ts";
import { hostBondAbi } from "./bond-abi.ts";
import { hostSlashEvidence } from "./bond-schema.ts";
import { bondFresh } from "./bonds.ts";
import { loadBondState, lockBondCursor } from "./bond-indexer.ts";
import { bondHostId, bondScope, type BondHost, type BondSlash } from "./bond-state.ts";

export type SlashBundle = {
  format: "anyroute.host-slash/1"; provider_id: string; host_id: Hex;
  kind: "policy_rejection" | "invalid_receipt"; reason: 0 | null;
  policy_version?: number; policy_sha256?: string; observed_sha256: string;
  attestation_ref: string; receipt_key?: string; rejection_sha256: string;
};
/** Single canonical leaf commitment, SHA-256 over a fixed structured bundle; no prompt, answer or raw quote is stored. */
export async function storeSlashEvidence(ctx: Ctx, bundle: SlashBundle) {
  if (!ctx.cfg.hostBonds.enabled) return;
  if (!/^[a-f0-9]{64}$/i.test(bundle.observed_sha256) || !/^[a-f0-9]{64}$/i.test(bundle.rejection_sha256) || !/^(0x)?[a-f0-9]{64}$/i.test(bundle.attestation_ref)) return;
  const [provider] = await ctx.db.select({ network: providers.networkHost }).from(providers).where(eq(providers.id, bundle.provider_id));
  if (!provider?.network || bundle.host_id !== bondHostId(bundle.provider_id)) return;
  const scope = bondScope(ctx.cfg);
  const canonical = canonicalJson(bundle);
  const root = `0x${sha256(canonical)}`;
  await ctx.db.insert(hostSlashEvidence).values({ scope, root, providerId: bundle.provider_id, hostId: bundle.host_id, canonical, reason: bundle.reason ?? -1, amount: "0", status: bundle.reason === null ? "review" : "ready" }).onConflictDoNothing();
  return root;
}
/** Only a verified quote that fails a verified published policy is evidence; outages and missing policy are not faults. */
export async function recordPolicyRejection(ctx: Ctx, providerId: string, evidence: HostPolicyBindings, checked: { policy: { version: number } | null; reasons: string[] }) {
  if (!ctx.cfg.hostBonds.enabled || !checked.policy || !checked.reasons.length || !evidence.hardware_verified || !evidence.bindings_committed || evidence.dev || evidence.simulated) return;
  const { hostPolicies } = await import("./schema.ts");
  const [policy] = await ctx.db.select().from(hostPolicies).where(eq(hostPolicies.version, checked.policy.version));
  const [p] = await ctx.db.select({ hash: providers.attestationHash }).from(providers).where(eq(providers.id, providerId));
  if (!policy || !p?.hash) return;
  await storeSlashEvidence(ctx, { format: "anyroute.host-slash/1", provider_id: providerId, host_id: bondHostId(providerId), kind: "policy_rejection", reason: 0,
    policy_version: policy.version, policy_sha256: policy.sha256, observed_sha256: sha256(canonicalJson(evidence)), attestation_ref: p.hash, rejection_sha256: sha256(canonicalJson(checked.reasons)) });
}
/** Called only on the pinned, attestation-bound host receipt feed. A caller's arbitrary receipt cannot trigger slashing. */
export async function recordInvalidHostReceipt(ctx: Ctx, providerId: string, item: QueuedLeaf, binding: HostBinding, failure: string) {
  if (!ctx.cfg.hostBonds.enabled || !["bad_signature", "unbound_key", "other_attestation", "leaf_mismatch"].includes(failure)) return;
  await storeSlashEvidence(ctx, { format: "anyroute.host-slash/1", provider_id: providerId, host_id: bondHostId(providerId), kind: "invalid_receipt", reason: null,
    observed_sha256: sha256(canonicalJson(item.receipt)), attestation_ref: binding.attestationRef, receipt_key: binding.receiptPublicKey, rejection_sha256: sha256(failure) });
}
export type SlashTransport = {
  guard(): Promise<void>;
  host(id: Hex): Promise<{ operator: string; bond: bigint }>;
  slash(id: bigint): Promise<{ status: number; dispute: Hex; executableAt: bigint; approved: boolean; root: Hex; hostId: Hex }>;
  prepare(fn: "proposeSlash" | "executeSlash", args: readonly unknown[]): Promise<{ hash: Hex; raw: Hex }>;
  broadcast(raw: Hex, hash: Hex): Promise<void>;
  time(): Promise<bigint>;
};
export function hostSlashTransport(ctx: Ctx): SlashTransport {
  const address = ctx.cfg.hostBonds.address!;
  const read = (functionName: string, args: unknown[] = []) => ctx.chain.client.readContract({ address, abi: hostBondAbi, functionName, args } as never) as Promise<any>;
  return {
    guard: () => guardHostSlasher(ctx.cfg, () => read("slasher")),
    host: async id => ({ operator: await read("operatorOf", [id]), bond: await read("bondOf", [id]) }),
    slash: async id => {
      const [s, approval, generation] = await Promise.all([read("slashes", [id]), read("slashApproval", [id]), read("approvalGeneration")]);
      return { status: Number(s[7]), dispute: s[3], executableAt: BigInt(s[4]), approved: approval === generation, root: s[2], hostId: s[0] };
    },
    prepare: async (fn, args) => {
      const wallet = ctx.chain.wallet("slasher");
      // Preflight before assigning a nonce. Signing and persistence happen before any broadcast.
      await ctx.chain.client.simulateContract({ account: wallet.account, address, abi: hostBondAbi, functionName: fn, args } as never);
      const prepared = await wallet.prepareTransactionRequest({ account: wallet.account, chain: ctx.chain.chain, to: address, data: encodeFunctionData({ abi: hostBondAbi, functionName: fn, args } as never) });
      const raw = await wallet.signTransaction(prepared as never);
      return { raw, hash: keccak256(raw) };
    },
    broadcast: async (raw, hash) => {
      // A mined intent needs no rebroadcast. Missing or pending intents reuse the exact signed bytes.
      try { const receipt = await ctx.chain.client.getTransactionReceipt({ hash }); if (receipt) return; }
      catch (error) { if ((error as Error).name !== "TransactionReceiptNotFoundError") throw new Error("Host slash receipt lookup failed."); }
      try { await ctx.chain.client.sendRawTransaction({ serializedTransaction: raw }); }
      catch { throw new Error("Host slash broadcast unresolved; signed intent retained for retry."); }
    },
    time: async () => (await ctx.chain.client.getBlock({ blockTag: "latest" })).timestamp,
  };
}
/** One durable intent at a time. Never signs a replacement on timeout/reorg; owner approval is never supplied here. */
export async function runHostSlasher(ctx: Ctx, transport = hostSlashTransport(ctx)) {
  if (!ctx.cfg.hostBonds.enabled) return { skipped: "disabled" };
  const scope = bondScope(ctx.cfg);
  if (ctx.cfg.hostBonds.slashing) await transport.guard();
  const intent = await ctx.db.transaction(async tx => {
    const cursor = await lockBondCursor(tx, scope, ctx.cfg.hostBonds.startBlock);
    if (!bondFresh(cursor.checkedAt)) return { skipped: "index stale" };
    const state = await loadBondState(tx, scope);
    const rows = await tx.select().from(hostSlashEvidence).where(eq(hostSlashEvidence.scope, scope)).orderBy(hostSlashEvidence.createdAt, hostSlashEvidence.root);
    for (const row of rows) {
      if (row.reason < 0) continue;
      const slashEntry = [...state.entries()].find(([key, s]) => key.startsWith("slash:") && (s as BondSlash).evidenceRoot === row.root);
      const indexed = slashEntry?.[1] as BondSlash | undefined;
      let fn: "proposeSlash" | "executeSlash", args: readonly unknown[], field: "proposal" | "execution";
      if (indexed) {
        if (indexed.hostId !== row.hostId) throw new Error("Host slash evidence root belongs to another host.");
        if (indexed.status !== "pending") {
          await tx.update(hostSlashEvidence).set({ status: indexed.status }).where(and(eq(hostSlashEvidence.scope, scope), eq(hostSlashEvidence.root, row.root))); continue;
        }
        if (indexed.disputeHash || BigInt(indexed.executableAt) > await transport.time()) continue;
        if (!ctx.cfg.hostBonds.slashing) continue;
        const id = BigInt(slashEntry![0].slice(6));
        const live = await transport.slash(id);
        if (live.status !== 1 || BigInt(live.dispute) !== 0n || !live.approved || live.executableAt > await transport.time() || live.root.toLowerCase() !== row.root || live.hostId.toLowerCase() !== row.hostId) continue;
        fn = "executeSlash"; args = [id]; field = "execution";
      } else {
        const h = state.get(`host:${row.hostId}`) as BondHost | undefined;
        const [provider] = await tx.select({ operator: providers.operator, network: providers.networkHost }).from(providers).where(eq(providers.id, row.providerId));
        if (!h || !provider?.network || !provider.operator || h.operator !== provider.operator.toLowerCase() || BigInt(h.bond) <= 0n) continue;
        if (row.proposalRaw) return { hash: row.proposalTx as Hex, raw: decrypt(ctx.cfg.appSecret, row.proposalRaw) as Hex };
        if (!ctx.cfg.hostBonds.slashing) {
          if (row.status !== "dry_run") {
            log.info("host slash dry run", { provider: row.providerId, evidence_root: row.root, function_name: "proposeSlash", amount_usdg: h.bond, reason: row.reason, contract: ctx.cfg.hostBonds.address, chain_id: ctx.cfg.chain.id, host_id: row.hostId, delist: false });
            await tx.update(hostSlashEvidence).set({ status: "dry_run", amount: h.bond }).where(and(eq(hostSlashEvidence.scope, scope), eq(hostSlashEvidence.root, row.root)));
          }
          continue;
        }
        const live = await transport.host(row.hostId as Hex);
        if (live.operator.toLowerCase() !== h.operator || live.bond <= 0n) continue;
        // Work-deposit amount is the current bond. Independent owner review must approve this exact proposal.
        fn = "proposeSlash"; args = [row.hostId, row.reason, live.bond, row.root, false]; field = "proposal";
      }
      const saved = field === "proposal" ? row.proposalRaw : row.executionRaw;
      if (saved) return { hash: (field === "proposal" ? row.proposalTx : row.executionTx) as Hex, raw: decrypt(ctx.cfg.appSecret, saved) as Hex };
      const prepared = await transport.prepare(fn, args);
      await tx.update(hostSlashEvidence).set(field === "proposal" ? { proposalTx: prepared.hash, proposalRaw: encrypt(ctx.cfg.appSecret, prepared.raw), status: "submitted", amount: String(args[2]) } : { executionTx: prepared.hash, executionRaw: encrypt(ctx.cfg.appSecret, prepared.raw), status: "executing" }).where(and(eq(hostSlashEvidence.scope, scope), eq(hostSlashEvidence.root, row.root)));
      return prepared;
    }
    return { skipped: ctx.cfg.hostBonds.slashing ? "nothing ready" : "dry run" };
  });
  if ("raw" in intent && ctx.cfg.hostBonds.slashing) { await transport.broadcast(intent.raw, intent.hash); return { transaction: intent.hash }; }
  return intent;
}
