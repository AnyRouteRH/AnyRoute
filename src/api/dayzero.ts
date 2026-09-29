import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { approveCandidate, evaluateCandidate, linkEndpoint, listCandidates, promoteCandidate, viewCandidate, CANDIDATE_STATUSES } from "../services/dayzero.ts";
import { readJson } from "./common.ts";
import { requireOperator } from "./lane.ts";

// Day-zero candidates (operator token). See services/dayzero.ts for the pipeline.
//
//   GET  /api/v1/lane/candidates[?status=]                   candidates and their latest scores
//   GET  /api/v1/lane/candidates/{id}
//   PUT  /api/v1/lane/candidates/{id}/endpoint               which provider offer serves the weights
//   POST /api/v1/lane/candidates/{id}/evaluate               run the probe sets against that endpoint
//   POST /api/v1/lane/candidates/{id}/approve                approve an evaluated candidate
//   POST /api/v1/lane/candidates/{id}/promote                make an approved candidate servable (needs an attested provider)

const noControl = (v: string) => !/[\u0000-\u001f\u007f]/.test(v);
const text = (max: number) => z.string().trim().min(1).max(max).refine(noControl, "must not contain control characters");

function candidateId(c: Context) {
  const n = Number(c.req.param("id"));
  if (!Number.isSafeInteger(n) || n < 1) fail(404, "Unknown candidate.", "not_found");
  return n;
}

export function dayzeroRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/lane/candidates", async (c) => {
    requireOperator(ctx, c);
    const status = c.req.query("status");
    if (status && !(CANDIDATE_STATUSES as readonly string[]).includes(status)) fail(400, `status must be one of: ${CANDIDATE_STATUSES.join(", ")}.`, "invalid_request");
    return c.json({ data: await listCandidates(ctx, status || undefined) });
  });
  app.get("/api/v1/lane/candidates/:id", async (c) => {
    requireOperator(ctx, c);
    return c.json({ data: await viewCandidate(ctx, candidateId(c)) });
  });
  app.put("/api/v1/lane/candidates/:id/endpoint", async (c) => {
    requireOperator(ctx, c);
    const input = z.object({ provider: text(64), model: text(160) }).strict().parse(await readJson(c));
    return c.json({ data: await linkEndpoint(ctx, candidateId(c), input) });
  });
  app.post("/api/v1/lane/candidates/:id/evaluate", async (c) => {
    requireOperator(ctx, c);
    return c.json({ data: await evaluateCandidate(ctx, candidateId(c)) });
  });
  app.post("/api/v1/lane/candidates/:id/approve", async (c) => {
    requireOperator(ctx, c);
    const input = z.object({ approved_by: text(64).optional(), note: text(500).optional(), variant: z.enum(["abliterated", "native_low_refusal"]).optional() }).strict().parse(await readJson(c));
    return c.json({ data: await approveCandidate(ctx, candidateId(c), { by: input.approved_by, note: input.note, variant: input.variant }) });
  });
  app.post("/api/v1/lane/candidates/:id/promote", async (c) => {
    requireOperator(ctx, c);
    const r = await promoteCandidate(ctx, candidateId(c));
    if (!r.promoted) fail(409, `Not servable yet: ${r.reason}.`, "not_servable", { candidate: r.candidate });
    return c.json({ data: r.candidate });
  });
}
