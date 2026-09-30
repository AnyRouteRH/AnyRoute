import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { lt } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { Db, Tx } from "../db/client.ts";
import type { Ctx } from "../context.ts";
import { agentLedgerLinks } from "./ledger-schema.ts";
type Scope = { id: string; actor?: string; approvalId?: string };
const scope = new AsyncLocalStorage<Scope>();
export const agentLedgerMiddleware = (ctx: Ctx): MiddlewareHandler => async (_c, next) => ctx.cfg.agentPolicyEnabled ? scope.run({ id: randomUUID() }, next) : scope.exit(next);
export const ledgerActive = () => !!scope.getStore();
export function ledgerActor(actor: string) { const s = scope.getStore(); if (s) s.actor = actor; }
export function ledgerApproval(id: string, kind: string) { const s = scope.getStore(); if (s && kind === "approval_used") s.approvalId = id; }
/** Called inside the event transaction: correlation does not alter the existing hash-chain payload. */
export async function linkLedgerEvent(db: Db | Tx, eventId: number, kind: string, ts: Date) {
  const s = scope.getStore();
  if (!s?.actor || !["decision", "approval_used"].includes(kind)) return;
  await db.insert(agentLedgerLinks).values({ requestId: s.id, keyHash: s.actor, eventId, ts, approvalId: kind === "approval_used" ? s.approvalId : null });
}
/** Reserve identifiers are the router's generation identifiers; join only by this explicit identity. */
export async function ledgerReservation<T>(db: Db, enabled: boolean, keyHash: string | null | undefined, generationId: string, run: () => Promise<T>): Promise<T> {
  if (!enabled || !keyHash) return run();
  const work = async () => {
    ledgerActor(keyHash);
    const result = await run();
    if (generationId !== "council-policy") await db.insert(agentLedgerLinks).values({ requestId: scope.getStore()!.id, keyHash, generationId }).onConflictDoNothing();
    return result;
  };
  return scope.getStore() ? work() : scope.run({ id: randomUUID(), actor: keyHash }, work);
}
export const pruneAgentLedgerLinks = (db: Db, now = new Date()) => db.delete(agentLedgerLinks).where(lt(agentLedgerLinks.ts, new Date(now.getTime() - 90 * 86_400_000)));
