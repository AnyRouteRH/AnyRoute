import { networkPayoutDashboard } from "../network/payout-dashboard.ts";
import { publicHostBond } from "../network/bonds.ts";
import type { Hono } from "hono";
import { and, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { hostAnchors, offers, providers, settlements } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { sha256 } from "../lib/util.ts";
import { walletAuth } from "./auth.ts";
import { probationRegistryFilter } from "../network/offers.ts";
import { hostAdmission } from "../network/dashboard.ts";
import { latestAttempts, summarizeAttestation } from "./provider-attestation.ts";

// A GET has no body. Bind its wallet signature to this exact resource instead,
// so it cannot authorize a payment or the private view of another host.
export const hostWalletHash = (id: string) => sha256(`GET /api/v1/hosts/${encodeURIComponent(id)}`);

export function earningsBand(units: bigint) {
  if (units <= 0n) return "none yet";
  if (units < 1_000_000n) return "<$1";
  if (units < 10_000_000n) return "$1–10";
  if (units < 100_000_000n) return "$10–100";
  if (units < 1_000_000_000n) return "$100–1,000";
  return "$1,000+";
}

const facts = { networkHost: providers.networkHost, networkReasons: providers.networkReasons, id: providers.id, name: providers.name, teeKind: providers.teeKind, attested: providers.attested, attestationHash: providers.attestationHash, attestedAt: providers.attestedAt, status: providers.status, shadowUntil: providers.shadowUntil };
const visible = (ctx: Ctx) => and(or(inArray(providers.status, ["shadow", "live", "suspended", "delisted"]), probationRegistryFilter(ctx.cfg)), isNotNull(providers.attestedAt), isNotNull(providers.attestationHash), isNotNull(providers.teeKind), ne(providers.teeKind, "dev"));

async function publicHost(ctx: Ctx, p: Pick<typeof providers.$inferSelect, keyof typeof facts>, attempts: Awaited<ReturnType<typeof latestAttempts>>) {
  const last = attempts.get(p.id);
  const attestation = summarizeAttestation(ctx, { ...p, attested: p.attested && last?.ok === true }, last);
  attestation.verifiers = Array.isArray(attestation.verifiers) ? attestation.verifiers.filter((v) => typeof v === "string" && /^[\w.-]{1,32}$/.test(v)) : [];
  const models = await ctx.db.select({ id: offers.modelId }).from(offers).where(and(eq(offers.providerId, p.id), inArray(offers.status, ["live", "shadow"]))).orderBy(offers.modelId);
  return {
    id: p.id, name: p.name, tee_kind: p.teeKind,
    attested: attestation.status === "attested", status: p.status,
    probation: p.status === "shadow" || !!p.shadowUntil && p.shadowUntil.getTime() > Date.now(),
    shadow_until: p.shadowUntil?.toISOString() ?? null,
    models: models.map((m) => m.id), attestation, admission: await hostAdmission(ctx, p, attestation),
    ...(ctx.cfg.hostBonds.enabled ? { bond: await publicHostBond(ctx, p.id) } : {}),
    verify_url: `/verify/?p=${encodeURIComponent(p.id)}`,
  };
}

export function hostRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/hosts", async (c) => {
    const rows = await ctx.db.select(facts).from(providers).where(visible(ctx)).orderBy(providers.id);
    const attempts = await latestAttempts(ctx, rows.map((p) => p.id));
    const data = await Promise.all(rows.map((p) => publicHost(ctx, p, attempts)));
    c.header("Cache-Control", "public, max-age=30");
    return c.json({ data: data.filter((p) => p.attestation.status !== "simulated" && p.attestation.reason !== "simulated_evidence_refused") });
  });

  app.get("/api/v1/hosts/:providerId", async (c) => {
    // Never cache a response that may contain operator-only values, even at a shared proxy.
    c.header("Cache-Control", "no-store");
    c.header("Vary", "X-Wallet-Auth");
    const id = c.req.param("providerId");
    const [p] = await ctx.db.select(facts).from(providers).where(and(visible(ctx), eq(providers.id, id)));
    if (!p) fail(404, "Unknown host.", "not_found");
    const host = await publicHost(ctx, p, await latestAttempts(ctx, [id]));
    if (host.attestation.status === "simulated" || host.attestation.reason === "simulated_evidence_refused") fail(404, "Unknown host.", "not_found");
    let operator: { payout_address: string | null; payout_mode: string } | null = null;
    const auth = c.req.header("X-Wallet-Auth");
    if (auth !== undefined) {
      const wallet = await walletAuth(ctx, auth, hostWalletHash(id));
      const [privateFields] = await ctx.db.select({ payout_address: providers.payoutAddress, payout_mode: providers.payoutMode }).from(providers).where(and(eq(providers.id, id), sql`lower(${providers.operator}) = ${wallet.wallet}`));
      if (!privateFields) fail(403, "Only this host's operator may read exact earnings.", "forbidden");
      operator = privateFields;
    }
    // Existing public routes own their verification, history retention and sanitization.
    const read = async (path: string) => {
      const res = await app.request(path);
      if (res.status === 501) return null;
      if (!res.ok) fail(503, "The host's evidence could not be read.", "evidence_unavailable");
      return await res.json() as { data: any; next?: string | null; history_days?: number };
    };
    const [evidence, history, proofTime, liveModels, totals, latest, invoice] = await Promise.all([
      read(`/api/v1/attestation/${encodeURIComponent(id)}`),
      read(`/api/v1/attestation/${encodeURIComponent(id)}/history?limit=50`),
      read("/api/v1/attestation/summary"),
      ctx.db.select({ id: offers.modelId }).from(offers).where(and(eq(offers.providerId, id), eq(offers.status, "live"))),
      ctx.db.select({ roots: sql<number>`count(*)::int`, anchored: sql<number>`count(*) filter (where ${hostAnchors.status} = 'confirmed' and ${hostAnchors.txHash} is not null)::int` }).from(hostAnchors).where(eq(hostAnchors.providerId, id)),
      ctx.db.select({ id: hostAnchors.id, root: hostAnchors.root, status: hostAnchors.status, txHash: hostAnchors.txHash, blockNumber: hostAnchors.blockNumber, fromTs: hostAnchors.fromTs, toTs: hostAnchors.toTs, count: hostAnchors.count, attestationRef: hostAnchors.attestationRef }).from(hostAnchors).where(eq(hostAnchors.providerId, id)).orderBy(desc(hostAnchors.toTs), desc(hostAnchors.id)).limit(1),
      ctx.db.select({ total: sql<string>`coalesce(sum(${settlements.usdgOwed}), 0)::text`, unpaid: sql<string>`coalesce(sum(${settlements.usdgOwed}) filter (where ${settlements.paidTx} is null), 0)::text` }).from(settlements).where(eq(settlements.providerId, id)),
    ]);
    const e = evidence!.data;
    const root = latest[0];
    // The same observed health samples used by /providers, without refreshing the catalog.
    const observations = liveModels.map((m) => ctx.health.observedUptime(m.id, id)).filter((o) => o !== null);
    const events = observations.reduce((n, o) => n + o.events, 0);
    const successPct = events ? Number((100 * observations.reduce((n, o) => n + o.rate * o.events, 0) / events).toFixed(2)) : null;
    const summary = proofTime?.data;
    const total = BigInt(invoice[0].total);
    return c.json({ data: {
      ...host, ...(await networkPayoutDashboard(ctx, id, p.networkHost, !!operator, earningsBand)),
      attestation: { ...host.attestation, checks: e.checks, not_checked: e.not_checked },
      attestation_history: history ? { data: history.data, next: history.next, history_days: history.history_days, url: `/api/v1/attestation/${encodeURIComponent(id)}/history` } : null,
      measurement: e.measurement, measurement_history: e.measurement_history,
      anchoring: { roots: totals[0].roots, anchored_roots: totals[0].anchored, latest: root ? { id: root.id, root: root.root, status: root.status, anchored: root.status === "confirmed" && !!root.txHash, tx_hash: root.txHash, block_number: root.blockNumber, from_ts: root.fromTs.toISOString(), to_ts: root.toTs.toISOString(), receipts: root.count, attestation_ref: root.attestationRef } : null },
      uptime: { success_pct_30d: successPct, observations_30d: events, definition: "Successful observed requests and probes across served models; not continuous availability." },
      proof_time: summary ? { generated_at: summary.generated_at, history_days: summary.history_days, fresh_within_ms: summary.fresh_within_ms, host: summary.providers.find((row: any) => row.provider === id) ?? null } : null,
      earnings: { band: earningsBand(total), basis: "Lifetime settlement invoices after provider fees, including paid invoices; excludes the open hour." },
      ...(operator ? { operator: { ...operator, invoiced_usdg_units: total.toString(), unpaid_usdg_units: invoice[0].unpaid, decimals: 6 } } : {}),
    } });
  });
}
