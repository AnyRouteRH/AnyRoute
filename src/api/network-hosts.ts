import type { Context, Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { providers } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { canonicalJson, encrypt, sha256 } from "../lib/util.ts";
import { admitHost } from "../network/admit.ts";
import { addressBucket } from "./common.ts";
import { keyPublished, onKeyPublished } from "../tlog/hooks.ts";
import type { EntryInput, EntryKind } from "../tlog/entries.ts";
import { walletAuth } from "./auth.ts";

export const networkHostSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  endpoint: z.string().url().max(2048).refine(value => { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }, "Endpoint must contain no credentials, query or fragment."),
  payout_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  models: z.array(z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/)).min(1).max(8).refine(ids => new Set(ids).size === ids.length, "Model IDs must be distinct."),
  contact: z.string().max(120).optional(),
});

async function signedBody(c: Context, ctx: Ctx) {
  const header = c.req.header("x-wallet-auth");
  if (!header) fail(401, "X-Wallet-Auth is required.", "invalid_wallet_auth");
  const reader = c.req.raw.body?.getReader();
  if (!reader) fail(400, "JSON body required.", "invalid_json");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 8192) { await reader.cancel(); fail(413, "Host body exceeds 8 KiB.", "payload_too_large"); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { fail(400, "Request body must be valid JSON.", "invalid_json"); }
  const auth = await walletAuth(ctx, header, sha256(canonicalJson(body)));
  const limit = await ctx.limiter.take(`network-host-wallet:${auth.wallet}`, 1, 3, 60_000);
  if (!limit.ok) fail(429, "Too many signup attempts for this wallet.", "rate_limited");
  return { wallet: auth.wallet, body };
}

export function networkHostRoutes(app: Hono, ctx: Ctx) {
  if (!ctx.cfg.networkHosts.enabled) return;
  app.use("/api/v1/network/hosts*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method !== "GET") {
      const from = addressBucket(c, ctx.cfg);
      const limit = await ctx.limiter.take(`network-host-address:${from.id}`, 1, from.scale(10), 60_000);
      if (!limit.ok) fail(429, "Too many signup attempts from this address.", "rate_limited");
    }
    await next();
  });
  app.post("/api/v1/network/hosts", async c => {
    const { wallet, body } = await signedBody(c, ctx);
    const spec = networkHostSchema.parse(body);
    const endpoint = new URL(spec.endpoint).toString().replace(/\/+$/, "");
    const id = `nh_${sha256(`${wallet}|${endpoint}`)}`;
    const published: { kind: EntryKind; entry?: EntryInput }[] = [];
    const result = await ctx.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
      const [old] = await tx.select().from(providers).where(eq(providers.id, id));
      if (old && (!old.networkHost || old.operator !== wallet || old.baseUrl !== `${endpoint}/v1`)) fail(409, "Host identity conflicts with an existing provider.", "conflict");
      const values = { name: spec.name, baseUrl: `${endpoint}/v1`, kind: "sidecar", operator: wallet, payoutMode: "usdg", payoutAddress: spec.payout_address.toLowerCase(), networkHost: true, networkReasons: [], status: "pending", attested: false, attestedAt: null, attestationHash: null, classifierEnabled: false, shadowUntil: null, teeKind: "tdx", attestationUrl: `${endpoint}/attest`, networkModels: spec.models, contact: spec.contact ?? null, updatedAt: new Date() };
      const [provider] = old ? await tx.update(providers).set(values).where(eq(providers.id, id)).returning() : await tx.insert(providers).values({ id, ...values }).returning();
      onKeyPublished(tx, (kind, entry) => published.push({ kind, entry }));
      try {
        const admitted = await admitHost({ ...ctx, db: tx as unknown as Db }, provider, spec.models);
        return { admitted, updated: !!old };
      } finally { onKeyPublished(tx, null); }
    });
    for (const { kind, entry } of published) keyPublished(ctx.db, kind, entry);
    return c.json(result.admitted, result.updated ? 200 : 201);
  });
  app.get("/api/v1/network/hosts/:providerId/status", async c => {
    const [p] = await ctx.db.select().from(providers).where(and(eq(providers.id, c.req.param("providerId")), eq(providers.networkHost, true)));
    if (!p) fail(404, "Network host not found.", "not_found");
    const attested = p.attested && p.attestedAt !== null && Date.now() >= p.attestedAt.getTime() && Date.now() - p.attestedAt.getTime() <= ctx.cfg.attestation.intervalMs * 3;
    return c.json({ provider_id: p.id, status: p.status, reasons: p.networkReasons, attested, probation_until: p.shadowUntil?.toISOString() ?? null, weight: 0 });
  });
  // The host generates this credential; signup and public /attest need no inference key.
  app.put("/api/v1/network/hosts/:providerId/credential", async c => {
    const { wallet, body } = await signedBody(c, ctx);
    const spec = z.strictObject({ provider_id: z.string().min(1).max(100), api_key: z.string().min(16).max(500) }).parse(body);
    if (spec.provider_id !== c.req.param("providerId")) fail(400, "Signed provider ID must match the credential path.", "invalid_request");
    const changed = await ctx.db.update(providers).set({ apiKeyEnc: encrypt(ctx.cfg.appSecret, spec.api_key), updatedAt: new Date() }).where(and(eq(providers.id, c.req.param("providerId")), eq(providers.networkHost, true), eq(providers.operator, wallet))).returning({ id: providers.id });
    if (!changed.length) fail(404, "Network host not found for this wallet.", "not_found");
    return c.json({ provider_id: changed[0].id, credential_configured: true });
  });
}
