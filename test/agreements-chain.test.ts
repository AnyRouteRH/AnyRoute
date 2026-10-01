import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, decodeFunctionData, defineChain, hashTypedData, getAddress, http, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { agreementEscrowAbi, disputeOracleAbi } from "../src/agreements/abi.ts";
import { agreementIndexChain } from "../src/agreements/indexer.ts";
import { applyAgreementEvent, type AgreementState } from "../src/agreements/state.ts";
import { callJuryModel, evaluateAgreementVotes, evidenceRoot, juryConsensus } from "../src/agreements/jury.ts";
import { guardAgreementSigners, signAgreementTally } from "../src/agreements/tally.ts";
import { rulingTransport } from "../src/agreements/posting.ts";
import { prepareSchema } from "../src/agreements/routes.ts";
import { loadConfig } from "../src/config.ts";
import { sha256 } from "../src/lib/util.ts";
import type { Ctx } from "../src/context.ts";
const rpc = "http://127.0.0.1:8559";
const chain = defineChain({ id: 31337, name: "Agreement integration", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const pub = createPublicClient({ chain, transport: http(rpc) });
const accounts = Array.from({ length: 6 }, (_, addressIndex) => mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex }));
const keys = accounts.slice(3).map(a => `0x${Buffer.from(a.getHdKey().privateKey!).toString("hex")}` as Hex);
const wallet = (i: number) => createWalletClient({ account: accounts[i], chain, transport: http(rpc) });
const artifact = (name: string) => JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`, "utf8"));
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
let process: ReturnType<typeof Bun.spawn> | undefined, token: Hex, escrow: Hex, oracle: Hex, ctx: Ctx;
async function send(i: number, address: Hex, abi: any, functionName: string, args: any[]) {
  const tx = await wallet(i).writeContract({ address, abi, functionName, args });
  const r = await pub.waitForTransactionReceipt({ hash: tx });
  expect(r.status).toBe("success"); return r;
}
async function deploy(name: string, args: any[]) {
  const a = artifact(name), tx = await wallet(0).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  return (await pub.waitForTransactionReceipt({ hash: tx })).contractAddress!;
}
// Needs anvil and the forge artifacts (contracts/out), like test/e2e-anvil.test.ts: CI's root suite has neither.
const RUN = Bun.env.E2E_ANVIL === "1" || (existsSync("contracts/out/MockUSDG.sol/MockUSDG.json") && !!Bun.which("anvil"));
describe.skipIf(!RUN)("agreements on a local chain with the real contracts", () => {
beforeAll(async () => {
  process = Bun.spawn(["anvil", "--port", "8559", "--silent"], { stdout: "ignore", stderr: "ignore" });
  let ready = false;
  for (let i = 0; i < 50; i++) { try { await pub.getChainId(); ready = true; break; } catch { await Bun.sleep(100); } }
  if (!ready) throw Error("Anvil unavailable on integration port 8559");
  token = await deploy("MockUSDG", []);
  oracle = await deploy("DisputeOracle", [accounts[0].address, accounts.slice(3).map(a => a.address), 2n, accounts[2].address]);
  escrow = await deploy("AgreementEscrow", [token, 86400n, 7n * 86400n]);
  await send(0, token, artifact("MockUSDG").abi, "mint", [accounts[0].address, 1000000n]);
  await send(0, token, artifact("MockUSDG").abi, "approve", [escrow, 1000000n]);
  const cfg = loadConfig({ ANYROUTE_ENV: "test", CHAIN_ID: 31337, RHC_RPC_URL: rpc, AGENT_AGREEMENTS_ENABLED: true, AGREEMENT_ESCROW_ADDRESS: escrow, DISPUTE_ORACLE_ADDRESS: oracle });
  cfg.agreements.signerKeys = keys;
  ctx = { cfg, chain: { client: pub, chain, escrowFinality: async () => { const head = await pub.getBlockNumber({ cacheTime: 0 }); return { head, final: head }; }, blockHashAt: async (blockNumber: bigint) => (await pub.getBlock({ blockNumber })).hash } } as unknown as Ctx;
}, 30000);
afterAll(() => process?.kill());
async function open(amount: bigint) {
  const id = await pub.readContract({ address: escrow, abi: agreementEscrowAbi, functionName: "agreementCount" }) + 1n;
  const now = (await pub.getBlock()).timestamp;
  const body = prepareSchema.parse({ payee: accounts[1].address, terms_hash: hash(1), milestone_amounts_usdg_units: [amount.toString()], deadline: (now + 86400n).toString() });
  await send(0, escrow, agreementEscrowAbi, "createAgreement", [body.payee, body.terms_hash, body.milestone_amounts_usdg_units.map(BigInt), BigInt(body.deadline), oracle]);
  await send(1, escrow, agreementEscrowAbi, "submitDelivery", [id, 0n, hash(2)]);
  await send(0, escrow, agreementEscrowAbi, "openDispute", [id, 0n, hash(3)]);
  return id;
}
async function project() {
  const state: AgreementState = new Map();
  const logs = await agreementIndexChain(ctx).logs(0n, await pub.getBlockNumber({ cacheTime: 0 }));
  logs.sort((a, b) => a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1);
  for (const log of logs) applyAgreementEvent(state, log);
  return state;
}
async function balance(i: number) { return pub.readContract({ address: token, abi: artifact("MockUSDG").abi, functionName: "balanceOf", args: [accounts[i].address] }) as Promise<bigint>; }
async function jury(bps: number[]) {
  const models = ["jury/a", "jury/b", "jury/c"], root = evidenceRoot([{ terms: "agreed", delivery: "supplied" }]) as Hex;
  const serviceCtx = { ...ctx, signer: { verify: async () => true } } as unknown as Ctx;
  // Attestation and receipt signatures are explicitly stubbed; oracle bytecode and vote signatures are real.
  const result = await evaluateAgreementVotes(models, { root }, (model, bundle) => callJuryModel(serviceCtx, async () => {
    const b = bps[models.indexOf(model)], verdict = b === 0 ? "refund" : b === 10000 ? "pay" : "split";
    const text = JSON.stringify({ verdict, payee_bps: b, reason: "Attested-model fixture verdict" });
    const payload = { id: model, model, lane: "attested", disclosure: "attested", response_sha256: sha256(text) };
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }], receipt: { payload, key_id: "fixture", sig: "fixture" } }), { headers: { "x-anyroute-lane": "attested", "x-receipt-id": model } });
  }, model, bundle), 2);
  return { ...result, root };
}
test("real oracle jury signatures bind context and move exact pay/refund/split funds", async () => {
  await guardAgreementSigners(pub, oracle, keys, 2);
  for (const [bps, amount] of [[10000, 10001n], [0, 10001n], [3333, 10001n]] as const) {
    const id = await open(amount), beforePayer = await balance(0), beforePayee = await balance(1);
    const j = await jury([bps, bps, bps === 0 ? 10000 : 0]);
    expect(j.consensus.status).toBe("dry_run");
    const digest = await pub.readContract({ address: oracle, abi: disputeOracleAbi, functionName: "voteDigest", args: [escrow, id, 0n, j.root, bps] });
    const agreement = await pub.readContract({ address: escrow, abi: agreementEscrowAbi, functionName: "disputeContext", args: [id, 0n], account: oracle });
    expect(digest).toBe(hashTypedData({ domain: { name: "AnyRouteAgreementJury", version: "1", chainId: 31337, verifyingContract: oracle }, types: { Vote: [{ name: "escrow", type: "address" }, { name: "id", type: "uint256" }, { name: "milestone", type: "uint256" }, { name: "context", type: "bytes32" }, { name: "evidenceRoot", type: "bytes32" }, { name: "juryVersion", type: "uint256" }, { name: "payeeBps", type: "uint16" }] }, primaryType: "Vote", message: { escrow, id, milestone: 0n, context: agreement, evidenceRoot: j.root, juryVersion: 1n, payeeBps: bps } }));
    const transport = rulingTransport(ctx), prepared = await transport.prepare(`${id}.0`, j.root, j.votes);
    expect(await transport.broadcast(prepared.raw, prepared.hash)).toBe("pending");
    await pub.waitForTransactionReceipt({ hash: prepared.hash });
    expect(await transport.broadcast(prepared.raw, prepared.hash)).toBe("posted");
    const expected = amount * BigInt(bps) / 10000n;
    expect(await balance(1) - beforePayee).toBe(expected); expect(await balance(0) - beforePayer).toBe(amount - expected);
    const row = (await project()).get(`agreement:${id}.0`)!;
    expect(row.state).toBe("resolved"); expect(row.payeeAmount).toBe(expected.toString()); expect(row.ruling).toMatchObject({ payeeBps: bps, evidenceRoot: j.root, tallyBitmap: "3", participationBitmap: "7", path: "jury", verdict: bps === 0 ? 0 : bps === 10000 ? 1 : 2 });
  }
}, 30000);
test("complete hung jury enters panel path; panel executes with the committed evidence root", async () => {
  const id = await open(10001n), before = await balance(1), j = await jury([0, 10000, 5000]);
  expect(j.consensus.status).toBe("panel");
  const votes = await signAgreementTally(pub, escrow, oracle, id, 0n, j.root, keys, j.votes);
  await send(0, oracle, disputeOracleAbi, "postRuling", [escrow, id, 0n, j.root, votes]);
  expect(await balance(1)).toBe(before);
  expect((await project()).get(`agreement:${id}.0`)?.ruling?.path).toBe("panel_pending");
  await expect(pub.simulateContract({ account: accounts[0], address: oracle, abi: disputeOracleAbi, functionName: "postPanelRuling", args: [escrow, id, 0n, j.root, 6000] })).rejects.toThrow();
  await send(2, oracle, disputeOracleAbi, "postPanelRuling", [escrow, id, 0n, j.root, 6000]);
  expect(await balance(1) - before).toBe(6000n);
  expect((await project()).get(`agreement:${id}.0`)?.ruling).toMatchObject({ path: "panel", payeeBps: 6000, tallyBitmap: "0", participationBitmap: "7" });
}, 30000);
test("expired dispute refuses jury and panel, recovers 50/50 with odd unit to payee and indexes exact amounts", async () => {
  const id = await open(10001n), j = await jury([0, 10000, 5000]);
  await send(0, oracle, disputeOracleAbi, "postRuling", [escrow, id, 0n, j.root, await signAgreementTally(pub, escrow, oracle, id, 0n, j.root, keys, j.votes)]);
  const m = await pub.readContract({ address: escrow, abi: agreementEscrowAbi, functionName: "milestones", args: [id, 0n] });
  await pub.request({ method: "evm_setNextBlockTimestamp" as never, params: [Number(m[4] + 7n * 86400n)] as never });
  await pub.request({ method: "evm_mine" as never });
  await expect(pub.simulateContract({ account: accounts[2], address: oracle, abi: disputeOracleAbi, functionName: "postPanelRuling", args: [escrow, id, 0n, j.root, 6000] })).rejects.toThrow();
  await expect(signAgreementTally(pub, escrow, oracle, id, 0n, j.root, keys, j.votes)).rejects.toThrow();
  const beforePayer = await balance(0), beforePayee = await balance(1);
  await send(4, escrow, agreementEscrowAbi, "resolveStaleDispute", [id, 0n]);
  expect(await balance(1) - beforePayee).toBe(5001n); expect(await balance(0) - beforePayer).toBe(5000n);
  expect((await project()).get(`agreement:${id}.0`)).toMatchObject({ state: "resolved", payeeAmount: "5001", payerAmount: "5000", ruling: { path: "stale", payeeBps: 5000 } });
}, 30000);
test("ABI artifacts agree and incomplete/abstaining votes are never encoded as refunds", async () => {
  expect(agreementEscrowAbi).toEqual(artifact("AgreementEscrow").abi); expect(disputeOracleAbi).toEqual(artifact("DisputeOracle").abi);
  const id = await open(10001n), j = await jury([0, 0, 10000]);
  await expect(guardAgreementSigners(pub, oracle, keys.slice(0, 1), 2)).rejects.toThrow();
  await expect(signAgreementTally(pub, escrow, oracle, id, 0n, j.root, keys, j.votes.map(v => ({ ...v, verdict: { verdict: "abstain", payee_bps: 0, reason: "Missing material" } })))).rejects.toThrow();
  // An oracle event for another escrow with the same id must not affect this deployment.
  const state = await project(), own = state.get(`agreement:${id}.0`)!;
  const { rulingKey } = await import("../src/agreements/state.ts");
  const foreign = token;
  expect(applyAgreementEvent(state, { event: "RulingPosted", txHash: hash(99), logIndex: 0, args: { key: rulingKey(foreign, id.toString(), "0"), escrow: foreign, indexedEscrow: escrow, indexedOracle: oracle, id, milestone: 0n, path: 2, verdict: 1, payeeBps: 10000 } })).toEqual([]);
  expect(own.ruling).toBeUndefined();
  const args = prepareSchema.parse({ payee: accounts[1].address, terms_hash: hash(1), milestone_amounts_usdg_units: ["1", "2"], deadline: "2000000000" });
  const { encodeFunctionData } = await import("viem");
  const data = encodeFunctionData({ abi: agreementEscrowAbi, functionName: "createAgreement", args: [args.payee as Hex, args.terms_hash as Hex, args.milestone_amounts_usdg_units.map(BigInt), BigInt(args.deadline), oracle] });
  expect(decodeFunctionData({ abi: agreementEscrowAbi, data }).args).toEqual([accounts[1].address, hash(1), [1n, 2n], 2000000000n, getAddress(oracle)]);
  expect(juryConsensus(j.votes, 2).tally_bitmap).toBe("3");
});

test("funding event order preserves multiple milestones and each release or deadline refund independently", async () => {
  const id = await pub.readContract({ address: escrow, abi: agreementEscrowAbi, functionName: "agreementCount" }) + 1n;
  const now = (await pub.getBlock()).timestamp;
  await send(0, escrow, agreementEscrowAbi, "createAgreement", [accounts[1].address, hash(1), [10001n, 20003n, 30005n], now + 100n, oracle]);
  await send(1, escrow, agreementEscrowAbi, "submitDelivery", [id, 0n, hash(2)]);
  await send(0, escrow, agreementEscrowAbi, "release", [id, 0n]);
  await send(1, escrow, agreementEscrowAbi, "submitDelivery", [id, 1n, hash(2)]);
  await pub.request({ method: "evm_increaseTime" as never, params: [86401] as never });
  await pub.request({ method: "evm_mine" as never });
  await send(1, escrow, agreementEscrowAbi, "claimAfterTimeout", [id, 1n]);
  await send(0, escrow, agreementEscrowAbi, "refundAfterDeadline", [id, 2n]);
  const state = await project();
  expect(state.get(`agreement:${id}.0`)).toMatchObject({ state: "released", amount: "10001", payeeAmount: "10001", payerAmount: "0" });
  expect(state.get(`agreement:${id}.1`)).toMatchObject({ state: "released", amount: "20003", payeeAmount: "20003", payerAmount: "0" });
  expect(state.get(`agreement:${id}.2`)).toMatchObject({ state: "resolved", amount: "30005", payeeAmount: "0", payerAmount: "30005", ruling: { path: "deadline" } });
}, 30000);
});
