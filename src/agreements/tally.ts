import type { PublicClient, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agreementEscrowAbi, disputeOracleAbi } from "./abi.ts";
import type { Vote } from "./jury.ts";
/** Complete current-signer tally. Raw digest signing matches the oracle's EIP-712 digest exactly. */
export async function signAgreementTally(client: PublicClient, escrow: Hex, oracle: Hex, id: bigint, milestone: bigint, root: Hex, keys: Hex[], votes: Vote[]) {
  const [threshold, version, agreement, status] = await Promise.all([
    client.readContract({ address: oracle, abi: disputeOracleAbi, functionName: "threshold" }),
    client.readContract({ address: oracle, abi: disputeOracleAbi, functionName: "juryVersion" }),
    client.readContract({ address: escrow, abi: agreementEscrowAbi, functionName: "agreements", args: [id] }),
    client.readContract({ address: escrow, abi: agreementEscrowAbi, functionName: "milestones", args: [id, milestone] }),
  ]);
  if (agreement[4].toLowerCase() !== oracle.toLowerCase() || status[5] !== 2) throw new Error("Dispute oracle binding or milestone status mismatch.");
  const signed = await Promise.all(keys.map(async (key, i) => {
    const account = privateKeyToAccount(key);
    const index = await client.readContract({ address: oracle, abi: disputeOracleAbi, functionName: "signerIndexPlusOne", args: [account.address] });
    const vote = votes[i];
    if (!index || !vote?.receipt_id || !vote.verdict || vote.verdict.verdict === "abstain" || vote.failure) throw new Error("A complete non-abstaining jury tally is required; no fabricated votes.");
    const digest = await client.readContract({ address: oracle, abi: disputeOracleAbi, functionName: "voteDigest", args: [escrow, id, milestone, root, vote.verdict.payee_bps] });
    return { index, payeeBps: vote.verdict.payee_bps, signature: await account.sign({ hash: digest }) };
  }));
  // Reading the next index proves that the provided keys cover the entire oracle jury.
  const count = await oracleJurySize(client, oracle);
  if (count !== keys.length || votes.length !== count || new Set(signed.map(v => v.index.toString())).size !== count || threshold <= BigInt(count / 2 | 0)) throw new Error("Configured keys must cover the complete oracle jury.");
  if (version !== await client.readContract({ address: oracle, abi: disputeOracleAbi, functionName: "juryVersion" })) throw new Error("Oracle jury changed while signing.");
  return signed.map(({ payeeBps, signature }) => ({ payeeBps, signature }));
}
export async function oracleJurySize(client: PublicClient, oracle: Hex) {
  // MAX_JURY_SIZE bounds storage-array discovery; distinguish end-of-array reverts from RPC failures.
  const limit = Number(await client.readContract({ address: oracle, abi: disputeOracleAbi, functionName: "MAX_JURY_SIZE" }));
  for (let i = 0; i < limit; i++) {
    try { await client.readContract({ address: oracle, abi: disputeOracleAbi, functionName: "jurySigners", args: [BigInt(i)] }); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes("revert")) throw error;
      return i;
    }
  }
  return limit;
}
export async function guardAgreementSigners(client: PublicClient, oracle: Hex, keys: Hex[], threshold: number) {
  const count = await oracleJurySize(client, oracle);
  const indexes = await Promise.all(keys.map(key => client.readContract({ address: oracle, abi: disputeOracleAbi, functionName: "signerIndexPlusOne", args: [privateKeyToAccount(key).address] })));
  if (count !== keys.length || indexes.some(i => i === 0n) || new Set(indexes.map(String)).size !== count || BigInt(threshold) !== await client.readContract({ address: oracle, abi: disputeOracleAbi, functionName: "threshold" })) throw new Error("Configured jury signer membership or threshold mismatch.");
}
