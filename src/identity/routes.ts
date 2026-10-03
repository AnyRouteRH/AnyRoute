import type { Context, Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Hex } from "viem";
import type { Ctx } from "../context.ts";
import { keys } from "../db/schema.ts";
import { agentProfiles } from "../agents/profile-schema.ts";
import { profileSlug } from "../agents/profiles.ts";
import { isTrackRecord, verifyTrackRecord, type TrackRecordCertificate } from "../agents/track-record-shared.ts";
import { ownedKey, principal } from "../api/agents.ts";
import { requireKey } from "../api/auth.ts";
import { readJson } from "../api/common.ts";
import { fail } from "../lib/errors.ts";
import { agentFeedback } from "./schema.ts";
import { reputationSummary } from "./card.ts";
import { documentHash, giveFeedbackCall } from "./erc8004.ts";
import { feedbackBody, feedbackWeight, paidBand, revokeFeedback, submitFeedback, type FeedbackRow } from "./feedback.ts";
import { confirmRegistration, identityIdPattern, identityRow, identitySettingsJson, registrationFile, requestRegistration, updateIdentitySettings } from "./identity.ts";
import { issueTrackRecord, trackRecordById, trackRecordProof, validationEntry } from "./track-record.ts";
import { receiptKinds } from "./receipt-sources.ts";

// v6 I routes. Registered before the rulebook routes, so they answer by their own flags:
//   owner (owner/admin key, not a session key):
//   GET|PUT /api/v1/agents/:key_hash/identity            identity opt-out and reputation opt-in; registration progress
//   POST    /api/v1/agents/:key_hash/identity/register   owner mode: register() calldata; registrar mode: queue
//   POST    /api/v1/agents/:key_hash/identity/confirm    owner mode: read the owner's transaction
//   POST    /api/v1/agents/:key_hash/track-record        issue a signed track record (optionally shown on the card)
//   public:
//   GET     /api/v1/agents/identity/:id/registration.json   the ERC-8004 registration file
//   GET     /api/v1/agents/track-records/:id                certificate and its ERC-8004 validation entry
//   GET     /api/v1/agents/track-records/:id/proof?index=   one counted receipt's Merkle and anchor proofs
//   POST    /api/v1/agents/track-records/verify             check a certificate against the published keys
//   GET     /api/v1/agents/:slug/reputation                 paid-feedback reputation (PAID_FEEDBACK_ENABLED)
//   GET     /api/v1/agents/feedback/:id                     one public feedback entry (its ERC-8004 feedbackURI)
//   reviewer (any key of the paying account):
//   POST    /api/v1/agents/:slug/feedback                   needs a receipt the reviewer paid to this agent
//   DELETE  /api/v1/agents/:slug/feedback/:id               withdraw one's own entry

const settingsBody = z.strictObject({ identity_opt_out: z.boolean().optional(), reputation_opt_in: z.boolean().optional() });
const confirmBody = z.strictObject({ tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });
const trackRecordBody = z.strictObject({ publish: z.boolean().default(false) });
const feedbackIdPattern = /^fb_[0-9a-f]{24}$/;

