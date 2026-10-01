import { and, asc, eq, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Tx, Db } from "../db/client.ts";
import { fail } from "../lib/errors.ts";
import { canonicalJson, decrypt, encrypt, sha256 } from "../lib/util.ts";
import { agreementEvidence, agreementJury, agreementProjection } from "./schema.ts";
import { lockAgreementCursor } from "./indexer.ts";
import { agreementScope, type Agreement } from "./state.ts";
export const activeDispute = (a: Agreement) => a.dispute ?? `before-dispute:${a.creation}`;
export async function readAgreement(db: Db | Tx, scope: string, id: string): Promise<Agreement | undefined> {
  const [row] = await db.select().from(agreementProjection).where(and(eq(agreementProjection.scope, scope), eq(agreementProjection.kind, "agreement"), eq(agreementProjection.id, id)));
  return row?.data as Agreement | undefined;
}
export const partyAgreement = (a: Agreement | undefined, wallet: string) => {
  if (!a || (a.payer !== wallet && a.payee !== wallet)) fail(404, "Agreement not found.", "not_found");
  return a;
};
export async function addEvidence(ctx: Ctx, id: string, wallet: string, value: unknown, now = Date.now()) {
  const content = canonicalJson(value);
  if (Buffer.byteLength(content) > ctx.cfg.agreements.evidenceBytes) fail(413, "Evidence exceeds the size cap.", "payload_too_large");
  const scope = agreementScope(ctx.cfg);
  return ctx.db.transaction(async tx => {
    await lockAgreementCursor(tx, scope, ctx.cfg.agreements.startBlock);
    const a = partyAgreement(await readAgreement(tx, scope, id), wallet), dispute = activeDispute(a);
    if (["resolved", "released"].includes(a.state)) fail(409, "Agreement is already resolved.", "agreement_resolved");
    if (a.dispute && (!Number.isFinite(a.disputedAt) || now >= (a.disputedAt! + ctx.cfg.agreements.evidenceWindowSeconds) * 1000)) fail(409, "The evidence window has closed.", "evidence_closed");
    if ((await tx.select().from(agreementJury).where(and(eq(agreementJury.scope, scope), eq(agreementJury.agreementId, id), eq(agreementJury.dispute, dispute)))).length) fail(409, "The jury evidence bundle is frozen.", "evidence_closed");
    const rows = await tx.select().from(agreementEvidence).where(and(eq(agreementEvidence.scope, scope), eq(agreementEvidence.agreementId, id), eq(agreementEvidence.party, wallet), sql`${agreementEvidence.dispute} in (${`before-dispute:${a.creation}`}, ${dispute})`));
    const hash = sha256(content);
    if (rows.some(r => r.sha256 === hash && r.dispute === dispute)) return { sha256: hash, dispute };
    if (rows.length >= 32) fail(409, "Evidence limit reached (32 entries per party).", "evidence_limit");
    await tx.insert(agreementEvidence).values({ scope, agreementId: id, dispute, party: wallet, sha256: hash, content: encrypt(ctx.cfg.appSecret, content) }).onConflictDoNothing();
    return { sha256: hash, dispute };
  });
}
export async function evidenceFor(ctx: Ctx, db: Db | Tx, scope: string, a: Agreement) {
  const rows = await db.select().from(agreementEvidence).where(and(eq(agreementEvidence.scope, scope), eq(agreementEvidence.agreementId, a.id), sql`${agreementEvidence.dispute} in (${`before-dispute:${a.creation}`}, ${activeDispute(a)})`)).orderBy(asc(agreementEvidence.party), asc(agreementEvidence.sha256), asc(agreementEvidence.dispute));
  return rows.map(r => ({ party: r.party, sha256: r.sha256, dispute: r.dispute, content: JSON.parse(decrypt(ctx.cfg.appSecret, r.content)), created_at: r.createdAt.toISOString() }));
}
export const retentionElapsed = (ctx: Ctx, a: Agreement, now = Date.now()) => ["resolved", "released"].includes(a.state) && Number.isFinite(a.resolvedAt) && now >= (a.resolvedAt! + ctx.cfg.agreements.retentionDays * 86400) * 1000;
export async function pruneAgreementEvidence(ctx: Ctx, now = Date.now()) {
  if (!ctx.cfg.agreements.enabled) return { skipped: "disabled" };
  return ctx.db.transaction(async tx => {
    const scope = agreementScope(ctx.cfg);
    const cursor = await lockAgreementCursor(tx, scope, ctx.cfg.agreements.startBlock);
    if (now - cursor.checkedAt.getTime() > 120000) return { skipped: "index not fresh" };
    const rows = await tx.select().from(agreementProjection).where(eq(agreementProjection.scope, scope));
    let removed = 0;
    for (const row of rows) {
      const a = row.data as Agreement;
      if (!retentionElapsed(ctx, a, now)) continue;
      removed += (await tx.delete(agreementEvidence).where(and(eq(agreementEvidence.scope, scope), eq(agreementEvidence.agreementId, a.id))).returning()).length;
      await tx.delete(agreementJury).where(and(eq(agreementJury.scope, scope), eq(agreementJury.agreementId, a.id)));
    }
    return { removed };
  });
}
