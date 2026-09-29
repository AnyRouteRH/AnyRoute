import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import { attestations, providers } from "../src/db/schema.ts";

// GET /api/v1/providers carries the router's own attestation summary for each provider, computed the way
// GET /api/v1/attestation/:providerId computes it. It never repeats what a provider says about itself.

const HASH = "0x" + "ab".repeat(32);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe("the public provider list", () => {
  let h: Harness;
  const list = async () => ((await (await h.request("/api/v1/providers")).json()) as { data: any[] }).data;
  const bySlug = async () => Object.fromEntries((await list()).map((p) => [p.slug, p]));
  const record = (id: string, ok: boolean, detail: Record<string, unknown>, ts = new Date()) => h.ctx.db.insert(attestations).values({ providerId: id, ok, ts, teeKind: "tdx", detail });

  beforeAll(async () => {
    h = await startRouter({
      providers: ["fresh", "stale", "never", "failing", "sim", "pending"].map((id) => ({ id, name: id, models: [MODELS.llama], live: id !== "pending" })),
    });
    const set = (id: string, v: Partial<typeof providers.$inferInsert>) => h.ctx.db.update(providers).set(v).where(eq(providers.id, id));
    await set("fresh", { teeKind: "tdx", attestationUrl: "https://internal.example/attest", attested: true, attestationHash: HASH, attestedAt: minutesAgo(1) });
    await set("stale", { teeKind: "tdx", attested: true, attestationHash: HASH, attestedAt: new Date(Date.now() - h.ctx.cfg.attestation.intervalMs * 10) });
    await set("failing", { teeKind: "tdx", attested: false, attestedAt: minutesAgo(30) });
    await set("sim", { teeKind: "dev", attested: true, attestationHash: HASH, attestedAt: minutesAgo(1) });
    await record("fresh", false, { reason: "older attempt failed" }, minutesAgo(20));
    await record("fresh", true, { verifiers: ["dcap", "dstack"], simulated: false }, minutesAgo(1));
    await record("stale", true, { verifiers: ["dcap"] }, minutesAgo(600));
    await record("failing", true, { verifiers: ["dcap"] }, minutesAgo(40));
    await record("failing", false, { reason: "quote rejected" }, minutesAgo(5));
    await record("sim", true, { verifiers: [], simulated: true }, minutesAgo(1));
    await h.ctx.catalog.refresh();
  });
  afterAll(async () => h.close());

  test("each provider reports the router's status, verifiers and last attestation", async () => {
    const p = await bySlug();
    expect(p.fresh.attestation).toMatchObject({ status: "attested", tee: "tdx", verifiers: ["dcap", "dstack"], last_attempt_ok: true });
    expect(p.fresh.attestation).not.toHaveProperty("reason");
    expect(Date.parse(p.fresh.attestation.last_verified_at)).toBeGreaterThan(Date.now() - 5 * 60_000);
    expect(Date.parse(p.fresh.attestation.last_attempt_at)).toBeGreaterThan(Date.now() - 5 * 60_000);
  });

  test("anything the router did not verify recently is unverified, with the reason, and lists no verifiers", async () => {
    const p = await bySlug();
    expect(p.stale.attestation).toMatchObject({ status: "unverified", reason: "attestation_stale", verifiers: [], last_attempt_ok: true });
    expect(p.never.attestation).toMatchObject({ status: "unverified", reason: "no_attestation", tee: null, verifiers: [], last_verified_at: null, last_attempt_at: null, last_attempt_ok: null });
    expect(p.failing.attestation).toMatchObject({ status: "unverified", reason: "last_attempt_failed", verifiers: [], last_attempt_ok: false });
  });

  test("simulated evidence is labelled simulated outside production and unverified in production", async () => {
    expect((await bySlug()).sim.attestation).toMatchObject({ status: "simulated", tee: "dev", verifiers: [] });
    (h.ctx.cfg as { production: boolean }).production = true;
    try {
      expect((await bySlug()).sim.attestation).toMatchObject({ status: "unverified", reason: "simulated_evidence_refused", tee: "dev" });
    } finally {
      (h.ctx.cfg as { production: boolean }).production = false;
    }
  });

  test("the list agrees with the attestation endpoint for every provider, and a pending application is not listed", async () => {
    const p = await bySlug();
    expect(p.pending).toBeUndefined();
    for (const id of ["fresh", "stale", "never", "failing", "sim"]) {
      const one = ((await (await h.request(`/api/v1/attestation/${id}`)).json()) as { data: any }).data;
      expect(p[id].attestation.status).toBe(one.status);
      expect(p[id].attestation.reason).toBe(one.reason);
      expect(p[id].attestation.verifiers).toEqual(one.verifiers);
      expect(p[id].attestation.tee).toBe(one.tee);
    }
  });

  test("the fields that existed before are unchanged and nothing internal is added", async () => {
    const fresh = (await bySlug()).fresh;
    expect(Object.keys(fresh).sort()).toEqual(
      ["anyr_stake", "attested", "attested_at", "attestation", "attestation_fresh", "attestation_hash", "bond_usdg", "classifier_enabled", "data_policy", "datacenters", "health_events_30d", "latency_p50_ms", "models", "name", "outage", "quantizations", "slug", "status", "tee", "uptime_30d"].sort(),
    );
    expect(fresh.attestation_fresh).toBe(true);
    expect(JSON.stringify(await list())).not.toContain("internal.example");
  });
});
