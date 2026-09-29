import type { Ctx } from "../context.ts";

/** Evaluates Spend Watch alert rules (worker job `spend-watch`). */
export async function runSpendWatch(_ctx: Ctx) {
  return { skipped: "no rules evaluated" };
}
