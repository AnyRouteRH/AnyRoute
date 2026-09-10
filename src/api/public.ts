import type { Hono } from "hono";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { encodeFunctionData, keccak256, toBytes, type Hex } from "viem";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { apps, generations, kv, models, offers, paywithSessions, providers } from "../db/schema.ts";
import { ApiError, fail } from "../lib/errors.ts";
import { picoToUsd, usdToPico } from "../lib/money.ts";
import { encrypt, randomHex, safeEqual, sha256 } from "../lib/util.ts";
import { readJson } from "./common.ts";
import { requireKey } from "./auth.ts";
import { verifyReceipt, anchorProof } from "./generation.ts";
import { openDebt, statement } from "../pay/paywith.ts";
import { PayWithStockAbi, erc20Abi } from "../chain/abis.ts";

export const providerApplication = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  name: z.string().min(1).max(80),
  base_url: z.string().url(),
  api_key: z.string().min(1).max(500).optional(),
  contact: z.string().max(200).optional(),
  datacenters: z.array(z.string().max(40)).max(20).optional(),
  data_policy: z.object({ training: z.boolean(), retains_prompts: z.boolean(), retention_days: z.number().int().min(0).optional(), zdr: z.boolean().optional() }),
  tee: z.object({ kind: z.enum(["tdx", "snp", "nvidia-cc", "tinfoil", "dev"]), attestation_url: z.string().url() }).optional(),
  payout_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
