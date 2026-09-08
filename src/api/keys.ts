import type { Context, Hono } from "hono";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { encodeFunctionData, formatUnits, parseUnits, recoverMessageAddress, type Hex } from "viem";
import { CreditsAbi, erc20Abi } from "../chain/abis.ts";
import { withdrawableFor } from "../services/settlement.ts";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { byokKeys, generations, keys, ledger, spentRoots, teamMembers, teams } from "../db/schema.ts";
import { deriveKey, generateApiKey } from "../chain/keys.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd, usdToPico } from "../lib/money.ts";
import { balanceOf, ensureAccount } from "../ledger/ledger.ts";
import { encrypt, uid } from "../lib/util.ts";
import { MerkleTree, spentLeaf } from "../receipts/merkle.ts";
import { clientIp, readJson } from "./common.ts";
import { bearer, registerRootKey, requireKey, requireRole, walletAccountId, type KeyRow } from "./auth.ts";

const keySpec = z.object({
  name: z.string().max(100).optional(),
  limit: z.number().nonnegative().nullable().optional(), // USD (OpenRouter provisioning API name)
  budget_usd: z.number().nonnegative().nullable().optional(), // alias of limit
  limit_reset: z.enum(["daily", "weekly", "monthly"]).nullable().optional(),
  rpm: z.number().int().positive().nullable().optional(),
  tpm: z.number().int().positive().nullable().optional(),
  allowed_models: z.array(z.string()).nullable().optional(),
  team: z.string().nullable().optional(),
  pay_with_default: z.string().max(16).nullable().optional(),
  disabled: z.boolean().optional(),
  expires_at: z.string().datetime().nullable().optional(),
  guardrails: z
    .object({ pii: z.enum(["redact", "block"]).optional(), deny_patterns: z.array(z.string()).max(50).optional(), max_input_chars: z.number().int().positive().optional(), redact_output: z.boolean().optional() })
    .nullable()
    .optional(),
  routing: z.record(z.string(), z.unknown()).nullable().optional(),
  management: z.boolean().optional(),
});

export function keyJson(k: KeyRow) {
  return {
    hash: k.keyHash,
    name: k.name,
    label: k.label,
    disabled: k.disabled,
    limit: k.budget != null ? picoToUsd(k.budget) : null,
    limit_reset: k.budgetReset,
    limit_remaining: k.budget != null ? picoToUsd(k.budget - k.spent > 0n ? k.budget - k.spent : 0n) : null,
    usage: picoToUsd(k.spentTotal),
    usage_period: picoToUsd(k.spent),
    rpm: k.rpm,
    tpm: k.tpm,
    allowed_models: k.allowedModels,
    team: k.teamId,
    pay_with_default: k.payWithDefault,
    management: k.management,
    guardrails: k.guardrails,
    chain_key_hash: k.chainKeyHash,
    key_address: k.keyAddress,
    created_at: k.createdAt.toISOString(),
    last_used: k.lastUsed?.toISOString() ?? null,
    expires_at: k.expiresAt?.toISOString() ?? null,
  };
}

function depositInfo(ctx: Ctx, k: Pick<KeyRow, "chainKeyHash" | "keyAddress">) {
  return {
    chain: ctx.cfg.chain.id,
    token: ctx.cfg.chain.usdg,
    credits_contract: ctx.cfg.chain.credits ?? null,
    key_hash: k.chainKeyHash,
    key_address: k.keyAddress,
    how: "Approve USDG to the Credits contract, then call deposit(key_hash, amount). The balance is usable immediately after confirmation; withdraw any time by signing with the key address.",
  };
}

async function sub(ctx: Ctx, c: Context): Promise<KeyRow> {
  return requireKey(ctx, c.req.header("authorization"));
}