export function identityRoutes(app: Hono, ctx: Ctx) {
  const id = ctx.cfg.identity;
  const identityOn = () => { if (!id.enabled) fail(404, "Not found.", "not_found"); };
  const feedbackOn = () => { if (!id.paidFeedback) fail(404, "Not found.", "not_found"); };
  const eitherOn = () => { if (!id.enabled && !id.paidFeedback) fail(404, "Not found.", "not_found"); };
  const live = and(eq(keys.disabled, false), sql`(${keys.expiresAt} is null or ${keys.expiresAt} > now())`);
  const listed = async (slug: string) => {
    if (!profileSlug.safeParse(slug).success) fail(404, "Profile not found.", "not_found");
    const [row] = await ctx.db.select({ slug: agentProfiles.slug, keyHash: agentProfiles.keyHash, accountId: keys.accountId }).from(agentProfiles).innerJoin(keys, eq(keys.keyHash, agentProfiles.keyHash)).where(and(eq(agentProfiles.slug, slug), live));
    if (!row) fail(404, "Profile not found.", "not_found");
    return row;
  };
  const owned = async (c: Context) => ownedKey(ctx, await principal(ctx, c), c.req.param("key_hash")!);
  const publicEntry = (f: FeedbackRow, slug: string) => ({ id: f.id, agent: slug, score: f.score, tag1: f.tag1, tag2: f.tag2, receipt_kind: f.receiptKind, paid_band: paidBand(f.paidPico), paid_day: f.paidAt.toISOString().slice(0, 10), created_at: f.createdAt.toISOString() });

  // ---- owner -------------------------------------------------------------------------------------------------------
  app.get("/api/v1/agents/:key_hash/identity", async c => {
    eitherOn(); c.header("cache-control", "no-store");
    const key = await owned(c);
    return c.json({ data: await identitySettingsJson(ctx, key.keyHash) });
  });
  app.put("/api/v1/agents/:key_hash/identity", async c => {
    eitherOn(); c.header("cache-control", "no-store");
    const key = await owned(c);
    return c.json({ data: await updateIdentitySettings(ctx, key.keyHash, settingsBody.parse(await readJson(c))) });
  });
  app.post("/api/v1/agents/:key_hash/identity/register", async c => {
    identityOn(); c.header("cache-control", "no-store");
    const key = await owned(c);
    if (key.disabled || (key.expiresAt && key.expiresAt <= new Date())) fail(409, "Only active keys can register an identity.", "invalid_request");
    return c.json({ data: await requestRegistration(ctx, key.keyHash) });
  });
  app.post("/api/v1/agents/:key_hash/identity/confirm", async c => {
    identityOn(); c.header("cache-control", "no-store");
    const key = await owned(c);
    const { tx_hash } = confirmBody.parse(await readJson(c));
    return c.json({ data: await confirmRegistration(ctx, key.keyHash, tx_hash as Hex) });
  });
  app.post("/api/v1/agents/:key_hash/track-record", async c => {
    identityOn(); c.header("cache-control", "no-store");
    const key = await owned(c);
    if (key.disabled || (key.expiresAt && key.expiresAt <= new Date())) fail(409, "Only active keys can request a track record.", "invalid_request");
    const { publish } = trackRecordBody.parse(await readJson(c));
    return c.json({ data: await issueTrackRecord(ctx, key, publish) });
  });

  // ---- public identity and track records ---------------------------------------------------------------------------
  app.get("/api/v1/agents/identity/:id/registration.json", async c => {
    identityOn(); c.header("cache-control", "no-store");
    const file = identityIdPattern.test(c.req.param("id")) ? await registrationFile(ctx, c.req.param("id")) : null;
    if (!file) fail(404, "Registration not found.", "not_found");
    return c.json(file);
  });
  app.post("/api/v1/agents/track-records/verify", async c => {
    identityOn(); c.header("cache-control", "no-store");
    const body = await readJson(c);
    if (!isTrackRecord(body)) fail(400, "Malformed track record.", "invalid_request");
    return c.json({ data: { valid: verifyTrackRecord(body, { keys: await ctx.signer.jwks() }), notice: (body as TrackRecordCertificate).payload.notice } });
  });
  app.get("/api/v1/agents/track-records/:id", async c => {
    identityOn(); c.header("cache-control", "no-store");
    const row = await trackRecordById(ctx, c.req.param("id"));
    if (!row) fail(404, "Track record not found.", "not_found");
    const certificate = row.certificate as TrackRecordCertificate;
    return c.json({ data: { id: row.id, certificate, valid: verifyTrackRecord(certificate, { keys: await ctx.signer.jwks() }), validation: validationEntry(ctx, row.id, certificate) } });
  });
  app.get("/api/v1/agents/track-records/:id/proof", async c => {
    identityOn(); c.header("cache-control", "no-store");
    const row = await trackRecordById(ctx, c.req.param("id"));
    if (!row) fail(404, "Track record not found.", "not_found");
    const index = z.coerce.number().int().min(0).max(1_000_000).parse(c.req.query("index") ?? "0");
    return c.json({ data: await trackRecordProof(ctx, row, index) });
  });

  // ---- paid feedback -----------------------------------------------------------------------------------------------
  app.get("/api/v1/agents/feedback/:id", async c => {
    feedbackOn(); c.header("cache-control", "no-store");
    if (!feedbackIdPattern.test(c.req.param("id"))) fail(404, "Feedback not found.", "not_found");
    const [f] = await ctx.db.select({ f: agentFeedback, slug: agentProfiles.slug }).from(agentFeedback).innerJoin(agentProfiles, eq(agentProfiles.keyHash, agentFeedback.subjectKeyHash)).innerJoin(keys, eq(keys.keyHash, agentFeedback.subjectKeyHash))
      .where(and(eq(agentFeedback.id, c.req.param("id")), sql`${agentFeedback.revokedAt} is null`, live));
    if (!f || !(await identityRow(ctx, f.f.subjectKeyHash))?.reputationOptIn) fail(404, "Feedback not found.", "not_found");
    return c.json(publicEntry(f.f, f.slug));
  });
  app.get("/api/v1/agents/:slug/reputation", async c => {
    feedbackOn(); c.header("cache-control", "no-store");
    const subject = await listed(c.req.param("slug"));
    const { summary, rows } = await reputationSummary(ctx, subject.keyHash, subject.slug);
    const identity = await identityRow(ctx, subject.keyHash);
    return c.json({ data: { agent: subject.slug, ...summary, receipt_kinds: receiptKinds(),
      recent: rows.slice(0, 20).map(f => publicEntry(f, subject.slug)),
      erc8004: identity?.status === "registered" && identity.reputationOptIn ? { registry: identity.registry, agent_id: identity.agentId, reputation_registry: id.registries.reputation ?? null } : null,
      notice: "Every entry is backed by a receipt on which the reviewer paid this agent through AnyRoute. Entries weigh what was paid, halving every half_life_days after the payment. Reviewers are not shown." } });
  });
  app.post("/api/v1/agents/:slug/feedback", async c => {
    feedbackOn(); c.header("cache-control", "no-store");
    const reviewer = await requireKey(ctx, c.req.header("authorization"));
    const limit = await ctx.limiter.take(`agent-feedback:${reviewer.accountId}`, 1, 30, 60_000);
    if (!limit.ok) { c.header("retry-after", String(Math.ceil(limit.retryAfterMs / 1000))); fail(429, "Too many feedback requests.", "rate_limited"); }
    const subject = await listed(c.req.param("slug"));
    if (!(await identityRow(ctx, subject.keyHash))?.reputationOptIn) fail(409, "This agent has not opted in to reputation.", "reputation_not_enabled");
    const input = feedbackBody.parse(await readJson(c));
    const row = await submitFeedback(ctx, reviewer, subject, input);
    const identity = await identityRow(ctx, subject.keyHash);
    const entry = publicEntry(row, subject.slug), feedbackURI = `${ctx.cfg.publicUrl}/api/v1/agents/feedback/${row.id}`;
    const onchain = identity?.status === "registered" && identity.agentId && id.registries.reputation
      ? { to: id.registries.reputation, chain_id: ctx.cfg.chain.id, feedback_uri: feedbackURI, feedback_hash: documentHash(entry), data: giveFeedbackCall({ agentId: BigInt(identity.agentId), score: row.score, tag1: row.tag1 ?? "", tag2: row.tag2 ?? "", feedbackURI, feedbackHash: documentHash(entry) }), note: "Optional: send from your own wallet to also record this on the ERC-8004 reputation registry." }
      : null;
    return c.json({ data: { ...entry, weight_usd_now: Math.round(feedbackWeight(row.paidPico, row.paidAt, new Date(), id.halfLifeDays) * 1e6) / 1e6, erc8004: onchain } }, 201);
  });
  app.delete("/api/v1/agents/:slug/feedback/:id", async c => {
    feedbackOn(); c.header("cache-control", "no-store");
    const reviewer = await requireKey(ctx, c.req.header("authorization"));
    const subject = await listed(c.req.param("slug"));
    if (!feedbackIdPattern.test(c.req.param("id"))) fail(404, "Feedback not found.", "not_found");
    await revokeFeedback(ctx, reviewer, subject.keyHash, c.req.param("id"));
    return c.json({ data: { revoked: true } });
  });
}
