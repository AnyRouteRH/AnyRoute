import type { Ctx } from "../context.ts";
import type { RouterCall } from "../services/telegram.ts";
import { pollAgreements } from "./indexer.ts";
import { runAgreementJury } from "./jury.ts";
import { postAgreementRuling } from "./posting.ts";
import { pruneAgreementEvidence } from "./evidence.ts";
export function registerAgreementJobs(ctx: Ctx, router?: RouterCall) {
  if (!ctx.cfg.agreements.enabled) return;
  ctx.jobs.register("agreement-indexer", 5000, () => pollAgreements(ctx), { atStart: true });
  ctx.jobs.register("agreement-retention", 3600000, () => pruneAgreementEvidence(ctx));
  if (router) ctx.jobs.register("agreement-jury", 60000, async () => ({ jury: await runAgreementJury(ctx, router), posting: await postAgreementRuling(ctx) }));
}
