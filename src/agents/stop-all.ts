// H172: callers own the transaction; reuse the per-agent Stop path under one account lock.
import { and, eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import type { KeyRow } from "../api/auth.ts";
import { keys } from "../db/schema.ts";
import { agentPolicies } from "./schema.ts";
import { changeKill, lockAccount } from "./store.ts";
import { visibleStop } from "./stop-until.ts";
import { validPrincipal } from "../telegram/linking.ts";
import { securityContext } from "../security-alerts/records.ts";
import { fail } from "../lib/errors.ts";

export async function changeAllStops(ctx: Ctx, tx: Tx, authority: KeyRow, stopped: boolean, reason: string | null = null, until: Date | null = null) {
  await lockAccount(tx, authority.accountId);
  const scoped = { ...ctx, db: tx as unknown as Db };
  // Recheck current role, team, expiry and session authority inside the transaction.
  const caller = await validPrincipal(scoped, { account: authority.accountId, key_hash: authority.keyHash });
  if (caller.scope === "read" || caller.scope === "inference") fail(403, "This key cannot manage agents.", "forbidden");
  const rows = await tx.select({ policy: agentPolicies }).from(agentPolicies).innerJoin(keys, eq(keys.keyHash, agentPolicies.keyHash))
    .where(and(eq(keys.accountId, caller.accountId), caller.management ? undefined : eq(keys.teamId, caller.teamId!))).orderBy(agentPolicies.keyHash);
  const now = new Date();
  let count = 0;
  for (const { policy } of rows) {
    // Keep existing active stops and their deadlines. Resume clears any stored stop.
    if (stopped ? visibleStop(policy, now).killed : !policy.killed) continue;
    await securityContext.run(scoped, () => changeKill(tx, policy, stopped, reason, caller.keyHash, until));
    count++;
  }
  return { count, message: `${stopped ? "Stopped" : "Resumed"} ${count} ${count === 1 ? "agent" : "agents"}` };
}
