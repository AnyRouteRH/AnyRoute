import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { providers } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { SIGNATURE_ALGORITHM, keyId, parsePublicKey, publicKeyPem, spkiDer } from "../services/measurement-bundle.ts";
import { listBundles } from "../services/measurement-bundles.ts";

// Public, read-only views of signed measurement bundles (services/measurement-bundle.ts).
//
//   GET /api/v1/measurements/key                    the key measurement bundles must be signed with to count
//   GET /api/v1/measurements/bundles/:providerId    a provider's bundles, each with the log entry the router verified
//
// Both answer 404 until MEASUREMENT_PUBLIC_KEY is set. Nothing is submitted here: bundles are handed over by an
// operator (admin tRPC measurements.submitBundle) and checked against the log by the measurements job.

export function measurementRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/measurements/key", (c) => {
    const pem = ctx.cfg.measurements.publicKey;
    if (!pem) fail(404, "No measurement key is configured.", "not_configured");
    const key = parsePublicKey(pem);
    c.header("Cache-Control", "public, max-age=300");
    return c.json({
      data: {
        algorithm: SIGNATURE_ALGORITHM,
        key_id: keyId(key),
        public_key_pem: publicKeyPem(key),
        public_key_spki_base64: spkiDer(key).toString("base64"),
        transparency_log: ctx.cfg.measurements.rekorUrl,
        note: "A measurement bundle counts only if it is signed with this key and its transparency-log entry verifies.",
      },
    });
  });

  app.get("/api/v1/measurements/bundles/:providerId", async (c) => {
    if (!ctx.cfg.measurements.publicKey) fail(404, "Measurement bundles are not enabled.", "not_configured");
    const id = c.req.param("providerId");
    const [p] = await ctx.db.select({ id: providers.id, status: providers.status }).from(providers).where(eq(providers.id, id));
    if (!p || p.status === "applied") fail(404, "Unknown provider.", "not_found");
    c.header("Cache-Control", "public, max-age=30");
    return c.json({ data: await listBundles(ctx, id) });
  });
}
