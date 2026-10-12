// G158: do not rely on the indexer having caught up to a key's Credits deposits.
import type { Ctx } from "../context.ts";
import type { Hex } from "viem";
import { CreditsAbi } from "../chain/abis.ts";
import { fail } from "../lib/errors.ts";
export async function hasChainFunding(ctx: Ctx, chainKeyHash: string) {
  const credits = ctx.chain.address("credits");
  if (!credits) return false;
  try {
    const deposited = await ctx.chain.client.readContract({ address: credits, abi: CreditsAbi, functionName: "deposited", args: [chainKeyHash as Hex] });
    return deposited > 0n;
  } catch {
    fail(503, "Cannot check this key’s chain funding right now. Try rotation again later.", "rotation_funding_unavailable");
  }
}
