// Offline key tool. Keys are self-custodial: nothing here talks to the router.
//   bun scripts/key.ts new                          new API key + its on-chain identity
//   bun scripts/key.ts info <sk-ar-v1-...>          derive key hash / address
//   bun scripts/key.ts withdraw <sk> <amountUSDG> <to> <nonce> [deadlineUnix]
//        -> EIP-712 signature for Credits.requestWithdrawal (needs CREDITS_ADDRESS, CHAIN_ID)
import { encodeFunctionData, parseUnits } from "viem";
import { deriveKey, generateApiKey, KEY_RE } from "../src/chain/keys.ts";
import { CreditsAbi } from "../src/chain/abis.ts";

const [cmd, ...args] = process.argv.slice(2);
const credits = process.env.CREDITS_ADDRESS as `0x${string}` | undefined;
const chainId = Number(process.env.CHAIN_ID ?? 4663);

function show(secret: string) {
  const d = deriveKey(secret);
  console.log(JSON.stringify({ key: secret, key_hash: d.chainKeyHash, key_address: d.keyAddress, label: d.label }, null, 2));
  if (credits)
    console.log(`\nDeposit 10 USDG: approve USDG to ${credits}, then call\n  ${encodeFunctionData({ abi: CreditsAbi, functionName: "deposit", args: [d.chainKeyHash, parseUnits("10", 6)] })}`);
}

if (cmd === "new") show(generateApiKey());
else if (cmd === "info" && args[0] && KEY_RE.test(args[0])) show(args[0]);
else if (cmd === "withdraw" && args.length >= 4 && KEY_RE.test(args[0])) {
  if (!credits) throw new Error("Set CREDITS_ADDRESS (and CHAIN_ID) to sign a withdrawal.");
  const [secret, amount, to, nonce, deadline] = args;
  const d = deriveKey(secret);
  const dl = BigInt(deadline ?? Math.floor(Date.now() / 1000) + 3600);
  const value = parseUnits(amount, 6);
  const sig = await d.account.signTypedData({
    domain: { name: "Anyroute Credits", version: "1", chainId, verifyingContract: credits },
    types: { WithdrawRequest: [{ name: "keyHash", type: "bytes32" }, { name: "amount", type: "uint256" }, { name: "to", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "WithdrawRequest",
    message: { keyHash: d.chainKeyHash, amount: value, to: to as `0x${string}`, nonce: BigInt(nonce), deadline: dl },
  });
  console.log(JSON.stringify({ key_address: d.keyAddress, amount: value.toString(), to, deadline: dl.toString(), signature: sig, calldata: encodeFunctionData({ abi: CreditsAbi, functionName: "requestWithdrawal", args: [d.keyAddress, value, to as `0x${string}`, dl, sig] }) }, null, 2));
} else {
  console.error("usage: bun scripts/key.ts new | info <key> | withdraw <key> <amountUSDG> <to> <nonce> [deadline]");
  process.exit(2);
}
