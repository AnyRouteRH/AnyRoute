import type { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { requireKey } from "./auth.ts";
import { readJson } from "./common.ts";
import { fail } from "../lib/errors.ts";
import { usdToPico } from "../lib/money.ts";
import { canonicalJson, sha256 } from "../lib/util.ts";
import { guardDecideInput, guardOutcomeInput } from "../agents/guard-input.ts";
import { agentActionDecisions } from "../agents/guard-schema.ts";
import { approvalRequest } from "../agents/approvals.ts";
import { recordDecisions, prepareApproval } from "../agents/enforce.ts";
import { appendEvent, lockAccount, policiesFor } from "../agents/store.ts";
import { intentJson, type AgentIntent } from "../agents/policy.ts";

export function guardRoutes(app: Hono, ctx: Ctx) {
  app.use("/api/v1/guard/*", async (_c, next) => { if (!ctx.cfg.agentGuardEnabled) fail(404, "Not found.", "not_found"); await next(); });
  app.post("/api/v1/guard/decide", async c => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const body = guardDecideInput.parse(await readJson(c));
    const intent: AgentIntent = { kind: "action", action: body.action, amount_pico: usdToPico(body.amount_usd, "ceil"), ...(body.target === undefined ? {} : { target: body.target }), ...(body.details_sha256 === undefined ? {} : { details_sha256: body.details_sha256 }) };
    const data = await approvalRequest.run(body.approval_id, () => ctx.db.transaction(async tx => {
      await lockAccount(tx, key.accountId);
      const rows = await policiesFor(tx, key.keyHash), now = new Date();
      const refusal = rows.length ? await recordDecisions(tx, rows, [intent], key.keyHash, now) : undefined;
      const approval = rows.length ? await prepareApproval(ctx.db, tx, rows, [intent], key.keyHash, refusal, now) : {};
      const error = approval.error;
      const decision = !rows.length ? "deny" : error ? error.type === "agent_approval_required" ? "approval_required" : "deny" : "allow";
      const reasons = !rows.length ? [{ code: "no_rulebook", message: "No rulebook is configured for this key." }] : error ? (error.metadata?.reasons ?? [{ code: error.type, message: error.message }]) : [];
      // A session can inherit several rulebooks. The single digest binds their sorted hashes.
      const policy_sha256 = rows.length === 1 ? rows[0]!.sha256 : rows.length ? sha256(canonicalJson(rows.map(r => r.sha256).sort())) : "";
      if (decision === "allow") await approval.use?.();
      const decision_id = randomBytes(18).toString("base64url");
      const entry = await appendEvent(tx, { keyHash: key.keyHash, kind: "action_decision", decision, reasons, intent: { ...intentJson(intent), decision_id }, policySha256: policy_sha256 }, now);
      await tx.insert(agentActionDecisions).values({ id: decision_id, keyHash: key.keyHash, eventId: entry.id, action: body.action, target: body.target, amountPico: intent.amount_pico, detailsSha256: body.details_sha256, decision, createdAt: now });
      const payload = { type: "anyroute.guard.decision.v1", decision_id, key_hash: key.keyHash, intent: intentJson(intent), decision, reasons, policy_sha256, ts: now.toISOString() };
      const signed = ctx.signer.sign(payload);
      const metadata = error?.metadata;
      return { decision, reasons, decision_id, policy_sha256, ...(decision === "approval_required" ? { approval_id: metadata?.approval_id, expires_at: metadata?.expires_at, poll: metadata?.poll } : {}), signed: { payload, alg: "Ed25519", key_id: signed.keyId, sig: signed.sig } };
    }));
    c.header("cache-control", "no-store");
    return c.json({ data });
  });
  app.post("/api/v1/guard/decisions/:id/outcome", async c => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const body = guardOutcomeInput.parse(await readJson(c));
    const amount = body.amount_usd === undefined ? null : usdToPico(body.amount_usd, "ceil");
    const data = await ctx.db.transaction(async tx => {
      await lockAccount(tx, key.accountId);
      const [row] = await tx.select().from(agentActionDecisions).where(and(eq(agentActionDecisions.id, c.req.param("id")), eq(agentActionDecisions.keyHash, key.keyHash))).for("update");
      if (!row) fail(404, "Decision not found.", "not_found");
      if (row.outcomeStatus !== null) fail(409, "Outcome was already reported.", "guard_outcome_exists");
      if (row.decision !== "allow") fail(409, "Only an allowed action can report an outcome.", "guard_not_allowed");
      const now = new Date(), over_allowed = amount !== null && amount > row.amountPico;
      await tx.update(agentActionDecisions).set({ outcomeStatus: body.status, outcomeAmountPico: amount, outcomeAt: now }).where(eq(agentActionDecisions.id, row.id));
      const rows = await policiesFor(tx, key.keyHash);
      await appendEvent(tx, { keyHash: key.keyHash, kind: "action_outcome", intent: { decision_id: row.id, status: body.status, amount_pico: amount?.toString() ?? null, over_allowed }, policySha256: rows[0]?.sha256 ?? "" }, now);
      return { decision_id: row.id, status: body.status, amount_pico: amount?.toString() ?? null, over_allowed };
    });
    return c.json({ data });
  });
}
