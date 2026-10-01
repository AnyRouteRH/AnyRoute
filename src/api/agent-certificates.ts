import type { Hono } from "hono";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { requireKey } from "./auth.ts";
import { readJson } from "./common.ts";
import { recordCertificatePayload } from "../agents/record-certificate.ts";
import { receiptKeyEntry } from "../tlog/entries.ts";
import { isRecordCertificate, validRecordClaim, verifyRecordCertificate, RECORD_CERTIFICATE_NOTICE, type RecordClaim } from "../agents/record-certificate-shared.ts";
const bodySchema = z.strictObject({ claims: z.array(z.custom<RecordClaim>(validRecordClaim)).min(1).max(16).refine(v => new Set(v).size === v.length, "Claims must be distinct.") });
export function agentCertificatesRoutes(app: Hono, ctx: Ctx) {
  app.post("/api/v1/agents/me/record-certificate", async c => {
    if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found");
    c.header("cache-control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    const limit = await ctx.limiter.take(`agent-certificate:${key.accountId}`, 1, 5, 60_000);
    if (!limit.ok) { c.header("retry-after", String(Math.ceil(limit.retryAfterMs / 1000))); fail(429, "Too many certificate requests.", "rate_limited"); }
    const { claims } = bodySchema.parse(await readJson(c));
    if (!ctx.tlog) fail(503, "Certificate issuance requires the signing key log (TLOG_ENABLED).", "record_key_log_unavailable");
    const payload = await recordCertificatePayload(ctx.db, key, claims);
    const signed = ctx.signer.sign(payload);
    const signingKey = await ctx.signer.publicKey(signed.keyId);
    if (!signingKey) fail(503, "Signing key unavailable.", "record_key_log_unavailable");
    const entry = receiptKeyEntry({ id: signingKey.id, publicKey: signingKey.publicKeyHex, validFrom: signingKey.validFrom });
    // Await publication, unlike the usual best-effort rotation hook. No agent/certificate identifier enters the log.
    await ctx.tlog.append([entry]);
    if (!await ctx.tlog.lookup("receipt_key", entry.sha256)) fail(503, "Signing key publication unavailable.", "record_key_log_unavailable");
    const certificate = { payload, key_id: signed.keyId, signature: signed.sig };
    if (!await verifyRecordCertificate(certificate, { keys: await ctx.signer.jwks() })) fail(503, "Signing key is outside its issuance window; refresh the receipt signer.", "record_signing_key_unavailable");
    return c.json({ data: certificate });
  });
  app.on(["GET", "POST"], "/api/v1/agents/certificates/verify", async c => {
    if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found");
    c.header("cache-control", "no-store");
    let certificate: unknown;
    if (c.req.method === "POST") certificate = await readJson(c);
    else {
      const encoded = c.req.query("certificate");
      if (!encoded || encoded.length > 8192) fail(400, "Supply certificate JSON in the certificate query parameter, or POST the certificate.", "invalid_request");
      try { certificate = JSON.parse(encoded); } catch { fail(400, "Invalid certificate JSON.", "invalid_request"); }
    }
    if (!isRecordCertificate(certificate)) fail(400, "Malformed record certificate.", "invalid_request");
    return c.json({ data: { valid: await verifyRecordCertificate(certificate, { keys: await ctx.signer.jwks() }), notice: RECORD_CERTIFICATE_NOTICE } });
  });
}
