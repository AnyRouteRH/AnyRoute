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
import { readJson, clientIp } from "./common.ts";

// ERC-7677 paymaster web service for AnyrPaymaster (ERC-4337 v0.7 VerifyingPaymaster).
// Sponsors gas only for user operations whose every call is an Anyroute action:
//   CallPay.pay/payWithPermit, Credits.deposit/depositWithPermit/requestWithdrawal/finalizeWithdrawal/
//   cancelWithdrawal, PayWithStock.openSession/openSessionWithPermit/closeSession, and ERC20.approve
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
  "function finalizeWithdrawal(bytes32 keyHash, uint256 cumulativeSpent, bytes32[] proof)",
  "function cancelWithdrawal(address keyAddress, uint256 deadline, bytes sig)",
  "function openSession(bytes32 keyHash, address token, uint256 capRawPerDay)",
  "function closeSession(bytes32 keyHash)",
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
