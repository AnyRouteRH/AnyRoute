import type { Hono } from "hono";
import {
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { readJson, addressBucket } from "./common.ts";

// ERC-7677 paymaster web service for AnyrPaymaster (ERC-4337 v0.7 VerifyingPaymaster).
// Sponsors gas only for user operations whose every call is an Anyroute action:
//   CallPay.pay/payWithPermit, Credits.deposit/depositWithPermit/requestWithdrawal/finalizeWithdrawal/
//   finalizeWithdrawalAbsent/cancelWithdrawal, PayWithStock.openSession/openSessionWithPermit/closeSession/revokeAuthorizations, and ERC20.approve
//   where the spender is one of those contracts. On-chain, AnyrPaymaster also caps each sender daily.

const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const accountAbi = parseAbi([
  "function execute(address dest, uint256 value, bytes func)",
  "function executeBatch(address[] dest, bytes[] func)",
  "function executeBatch(address[] dest, uint256[] value, bytes[] func)",
  "function executeBatch((address target, uint256 value, bytes data)[] calls)",
  "function executeUserOp(address to, uint256 value, bytes data, uint8 operation)",
]);
const targetAbi = parseAbi([
  "function pay(bytes32 nonce, uint256 amount, uint256 expiry)",
  "function payWithPermit(bytes32 nonce, uint256 amount, uint256 expiry, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function deposit(bytes32 keyHash, uint256 amount)",
  "function depositWithPermit(bytes32 keyHash, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function requestWithdrawal(address keyAddress, uint256 amount, address to, uint256 deadline, bytes sig)",
  "function finalizeWithdrawal(bytes32 keyHash, uint256 cumulativeSpent, uint256 index, uint256 leafCount, bytes32[] proof)",
  "function finalizeWithdrawalAbsent(bytes32 keyHash, uint256 leafCount, uint256 gap, (bytes32 keyHash, uint256 cumulativeSpent, bytes32[] proof) below, (bytes32 keyHash, uint256 cumulativeSpent, bytes32[] proof) above)",
  "function cancelWithdrawal(address keyAddress, uint256 deadline, bytes sig)",
  "function openSession(bytes32 keyHash, address token, uint256 capRawPerDay)",
  "function closeSession(bytes32 keyHash)",
  "function revokeAuthorizations(bytes32 keyHash)",
  "function approve(address spender, uint256 value)",
]);

type RpcUserOp = {
  sender: Hex;
  nonce: Hex;
  factory?: Hex | null;
  factoryData?: Hex | null;
  callData: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  paymasterVerificationGasLimit?: Hex | null;
  paymasterPostOpGasLimit?: Hex | null;
};

const packUint128 = (hi: Hex | bigint, lo: Hex | bigint) => concat([pad(toHex(BigInt(hi)), { size: 16 }), pad(toHex(BigInt(lo)), { size: 16 })]);

export function userOpHash(op: RpcUserOp, pmVerifGas: bigint, pmPostOpGas: bigint, chainId: number, paymaster: Hex, validUntil: number, validAfter: number): Hex {
  const initCode = op.factory ? concat([op.factory, op.factoryData ?? "0x"]) : "0x";
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" },
        { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint48" }, { type: "uint48" },
      ],
      [
        op.sender,
        BigInt(op.nonce),
        keccak256(initCode),
        keccak256(op.callData),
        packUint128(op.verificationGasLimit, op.callGasLimit),
        BigInt(packUint128(pmVerifGas, pmPostOpGas)),
        BigInt(op.preVerificationGas),
        packUint128(op.maxPriorityFeePerGas, op.maxFeePerGas),
        BigInt(chainId),
        paymaster,
        validUntil,
        validAfter,
      ],
    ),
  );
}

