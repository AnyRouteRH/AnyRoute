import { z } from "zod";
export const fastCreditEnv = {
  FAST_CREDIT_ENABLED: z.union([z.boolean(), z.string()]).transform(v => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())).default(false),
  FAST_CREDIT_CONFIRMATIONS: z.coerce.number().int().min(1).max(1_000_000).default(10),
  FAST_CREDIT_ACCOUNT_MAX_USD: z.coerce.number().finite().positive().max(1_000_000).default(25),
  FAST_CREDIT_GLOBAL_MAX_USD: z.coerce.number().finite().positive().max(1_000_000).default(250),
};
export const fastCreditSettings = (e: { FAST_CREDIT_ENABLED: boolean; FAST_CREDIT_CONFIRMATIONS: number; FAST_CREDIT_ACCOUNT_MAX_USD: number; FAST_CREDIT_GLOBAL_MAX_USD: number }) => ({ enabled: e.FAST_CREDIT_ENABLED, confirmations: e.FAST_CREDIT_CONFIRMATIONS, accountMaxUsd: e.FAST_CREDIT_ACCOUNT_MAX_USD, globalMaxUsd: e.FAST_CREDIT_GLOBAL_MAX_USD });
