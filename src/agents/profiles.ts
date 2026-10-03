import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { fail } from "../lib/errors.ts";
import { policiesFor } from "./store.ts";
import { recordCertificatePayload } from "./record-certificate.ts";
import { verifyRecordCertificate, validRecordClaim, type RecordClaim } from "./record-certificate-shared.ts";
import { receiptKeyEntry } from "../tlog/entries.ts";
import type { agentProfiles } from "./profile-schema.ts";
import { cardExtras } from "../identity/card.ts"; // v6 I: identity links, liveness, track record, reputation

export const profileSlug = z.string().regex(/^[A-Za-z0-9_-]{24}$/);
export const profileTag = z.string().trim().min(1).max(40);
export const profileBody = z.strictObject({
  name: z.string().trim().min(1).max(80), description: z.string().trim().max(280),
  homepage: z.url().max(500).refine(v => { const u = new URL(v); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password; }).optional(),
  // v6 I: the agent's own HTTPS endpoint, probed daily for liveness when AGENT_IDENTITY_ENABLED is on.
  endpoint: z.url().max(500).refine(v => { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password && !u.hash; }, "must be an https URL without credentials or fragment").optional(),
  capabilities: z.array(profileTag).max(16).default([]),
  show: z.array(z.enum(["spending_caps", "ask_first", "kill_switch"])).max(3).default([]),
  certificate_claims: z.array(z.custom<RecordClaim>(validRecordClaim)).max(16).refine(v => new Set(v).size === v.length).default([]),
});
export const directoryQuery = z.strictObject({ tag: profileTag.optional(), cursor: profileSlug.optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });
export const newProfileSlug = () => randomBytes(18).toString("base64url");

// Certificates are issued for this owned key from router records, never accepted from an unrelated pseudonym.
export async function profileCertificates(ctx: Ctx, key: KeyRow, claims: RecordClaim[]) {
  if (!claims.length) return [];
  if (!ctx.cfg.agentPolicyEnabled || !ctx.tlog) fail(503, "Certificates require agent policies and the signing key log.", "record_key_log_unavailable");
  if (!(await ctx.limiter.take(`agent-certificate:${key.accountId}`, 1, 5, 60_000)).ok) fail(429, "Too many certificate requests.", "rate_limited");
  const payload = await recordCertificatePayload(ctx.db, key, claims);
  const signed = ctx.signer.sign(payload);
  const signingKey = await ctx.signer.publicKey(signed.keyId);
  if (!signingKey) fail(503, "Signing key unavailable.", "record_key_log_unavailable");
  const entry = receiptKeyEntry({ id: signingKey.id, publicKey: signingKey.publicKeyHex, validFrom: signingKey.validFrom });
  await ctx.tlog.append([entry]);
  if (!await ctx.tlog.lookup("receipt_key", entry.sha256)) fail(503, "Signing key publication unavailable.", "record_key_log_unavailable");
  const certificate = { payload, key_id: signed.keyId, signature: signed.sig };
  if (!await verifyRecordCertificate(certificate, { keys: await ctx.signer.jwks() })) fail(503, "Signing key outside its issuance window.", "record_signing_key_unavailable");
  return [certificate];
}

export async function profileCard(ctx: Ctx, row: typeof agentProfiles.$inferSelect, nowMs = Date.now()) {
  const { name, description, homepage, endpoint, capabilities, show } = row.settings;
  const summary: Record<string, boolean> = {};
  // Read policy state only for categories explicitly chosen by the owner. Exact numbers and reasons stay private.
  if (show.length && ctx.cfg.agentPolicyEnabled) {
    const rules = await policiesFor(ctx.db, row.keyHash);
    if (show.includes("spending_caps")) summary.has_spending_caps = rules.some(r => Object.keys(r.spec.caps).some(k => k.endsWith("_usd")));
    if (show.includes("ask_first")) summary.asks_before_spending = rules.some(r => !!r.spec.approval);
    if (show.includes("kill_switch")) { summary.kill_switch_armed = rules.length > 0; summary.killed = rules.some(r => r.killed); }
  }
  const keys = row.certificates.length ? await ctx.signer.jwks() : { keys: [] };
  const certificates = [];
  for (const c of row.certificates) if (await verifyRecordCertificate(c, { keys, nowMs })) certificates.push({ ...c, valid: true });
  return { name, description, url: `${ctx.cfg.publicUrl}/agents/profile/?id=${row.slug}`, capabilities,
    provider: { organization: "AnyRoute" }, ...(homepage ? { homepage } : {}), ...(endpoint ? { endpoint } : {}),
    anyroute: { id: row.slug, rulebook_summary: summary, certificates, status: { sealed: "unavailable", attested: "unavailable" }, ...(await cardExtras(ctx, row)),
      notice: "Owner-supplied profile and tags. Rulebook enforcement and router-signed records cover requests through AnyRoute only. Publishing links the selected certificates to this profile. Host sealing and attestation are not established by a rulebook or certificate." } };
}
