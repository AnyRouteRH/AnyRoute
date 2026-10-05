import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "./auth.ts";
import { requireKey } from "./auth.ts";
import { readJson } from "./common.ts";
import { fail } from "../lib/errors.ts";
import { agentActionDecisions } from "../agents/guard-schema.ts";
import { agentPayments } from "../agents/pay-schema.ts";
import { guardDecide, recordGuardOutcome } from "../agents/guard-decide.ts";
import { PAY_ACTION, confirmInput, confirmPayment, linkedWallets, payInput, payInstructions, paymentJson, refreshPayment, resolveRecipient, usdToUnits } from "../agents/pay.ts";

// Pay another agent (off unless AGENT_PAY_ENABLED). Anyroute never holds the money: these routes decide with the payer's
// rulebook, return instructions for the payer's own wallet, and verify the transfer on chain afterwards.
export function agentPayRoutes(app: Hono, ctx: Ctx) {
  const on = () => { if (!ctx.cfg.agentPayEnabled) fail(404, "Paying another agent is not switched on.", "not_found"); };
  // Each confirmation or read of an unsettled payment reads the chain; keep that bounded per key.
  const limited = async (key: KeyRow) => { if (!(await ctx.limiter.take(`agent-pay:${key.keyHash}`, 1, 60, 60_000)).ok) fail(429, "Too many payment checks. Try again in a minute.", "rate_limited"); };
  const owned = async (key: KeyRow, id: string) => {
    const [row] = await ctx.db.select().from(agentPayments).where(eq(agentPayments.decisionId, id));
    if (!row || !(row.keyHash === key.keyHash || (key.management && key.accountId === row.accountId))) fail(404, "Payment not found.", "not_found");
    return row;
  };

  app.post("/api/v1/agents/pay", async c => {
    on();
    const key = await requireKey(ctx, c.req.header("authorization"));
    const body = payInput.parse(await readJson(c));
    const to = await resolveRecipient(ctx, body.to);
    const amountUnits = usdToUnits(body.amount_usd);
    const decided = await guardDecide(ctx, key, { action: PAY_ACTION, target: to.target, amount_usd: body.amount_usd, ...(body.memo_sha256 ? { details_sha256: body.memo_sha256 } : {}), ...(body.approval_id ? { approval_id: body.approval_id } : {}) }, async (tx, d) => {
      if (d.decision !== "allow") return;
      await tx.insert(agentPayments).values({ decisionId: d.decision_id, keyHash: key.keyHash, accountId: key.accountId, policySha256: d.policy_sha256, recipientProfile: to.profile, recipientKeyHash: to.keyHash, recipientWallet: to.wallet, amountUnits, memoSha256: body.memo_sha256, statusAt: d.now, createdAt: d.now });
    });
    c.header("cache-control", "no-store");
    if (decided.decision !== "allow") return c.json({ data: decided });
    const from = await linkedWallets(ctx.db, key.accountId);
    const payment = { decision_id: decided.decision_id, status: "awaiting_transfer", ...payInstructions(ctx, { decisionId: decided.decision_id, recipientWallet: to.wallet, recipientProfile: to.profile, amountUnits }, from) };
    return c.json({ data: { ...decided, payment } });
  });

  app.post("/api/v1/agents/pay/:decision_id/confirm", async c => {
    on();
    const key = await requireKey(ctx, c.req.header("authorization"));
    const { tx_hash } = confirmInput.parse(await readJson(c));
    await limited(key);
    const row = await owned(key, c.req.param("decision_id"));
    if (row.keyHash !== key.keyHash) fail(403, "Only the agent key that asked can confirm its payment.", "forbidden");
    const saved = await confirmPayment(ctx, row, tx_hash, async (tx, paidPico, now) => {
      const [decision] = await tx.select().from(agentActionDecisions).where(and(eq(agentActionDecisions.id, row.decisionId), eq(agentActionDecisions.keyHash, key.keyHash))).for("update");
      if (!decision || decision.decision !== "allow") fail(409, "Only an allowed payment can be confirmed.", "guard_not_allowed");
      if (decision.outcomeStatus !== null) fail(409, "An outcome was already reported for this decision, so it cannot be confirmed with a transfer.", "guard_outcome_exists");
      await recordGuardOutcome(tx, key.keyHash, decision, "executed", paidPico, now);
    });
    c.header("cache-control", "no-store");
    return c.json({ data: paymentJson(ctx, saved) });
  });

  app.get("/api/v1/agents/pay/:decision_id", async c => {
    on();
    const key = await requireKey(ctx, c.req.header("authorization"));
    await limited(key);
    const row = await refreshPayment(ctx, await owned(key, c.req.param("decision_id")));
    c.header("cache-control", "no-store");
    return c.json({ data: paymentJson(ctx, row, row.status === "awaiting_transfer" ? await linkedWallets(ctx.db, row.accountId) : []) });
  });
}
