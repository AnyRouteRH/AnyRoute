import { keccak256, pad, stringToHex, toHex, type Address, type Hex } from "viem";
import { z } from "zod";

export const accountRuntimeSchema = z.array(z.strictObject({
  sender: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  runtimeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
})).max(256).refine(entries => new Set(entries.map(e => e.sender.toLowerCase())).size === entries.length, "duplicate sponsored account");
export type ReviewedAccount = z.infer<typeof accountRuntimeSchema>[number];
type AccountReader = {
  getBlockNumber(): Promise<bigint>;
  getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
  getStorageAt(args: { address: Address; blockNumber: bigint; slot: Hex }): Promise<Hex | undefined>;
};
const proxySlots = ["implementation", "beacon", "admin"].map(name => pad(toHex(BigInt(keccak256(stringToHex(`eip1967.proxy.${name}`))) - 1n), { size: 32 }));

/** Calldata policy is meaningful only for an independently reviewed, immutable account runtime. */
export async function reviewedAccount(op: { sender: Hex; factory?: Hex | null; factoryData?: Hex | null; eip7702Auth?: unknown; authorization?: unknown }, policy: ReviewedAccount[], reader: AccountReader): Promise<boolean> {
  // Counterfactual factories and mutable EIP-7702 delegation require separate semantic review.
  if (!/^0x[0-9a-fA-F]{40}$/.test(op.sender) || op.factory || op.factoryData && op.factoryData !== "0x" || op.eip7702Auth || op.authorization) return false;
  const expected = policy.find(entry => entry.sender.toLowerCase() === op.sender.toLowerCase());
  if (!expected) return false;
  try {
    const blockNumber = await reader.getBlockNumber();
    const code = await reader.getCode({ address: op.sender, blockNumber });
    if (!code || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) || code.toLowerCase().startsWith("0xef0100") || keccak256(code).toLowerCase() !== expected.runtimeHash.toLowerCase()) return false;
    // Reject standard mutable proxy accounts even if their outer bytecode hash is unchanged.
    const slots = await Promise.all(proxySlots.map(slot => reader.getStorageAt({ address: op.sender, blockNumber, slot })));
    return slots.every(value => typeof value === "string" && /^0x0{64}$/.test(value));
  } catch { return false; }
}