/** Every call inside the user operation must be an allowed Anyroute action. */
export function sponsorable(ctx: Ctx, callData: Hex): { ok: boolean; reason?: string } {
  const allowedTargets = new Map<string, string>();
  for (const [name, addr] of [["callPay", ctx.cfg.chain.callPay], ["credits", ctx.cfg.chain.credits], ["payWithStock", ctx.cfg.chain.payWithStock]] as const) if (addr) allowedTargets.set(addr.toLowerCase(), name);
  const tokens = new Set([ctx.cfg.chain.usdg.toLowerCase(), ...ctx.cfg.paywith.tokens.map((t) => t.address.toLowerCase())]);
  let calls: { to: Hex; value: bigint; data: Hex }[];
  try {
    const d = decodeFunctionData({ abi: accountAbi, data: callData });
    if (d.functionName === "execute") calls = [{ to: d.args[0], value: d.args[1], data: d.args[2] }];
    else if (d.functionName === "executeUserOp") {
      if (d.args[3] !== 0) return { ok: false, reason: "delegatecall is never sponsored" };
      calls = [{ to: d.args[0], value: d.args[1], data: d.args[2] }];
    } else if (d.args.length === 1) calls = (d.args[0] as readonly { target: Hex; value: bigint; data: Hex }[]).map((c) => ({ to: c.target, value: c.value, data: c.data }));
    else if (d.args.length === 2) calls = (d.args[0] as readonly Hex[]).map((to, i) => ({ to, value: 0n, data: (d.args[1] as readonly Hex[])[i] }));
    else calls = (d.args[0] as readonly Hex[]).map((to, i) => ({ to, value: (d.args[1] as readonly bigint[])[i], data: (d.args[2] as readonly Hex[])[i] }));
  } catch {
    return { ok: false, reason: "unsupported account call format" };
  }
  if (!calls.length) return { ok: false, reason: "empty call" };
  for (const c of calls) {
    if (c.value !== 0n) return { ok: false, reason: "calls with value are not sponsored" };
    const to = c.to.toLowerCase();
    let fn: string;
    let args: readonly unknown[];
    try {
      const d = decodeFunctionData({ abi: targetAbi, data: c.data });
      fn = d.functionName;
      args = d.args ?? [];
    } catch {
      return { ok: false, reason: `call to ${c.to} is not an Anyroute action` };
    }
    if (tokens.has(to)) {
      if (fn !== "approve" || !allowedTargets.has(String(args[0]).toLowerCase())) return { ok: false, reason: "token calls must be approve() to an Anyroute contract" };
      continue;
    }
    const target = allowedTargets.get(to);
    const allowed: Record<string, string[]> = {
      callPay: ["pay", "payWithPermit"],
      credits: ["deposit", "depositWithPermit", "requestWithdrawal", "finalizeWithdrawal", "finalizeWithdrawalAbsent", "cancelWithdrawal"],
      payWithStock: ["openSession", "closeSession", "revokeAuthorizations"],
    };
    if (!target || !allowed[target].includes(fn)) return { ok: false, reason: `${fn} on ${c.to} is not sponsored` };
  }
  return { ok: true };
}

export function paymasterRoutes(app: Hono, ctx: Ctx) {
  app.post("/api/v1/paymaster", async (c) => {
    const body = await readJson(c);
    const id = body.id ?? null;
    const reply = (result: unknown) => c.json({ jsonrpc: "2.0", id, result });
    const error = (code: number, message: string) => c.json({ jsonrpc: "2.0", id, error: { code, message } });
    const pm = ctx.cfg.chain.paymaster;
    const signerKey = ctx.cfg.chain.paymasterSignerKey;
    if (!pm || !signerKey) return error(-32601, "Paymaster is not configured on this router.");
    const from = addressBucket(c, ctx.cfg);
    const lim = await ctx.limiter.take(`pm:${from.id}`, 1, from.scale(120), 60_000);
    if (!lim.ok) return error(-32005, "Rate limited.");
    const method = String(body.method ?? "");
    const params = Array.isArray(body.params) ? body.params : [];
    const [op, entryPoint, chainIdHex] = params as [RpcUserOp, Hex, Hex];
    if (!["pm_getPaymasterStubData", "pm_getPaymasterData"].includes(method)) return error(-32601, `Unsupported method ${method}.`);
    if (!op?.sender || !op.callData) return error(-32602, "Missing user operation.");
    if (String(entryPoint).toLowerCase() !== ENTRY_POINT_V07.toLowerCase()) return error(-32602, "Only EntryPoint v0.7 is supported.");
    if (Number(chainIdHex) !== ctx.cfg.chain.id) return error(-32602, `Wrong chain; this paymaster serves chain ${ctx.cfg.chain.id}.`);
    const policy = sponsorable(ctx, op.callData);
    if (!policy.ok) return error(-32602, `Not sponsored: ${policy.reason}`);
    const pmVerif = BigInt(op.paymasterVerificationGasLimit ?? "0x1d4c0"); // 120k default
    const pmPost = BigInt(op.paymasterPostOpGasLimit ?? "0xc350"); // 50k default
    const now = Math.floor(Date.now() / 1000);
    const validAfter = now - 60;
    const validUntil = now + 15 * 60;
    const times = encodeAbiParameters([{ type: "uint48" }, { type: "uint48" }], [validUntil, validAfter]);
    if (method === "pm_getPaymasterStubData") {
      const dummy = ("0x" + "ff".repeat(64) + "1c") as Hex;
      return reply({ paymaster: pm, paymasterData: concat([times, dummy]), paymasterVerificationGasLimit: toHex(pmVerif), paymasterPostOpGasLimit: toHex(pmPost), isFinal: false, sponsor: { name: "Anyroute" } });
    }
    const hash = userOpHash(op, pmVerif, pmPost, ctx.cfg.chain.id, pm, validUntil, validAfter);
    const sig = await privateKeyToAccount(signerKey).signMessage({ message: { raw: hash } });
    return reply({ paymaster: pm, paymasterData: concat([times, sig]), paymasterVerificationGasLimit: toHex(pmVerif), paymasterPostOpGasLimit: toHex(pmPost) });
  });
  if (!ctx.cfg.chain.paymaster) return;
  void fail;
}
