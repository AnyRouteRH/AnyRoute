import { z } from "zod";
import type { AgentPolicy } from "../agents/policy.ts";
import { usdToPico } from "../lib/money.ts";
export const agreementRulesSchema = z.strictObject({ max_escrow_usd: z.number().positive().max(1_000_000).optional(), counterparties_allow: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).max(64).optional() });
export function agreementRuleReasons(policy: AgentPolicy, payee: string, units: bigint) {
  const rules = policy.agreements;
  const reasons: string[] = [];
  if (rules?.max_escrow_usd !== undefined && units * 1_000_000n > usdToPico(rules.max_escrow_usd)) reasons.push("Agreement exceeds max_escrow_usd.");
  if (rules?.counterparties_allow && !rules.counterparties_allow.some(a => a.toLowerCase() === payee.toLowerCase())) reasons.push("Agreement counterparty is outside counterparties_allow.");
  return reasons;
}
