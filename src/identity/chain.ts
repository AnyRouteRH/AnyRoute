import { rpcTransport } from "../chain/rpc-transport.ts"; // RPC1
import { createWalletClient, decodeEventLog, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Ctx } from "../context.ts";
import { identityRegistryAbi } from "./erc8004.ts";

// The chain access ERC-8004 registration needs: read a registration transaction's receipt (owner mode and the
// registrar's confirmation) and, in registrar mode only, send register(). Tests replace it with setIdentityChain.

export type Registration =
  | { status: "pending" }
  | { status: "failed"; reason: "reverted" | "no_registration" }
  | { status: "ok"; agentId: bigint; owner: Hex; agentURI: string; block: bigint };

export type IdentityChain = {
  registration(registry: Hex, txHash: Hex): Promise<Registration>;
  /** Registrar mode: send register(agentURI, metadata) from the registrar key; resolves with the transaction hash. */
  register(registry: Hex, data: Hex): Promise<Hex>;
};

const injected = new WeakMap<Ctx, IdentityChain>();
export const setIdentityChain = (ctx: Ctx, chain: IdentityChain) => void injected.set(ctx, chain);

export function identityChain(ctx: Ctx): IdentityChain {
  return injected.get(ctx) ?? {
    async registration(registry, txHash) {
      const receipt = await ctx.chain.client.getTransactionReceipt({ hash: txHash }).catch(() => null);
      if (!receipt) return { status: "pending" };
      if (receipt.status !== "success") return { status: "failed", reason: "reverted" };
      const head = await ctx.chain.client.getBlockNumber();
      if (head - receipt.blockNumber + 1n < BigInt(ctx.cfg.chain.confirmations)) return { status: "pending" };
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== registry.toLowerCase()) continue;
        try {
          const e = decodeEventLog({ abi: identityRegistryAbi, eventName: "Registered", data: log.data, topics: log.topics });
          return { status: "ok", agentId: e.args.agentId, owner: e.args.owner.toLowerCase() as Hex, agentURI: e.args.agentURI, block: receipt.blockNumber };
        } catch { /* another event of the registry */ }
      }
      return { status: "failed", reason: "no_registration" };
    },
    async register(registry, data) {
      const key = ctx.cfg.identity.registrarKey;
      if (!key) throw new Error("registrar key not configured");
      const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: ctx.chain.chain, transport: rpcTransport(ctx.cfg.chain) });
      return wallet.sendTransaction({ to: registry, data });
    },
  };
}
