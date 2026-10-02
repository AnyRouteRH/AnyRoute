import { eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { accounts } from "../db/schema.ts";
import type { KeyRow } from "../api/auth.ts";
import { fail } from "../lib/errors.ts";

// Router debits are the only usage counter. Provider-side BYOK expenditure is not
// measured here, so adding byok_usage cannot double count any router charge.
export function compatibilityFields(k: KeyRow) {
  return {
    include_byok_in_limit: k.includeByokInLimit,
    byok_usage: 0,
    usage_pico_usd: k.spentTotal.toString(),
    usage_micro_usd: ((k.spentTotal + 999_999n) / 1_000_000n).toString(),
    usage_period_pico_usd: k.spent.toString(),
    byok_usage_pico_usd: "0",
    byok_usage_micro_usd: "0",
    scope: k.scope ?? "account",
  };
}

export function keyPagination(query: Record<string, string>) {
  const integer = (raw: string | undefined, fallback: number, min: number, max: number) => {
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) fail(400, "offset and limit must be nonnegative integers.", "invalid_request");
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) fail(400, "offset must be safe; limit must be between 1 and 1000.", "invalid_request");
    return n;
  };
  return { offset: integer(query.offset, 0, 0, Number.MAX_SAFE_INTEGER), limit: integer(query.limit, query.offset === undefined ? Number.MAX_SAFE_INTEGER : 100, 1, 1000) };
}

export async function provisionedScope(ctx: Ctx, caller: KeyRow, spec: { scope?: "inference" | "account"; management?: boolean }, db: Db | Tx) {
  if (caller.scope === "inference") fail(403, "Inference-only keys cannot provision keys.", "inference_only");
  if (spec.scope !== undefined && !caller.management) fail(403, "Only a management key can set key scope.", "forbidden");
  const scope = spec.scope === "account" ? null : spec.scope ?? await accountDefaultScope(ctx, db, caller.accountId);
  if (scope === "inference") {
    if (!ctx.cfg.inferenceKeysEnabled) fail(403, "Inference-only key provisioning is not switched on.", "feature_disabled");
    if (spec.management) fail(400, "An inference-only key cannot have management rights. Select account scope for a management key.", "invalid_request");
  }
  return scope;
}

/** Covers team sign-in issuance as well as provisioning and agent sessions. */
export async function accountDefaultScope(ctx: Ctx, db: Db | Tx, accountId: string) {
  const [account] = await db.select({ inference: accounts.inferenceKeysDefault }).from(accounts).where(eq(accounts.id, accountId));
  if (!account?.inference) return null;
  if (!ctx.cfg.inferenceKeysEnabled) fail(403, "Inference-only key provisioning is not switched on.", "feature_disabled");
  return "inference";
}
