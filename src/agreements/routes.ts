import type { Hono, Context } from "hono";
import { and, eq, desc, sql } from "drizzle-orm";
import { encodeFunctionData } from "viem";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { accounts } from "../db/schema.ts";
import { requireKey } from "../api/auth.ts";
import { fail } from "../lib/errors.ts";
import { policiesFor, policyState } from "../agents/store.ts";
import { evaluateAgentPolicy } from "../agents/evaluate.ts";
import { agreementCreateAbi } from "./abi.ts";
import { agreementRuleReasons } from "./rulebook.ts";
import { agreementEvidence, agreementJury, agreementProjection } from "./schema.ts";
import { addEvidence, evidenceFor, partyAgreement, readAgreement, retentionElapsed } from "./evidence.ts";
import { agreementScope, type Agreement } from "./state.ts";
import { lockAgreementCursor } from "./indexer.ts";
const idSchema = z.string().regex(/^(0|[1-9]\d{0,77})\.(0|[1-9]\d?)$/);
export const prepareSchema = z.strictObject({ payee: z.string().regex(/^0x[0-9a-fA-F]{40}$/), milestone_amounts_usdg_units: z.array(z.string().regex(/^[1-9]\d{0,77}$/).refine(v => BigInt(v) < 2n ** 256n)).min(1).max(64).refine(v => v.reduce((sum, n) => sum + BigInt(n), 0n) < 2n ** 256n), terms_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), deadline: z.string().regex(/^[1-9]\d{0,77}$/).refine(v => BigInt(v) < 2n ** 256n) });
/** Stream cap applies even when Content-Length is absent or false. */
async function readAgreementBody(c: Context, cap: number) {
  const reader = c.req.raw.body?.getReader();
  if (!reader) fail(400, "JSON body required.", "invalid_request");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > cap) { await reader.cancel(); fail(413, "Body exceeds the agreement size cap.", "payload_too_large"); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail(400, "Invalid JSON body.", "invalid_request"); }
}
export function agreementsRoutes(app: Hono, ctx: Ctx) {
  if (!ctx.cfg.agreements.enabled) return;
  const scope = agreementScope(ctx.cfg);
  async function caller(c: Context) {
    c.header("cache-control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    const [account] = await ctx.db.select({ wallet: accounts.wallet }).from(accounts).where(eq(accounts.id, key.accountId));
    if (!account?.wallet) fail(403, "Agreement access requires a wallet-linked account.", "wallet_required");
    return { key, wallet: account.wallet.toLowerCase() };
  }
  app.get("/api/v1/agreements", async c => {
    const { wallet } = await caller(c);
    const cursor = c.req.query("cursor"); if (cursor) idSchema.parse(cursor);
    const rows = await ctx.db.select().from(agreementProjection).where(and(eq(agreementProjection.scope, scope), eq(agreementProjection.kind, "agreement"), sql`(${agreementProjection.data}->>'payer' = ${wallet} or ${agreementProjection.data}->>'payee' = ${wallet})`, cursor ? sql`${agreementProjection.id} < ${cursor}` : undefined)).orderBy(desc(sql`${agreementProjection.id}`)).limit(51);
    return c.json({ data: rows.slice(0, 50).map(r => r.data), next_cursor: rows.length > 50 ? rows[49].id : null });
  });
  app.post("/api/v1/agreements/prepare", async c => {
    const { key, wallet } = await caller(c), body = prepareSchema.parse(await readAgreementBody(c, 2048));
    if (body.payee.toLowerCase() === wallet || /^0x0{40}$/i.test(body.payee)) fail(400, "Payee must be a distinct nonzero wallet.", "invalid_request");
    if (/^0x0{64}$/i.test(body.terms_hash) || BigInt(body.deadline) <= BigInt(Math.floor(Date.now() / 1000))) fail(400, "Nonzero terms hash and future deadline required.", "invalid_request");
    if (ctx.cfg.agentPolicyEnabled) {
      for (const p of await policiesFor(ctx.db, key.keyHash)) {
        const decision = evaluateAgentPolicy(p.spec, await policyState(ctx.db, p, new Date()), { kind: "mcp_tool", name: "anyroute_agreement_prepare" }, new Date());
        const reasons = [...decision.reasons.map(r => r.message), ...agreementRuleReasons(p.spec, body.payee, body.milestone_amounts_usdg_units.reduce((sum, n) => sum + BigInt(n), 0n))];
        if (reasons.length) fail(403, "Agreement blocked by the rulebook.", "agent_policy_denied", { reasons });
      }
    }
    return c.json({ data: { chain_id: ctx.cfg.chain.id, payer: wallet, to: ctx.cfg.agreements.escrow!, value: "0", data: encodeFunctionData({ abi: agreementCreateAbi, functionName: "createAgreement", args: [body.payee as `0x${string}`, body.terms_hash as `0x${string}`, body.milestone_amounts_usdg_units.map(BigInt), BigInt(body.deadline), ctx.cfg.agreements.oracle!] }), notice: "The payer approves USDG and signs its own transaction. This preparation reserves no funds and cannot enforce transactions sent elsewhere." } });
  });
  app.get("/api/v1/agreements/:id", async c => {
    const { wallet } = await caller(c), id = idSchema.parse(c.req.param("id"));
    const a = partyAgreement(await readAgreement(ctx.db, scope, id), wallet);
    const [jury] = a.dispute ? await ctx.db.select().from(agreementJury).where(and(eq(agreementJury.scope, scope), eq(agreementJury.agreementId, id), eq(agreementJury.dispute, a.dispute))) : [];
    return c.json({ data: { ...a, evidence: await evidenceFor(ctx, ctx.db, scope, a), jury: jury ? { status: jury.status, evidence_root: jury.root, statement: jury.statement, key_id: jury.keyId, signature: jury.signature, posting_tx: jury.postingTx } : null } });
  });
  app.post("/api/v1/agreements/:id/evidence", async c => {
    const { wallet } = await caller(c), id = idSchema.parse(c.req.param("id"));
    // Check party access before reading evidence; repeat under the index lock when saving.
    partyAgreement(await readAgreement(ctx.db, scope, id), wallet);
    return c.json({ data: await addEvidence(ctx, id, wallet, await readAgreementBody(c, ctx.cfg.agreements.evidenceBytes)) }, 201);
  });
  app.delete("/api/v1/agreements/:id/evidence", async c => {
    const { wallet } = await caller(c), id = idSchema.parse(c.req.param("id"));
    const removed = await ctx.db.transaction(async tx => {
      const cursor = await lockAgreementCursor(tx, scope, ctx.cfg.agreements.startBlock);
      const a = partyAgreement(await readAgreement(tx, scope, id), wallet);
      if (Date.now() - cursor.checkedAt.getTime() > 120000 || !retentionElapsed(ctx, a)) fail(409, "Deletion requires a fresh resolved agreement past retention.", "retention_pending");
      return (await tx.delete(agreementEvidence).where(and(eq(agreementEvidence.scope, scope), eq(agreementEvidence.agreementId, id), eq(agreementEvidence.party, wallet))).returning()).length;
    });
    return c.json({ data: { removed } });
  });
}
