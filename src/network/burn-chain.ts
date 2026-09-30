import { keccak256, parseAbi, toBytes, type Hex } from "viem";
import type { Ctx } from "../context.ts";
export const networkBurnAbi = parseAbi([
  "function staking() view returns (address)", "function remainingToday() view returns (uint256)",
  "function operations(bytes32) view returns (uint256 usdgIn, uint256 anyrOut, bool burned)",
  "function swap(bytes32 id, uint256 amount, uint256 minimum)", "function burn(bytes32 id)",
  "event Swapped(bytes32 indexed id, uint256 usdgIn, uint256 anyrOut)", "event Burned(bytes32 indexed id, uint256 anyrOut)",
]);
export const burnOperationId = (id: string) => keccak256(toBytes(`anyroute-network-fee:${id}`));
export type BurnChain = {
  remaining(): Promise<bigint>;
  operation(id: Hex): Promise<{ usdgIn: bigint; amount: bigint; burned: boolean; swapTx: Hex | null; burnTx: Hex | null }>;
  swap(id: Hex, usdg: bigint, minOut: bigint): Promise<void>;
  burn(id: Hex): Promise<void>;
};
export function networkBurnChain(ctx: Ctx): BurnChain {
  const address = ctx.cfg.networkPayouts.burnAddress!;
  const client = ctx.chain.client;
  const configured = async () => {
    const staking = await client.readContract({ address, abi: networkBurnAbi, functionName: "staking" });
    if (staking.toLowerCase() !== ctx.chain.require("staking").toLowerCase()) throw new Error("Network fee executor uses a different staking configuration.");
  };
  const send = async (functionName: "swap" | "burn", args: readonly unknown[]) => {
    await configured();
    const wallet = ctx.chain.wallet("keeper");
    const { request } = await client.simulateContract({ address, abi: networkBurnAbi, functionName, args, account: wallet.account } as never);
    const hash = await wallet.writeContract(request as never);
    const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error("Network fee transaction reverted.");
  };
  return {
    async remaining() { await configured(); return client.readContract({ address, abi: networkBurnAbi, functionName: "remainingToday" }); },
    async operation(id) {
      await configured();
      const [usdgIn, amount, burned] = await client.readContract({ address, abi: networkBurnAbi, functionName: "operations", args: [id] });
      const swap = usdgIn ? await client.getContractEvents({ address, abi: networkBurnAbi, eventName: "Swapped", args: { id }, fromBlock: 0n, toBlock: "latest" }) : [];
      const burn = burned ? await client.getContractEvents({ address, abi: networkBurnAbi, eventName: "Burned", args: { id }, fromBlock: 0n, toBlock: "latest" }) : [];
      if ((usdgIn && swap.length !== 1) || (burned && burn.length !== 1)) throw new Error("Network fee events unavailable; refusing to repeat the operation.");
      return { usdgIn, amount, burned, swapTx: swap[0]?.transactionHash ?? null, burnTx: burn[0]?.transactionHash ?? null };
    },
    swap: (id, amount, minOut) => send("swap", [id, amount, minOut]),
    burn: id => send("burn", [id]),
  };
}
