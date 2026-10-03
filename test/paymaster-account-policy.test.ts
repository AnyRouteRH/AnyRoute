import { expect, test } from "bun:test";
import { keccak256, type Hex } from "viem";
import { accountRuntimeSchema, reviewedAccount } from "../src/paymaster/account-policy.ts";
import { startRouter } from "./helpers.ts";
import { encodeFunctionData, parseAbi } from "viem";
const sender = `0x${"11".repeat(20)}` as Hex;
const code = "0x60016000" as Hex;
const policy = [{ sender, runtimeHash: keccak256(code) }];
const reader = () => ({ getBlockNumber: async () => 100n, getCode: async ({ blockNumber }: { blockNumber: bigint }) => { expect(blockNumber).toBe(100n); return code; }, getStorageAt: async () => `0x${"00".repeat(32)}` as Hex });
test("sponsorship requires reviewed exact deployed code, not an execute selector alone", async () => {
  expect(await reviewedAccount({ sender }, policy, reader())).toBe(true);
  expect(await reviewedAccount({ sender }, [], reader())).toBe(false);
  expect(await reviewedAccount({ sender }, policy, { ...reader(), getCode: async () => "0x6002" })).toBe(false);
  expect(await reviewedAccount({ sender }, policy, { ...reader(), getCode: async () => undefined })).toBe(false);
  expect(await reviewedAccount({ sender }, policy, { ...reader(), getCode: async () => { throw Error("unavailable"); } })).toBe(false);
});
test("counterfactual, delegated and mutable proxy accounts fail even with a matching outer hash", async () => {
  for (const op of [{ sender, factory: sender }, { sender, factoryData: "0x01" as Hex }, { sender, eip7702Auth: {} }]) expect(await reviewedAccount(op, policy, reader())).toBe(false);
  const delegate = `0xef0100${"11".repeat(20)}` as Hex;
  expect(await reviewedAccount({ sender }, [{ sender, runtimeHash: keccak256(delegate) }], { ...reader(), getCode: async () => delegate })).toBe(false);
  expect(await reviewedAccount({ sender }, policy, { ...reader(), getStorageAt: async () => `0x${"11".repeat(32)}` as Hex })).toBe(false);
  expect(await reviewedAccount({ sender }, policy, { ...reader(), getStorageAt: async () => undefined })).toBe(false);
  expect(() => accountRuntimeSchema.parse([...policy, ...policy])).toThrow();
});
test("the signing endpoint refuses an unapproved account carrying an otherwise allowed deposit", async () => {
  const h = await startRouter({ env: { PAYMASTER_ADDRESS: sender, PAYMASTER_SIGNER_KEY: `0x${"77".repeat(32)}`, CREDITS_ADDRESS: sender } });
  try {
    const deposit = encodeFunctionData({ abi: parseAbi(["function deposit(bytes32,uint256)"]), functionName: "deposit", args: [`0x${"00".repeat(32)}`, 1n] });
    const callData = encodeFunctionData({ abi: parseAbi(["function execute(address,uint256,bytes)"]), functionName: "execute", args: [sender, 0n, deposit] });
    const response = await h.request('/api/v1/paymaster', { method: 'POST', json: { jsonrpc: '2.0', id: 1, method: 'pm_getPaymasterData', params: [{ sender, callData }, '0x0000000071727De22E5E9d8BAf0edAc6f37da032', '0x1237'] } });
    const body = await response.json(); expect(body.error.code).toBe(-32602); expect(body.error.message).toContain('account runtime'); expect(body.result).toBeUndefined();
  } finally { await h.close(); }
});
