import { encodePacked, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { sha256 } from "../lib/util.ts";

// API keys are self-custodial. From the secret the router (and the key holder) derive:
//   keyHash      = sha256(secret)                       — database lookup, never reversible
//   keyAddress   = address of privateKey keccak256("anyroute-key-v1:" + secret)
//   chainKeyHash = keccak256(abi.encodePacked(keyAddress)) — the Credits.sol balance id
// So anyone can generate a key offline, deposit USDG to its chainKeyHash, start calling the
// API immediately (no account), and withdraw by signing with the derived key.

export const KEY_PREFIX = "sk-ar-v1-";
export const KEY_RE = /^sk-ar-v1-[0-9a-f]{64}$/;

export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("hex");
}

export function keyPrivateKey(secret: string): `0x${string}` {
  return keccak256(toBytes("anyroute-key-v1:" + secret));
}

export function deriveKey(secret: string) {
  const account = privateKeyToAccount(keyPrivateKey(secret));
  return {
    keyHash: sha256(secret),
    keyAddress: account.address,
    chainKeyHash: chainKeyHashOf(account.address),
    label: `${secret.slice(0, 13)}...${secret.slice(-4)}`,
    account,
  };
}

export const chainKeyHashOf = (address: `0x${string}`) => keccak256(encodePacked(["address"], [address]));
