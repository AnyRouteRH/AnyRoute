import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  http,
  type Abi,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "../config.ts";
import { fail } from "../lib/errors.ts";
import { log } from "../lib/util.ts";
import {
  AnyrStakingAbi,
  CallPayAbi,
  CreditsAbi,
  PayWithStockAbi,
  ProviderBondAbi,
  ReceiptAnchorAbi,
  RoyaltyAbi,
  erc20Abi,
} from "./abis.ts";

export type ContractName = "credits" | "callPay" | "payWithStock" | "providerBond" | "receiptAnchor" | "royalty" | "staking";
export const CONTRACT_ABIS: Record<ContractName, Abi> = {
  credits: CreditsAbi as unknown as Abi,
  callPay: CallPayAbi as unknown as Abi,
  payWithStock: PayWithStockAbi as unknown as Abi,
  providerBond: ProviderBondAbi as unknown as Abi,
  receiptAnchor: ReceiptAnchorAbi as unknown as Abi,
  royalty: RoyaltyAbi as unknown as Abi,
  staking: AnyrStakingAbi as unknown as Abi,
};
