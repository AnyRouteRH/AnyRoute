import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chainCursor, kv, providers } from "../src/db/schema.ts";
import { CRITICAL_JOBS, readiness } from "../src/services/readiness.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";

let publicHarness: Harness;
let teeHarness: Harness;
beforeAll(async () => {
  publicHarness = await startRouter({ providers: [{ id: "public-only", name: "Public", models: [MODELS.llama] }] });
  teeHarness = await startRouter({ providers: [{ id: "private-fixture", name: "Private fixture", models: [MODELS.llama], tee: "dev" }] });
});
afterAll(async () => { await publicHarness.close(); await teeHarness.close(); });

async function makeBaseReady(h: Harness) {
  const ctx = h.ctx;
  ctx.cfg.chain.credits = "0x0000000000000000000000000000000000000001";
  ctx.cfg.chain.receiptAnchor = "0x0000000000000000000000000000000000000002";
  h.chain.client.getChainId = async () => ctx.cfg.chain.id;
  h.chain.controlsReady = true;
  await ctx.db.insert(chainCursor).values({ id: "main", block: 100n }).onConflictDoUpdate({ target: chainCursor.id, set: { block: 100n } });
  const lastSuccess = new Date().toISOString();
  for (const name of CRITICAL_JOBS) {
    const value = { name, every_ms: 5000, last_error: null, last_success: lastSuccess };
    await ctx.db.insert(kv).values({ key: `job-health:${name}`, value }).onConflictDoUpdate({ target: kv.key, set: { value } });
  }
}

async function markPrivateTee(h: Harness, teeKind: "tdx" | "nvidia-cc", attestedAt = new Date()) {
  h.ctx.cfg.production = true;
  h.ctx.cfg.attestation.tdxVerifierUrl = "http://verifier-sidecar.internal";
  h.ctx.cfg.attestation.nrasUrl = "https://nras-fixture.internal/verify";
  await h.ctx.db.update(providers).set({ teeKind, attested: true, attestationHash: "0x" + "a1".repeat(32), attestedAt }).where(eq(providers.id, "private-fixture"));
  const value = { name: "attestor", every_ms: h.ctx.cfg.attestation.intervalMs, last_error: null, last_success: new Date().toISOString() };
  await h.ctx.db.insert(kv).values({ key: "job-health:attestor", value }).onConflictDoUpdate({ target: kv.key, set: { value } });
}

test("public-only production readiness does not require private attestation infrastructure", async () => {
  await makeBaseReady(publicHarness);
  publicHarness.ctx.cfg.production = true;
  publicHarness.ctx.cfg.attestation.tdxVerifierUrl = undefined;
  const result = await readiness(publicHarness.ctx);
  expect(result.ok).toBe(true);
  expect(result.checks.private_attestation_verifiers).toBe(true);
  expect(result.checks.attestor).toBeUndefined();
  expect(result.checks.private_attestation).toBeUndefined();
});

test("fresh private TDX offer requires its verifier and a healthy attestor worker", async () => {
  await makeBaseReady(teeHarness);
  await markPrivateTee(teeHarness, "tdx");
  teeHarness.ctx.cfg.attestation.nrasUrl = ""; // TDX verification does not depend on NVIDIA NRAS.
  const result = await readiness(teeHarness.ctx);
  expect(result.ok).toBe(true);
  expect(result.checks.private_attestation_verifiers).toBe(true);
  expect(result.checks.private_attestation).toBe(true);
  expect(result.checks.attestor).toBe(true);
});

test("missing verifier configuration and stale or failed attestation workers fail readiness", async () => {
  await makeBaseReady(teeHarness);
  await markPrivateTee(teeHarness, "tdx");
  teeHarness.ctx.cfg.attestation.tdxVerifierUrl = undefined;
  expect((await readiness(teeHarness.ctx)).checks.private_attestation_verifiers).toBe(false);

  teeHarness.ctx.cfg.attestation.tdxVerifierUrl = "http://verifier-sidecar.internal";
  await teeHarness.ctx.db.update(providers).set({ attestedAt: new Date(Date.now() - teeHarness.ctx.cfg.attestation.intervalMs * 4) }).where(eq(providers.id, "private-fixture"));
  expect((await readiness(teeHarness.ctx)).checks.private_attestation).toBe(false);

  await teeHarness.ctx.db.update(providers).set({ attestedAt: new Date() }).where(eq(providers.id, "private-fixture"));
  const failed = { name: "attestor", every_ms: teeHarness.ctx.cfg.attestation.intervalMs, last_error: "fixture failure", last_success: new Date().toISOString() };
  await teeHarness.ctx.db.update(kv).set({ value: failed }).where(eq(kv.key, "job-health:attestor"));
  expect((await readiness(teeHarness.ctx)).checks.attestor).toBe(false);

  const stale = { name: "attestor", every_ms: teeHarness.ctx.cfg.attestation.intervalMs, last_error: null, last_success: new Date(Date.now() - teeHarness.ctx.cfg.attestation.intervalMs * 3).toISOString() };
  await teeHarness.ctx.db.update(kv).set({ value: stale }).where(eq(kv.key, "job-health:attestor"));
  expect((await readiness(teeHarness.ctx)).checks.attestor).toBe(false);
});

test("live NVIDIA confidential computing provider also requires the NRAS verifier path", async () => {
  await makeBaseReady(teeHarness);
  await markPrivateTee(teeHarness, "nvidia-cc");
  teeHarness.ctx.cfg.attestation.nrasUrl = "";
  expect((await readiness(teeHarness.ctx)).checks.private_attestation_verifiers).toBe(false);
});
