import type { Context, Hono } from "hono";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { hostAnchorProof, leafOfReceipt } from "../services/host-anchor.ts";
import { readJson } from "./common.ts";

// Proofs for enclave receipts rooted per host (services/host-anchor.ts). Registered only with HOST_ANCHOR_ENABLED.
//   GET  /api/v1/host-anchors/proof/:leaf   by the receipt's leaf (0x + 64 hex)
//   POST /api/v1/host-anchors/proof         { receipt } (the sidecar's envelope; its leaf is recomputed) or { leaf }
// The answer mirrors GET /api/v1/receipts/:id/proof, plus the host, the attestation reference the root was built under,
// and the receipt key the router checked every leaf against. `anchored` is true only when the root was posted with
// ReceiptAnchor.anchorAttested and confirmed; a root kept off chain has status "local" and anchored false.

const LEAF = /^0x[0-9a-f]{64}$/;

export function hostAnchorRoutes(app: Hono, ctx: Ctx) {
  const answer = async (c: Context, leaf: string) => {
    const proof = await hostAnchorProof(ctx, leaf);
    if (!proof) fail(404, "No host root holds this leaf yet. Each attested host's leaves are collected and rooted once per interval; ask again after the next one.", "not_found");
    c.header("Cache-Control", "no-store");
    return c.json({ data: proof });
  };

  app.get("/api/v1/host-anchors/proof/:leaf", async (c) => {
    const leaf = c.req.param("leaf").toLowerCase();
    if (!LEAF.test(leaf)) fail(400, "The leaf must be 0x followed by 64 hex characters.", "invalid_request");
    return answer(c, leaf);
  });

  app.post("/api/v1/host-anchors/proof", async (c) => {
    const body = await readJson(c);
    if (body.receipt !== undefined) {
      const leaf = leafOfReceipt(body.receipt);
      if (!leaf) fail(400, "receipt must be a sidecar receipt envelope with payload and sig.", "invalid_request");
      const stated = (body.receipt as { leaf?: unknown }).leaf;
      if (stated !== undefined && String(stated).toLowerCase() !== leaf) fail(400, "The receipt's leaf does not match its payload and signature.", "invalid_request");
      return answer(c, leaf);
    }
    const leaf = typeof body.leaf === "string" ? body.leaf.toLowerCase() : "";
    if (!LEAF.test(leaf)) fail(400, "Send { receipt } or { leaf } (0x followed by 64 hex characters).", "invalid_request");
    return answer(c, leaf);
  });
}
