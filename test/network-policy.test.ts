import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes, verify } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { hostPolicies, tlogEntries } from "../src/db/schema.ts";
import { canonicalJson, sha256 } from "../src/lib/util.ts";
import { checkHostAgainstPolicy, hostPolicySchema, policyHash, policyJson, type HostPolicy, type HostPolicyBindings } from "../src/network/policy.ts";
import { publishHostPolicy } from "../src/network/publication.ts";
import { formatSignerKey, noteSigner, parseVerifierKey, SIG_COSIGNATURE_V1 } from "../src/tlog/note.ts";
import { draftHostPolicy } from "../scripts/network-policy.ts";
import { ADMIN, startRouter, type Harness } from "./helpers.ts";

setDefaultTimeout(60_000);
const d = (n: number) => `sha256:${String(n).repeat(64)}`;
const policy = (version = 1): HostPolicy => ({ version, issued_at: "2026-01-01T00:00:00.000Z", tee_kinds: ["tdx"], sidecar: { image_digests: [d(1)], source_hashes: [d(2)] }, engines: [{ name: "engine", image_digest: d(3) }], models: [{ id: "cpu", model_digest: d(4), min_gpu_cc: false }, { id: "gpu", model_digest: d(5), min_gpu_cc: true }], rules: { require_gpu_cc_for: [], allow_dev: false } });
const host = (): HostPolicyBindings => ({ tee_kind: "tdx", hardware_verified: true, bindings_committed: true, bindings: { image_digest: d(1), source_hash: d(2), compose_hash: d(6), engines: [{ name: "engine", image_digest: d(3) }], model_id: "cpu", model_digest: d(4) } });
const TLOG = { TLOG_ENABLED: "true", NETWORK_POLICY_ENABLED: "true", TLOG_ORIGIN: "policy.test/tlog" };

describe("pure host policy", () => {
  test("canonical hash is stable across object key order and covers every pin and version", () => {
    const p = policy();
    const reordered = Object.fromEntries(Object.entries(p).reverse()) as HostPolicy;
    expect(policyJson(p)).toBe(canonicalJson(p));
    expect(policyHash(reordered)).toBe(sha256(policyJson(p)));
    expect(policyHash(policy(2))).not.toBe(policyHash(p));
    const changed = policy(); changed.sidecar.source_hashes = [d(7)];
    expect(policyHash(changed)).not.toBe(policyHash(p));
  });
  test("approves a complete verified CPU host and normalizes binding digest formats", () => {
    const h = host(); h.bindings.image_digest = "0x" + "1".repeat(64);
    expect(checkHostAgainstPolicy(h, policy())).toEqual({ ok: true, reasons: [] });
  });
  const cases: [string, (h: HostPolicyBindings) => void, string][] = [
    ["hardware", h => h.hardware_verified = false, "Hardware attestation has not been verified."],
    ["commitment", h => h.bindings_committed = false, "Host bindings have not been verified as committed to the hardware quote."],
    ["TEE", h => h.tee_kind = "snp", "The host's TEE kind is not approved by this policy."],
    ["image", h => h.bindings.image_digest = d(7), "The sidecar image digest is missing or off-policy."],
    ["source", h => delete h.bindings.source_hash, "The quote-bound sidecar source hash is missing or off-policy."],
    ["compose", h => h.bindings.compose_hash = "bad", "The quote-bound compose hash is missing or invalid."],
    ["engine absent", h => delete h.bindings.engines, "No quote-bound engine image is available."],
    ["engine image", h => h.bindings.engines![0].image_digest = d(7), "Engine engine has an unapproved name or image digest."],
    ["model absent", h => delete h.bindings.model_digest, "No quote-bound model digest is available."],
    ["model digest", h => h.bindings.model_digest = d(7), "Model cpu has an unknown model ID or digest."],
    ["model ID", h => delete h.bindings.model_id, "Model (unnamed) has an unknown model ID or digest."],
    ["GPU", h => { h.bindings.model_id = "gpu"; h.bindings.model_digest = d(5); }, "Model gpu requires verified GPU confidential-computing evidence."],
  ];
  for (const [name, edit, reason] of cases) test(`refuses ${name} with a precise reason`, () => {
    const h = host(); edit(h);
    expect(checkHostAgainstPolicy(h, policy())).toEqual({ ok: false, reasons: [reason] });
  });
  test("development markers always refuse even with hardware and GPU flags", () => {
    for (const edit of [(h: HostPolicyBindings) => h.dev = true, (h: HostPolicyBindings) => h.simulated = true, (h: HostPolicyBindings) => h.bindings.dev = true, (h: HostPolicyBindings) => h.tee_kind = "dev"]) {
      const h = host(); h.gpu_cc_verified = true; edit(h);
      expect(checkHostAgainstPolicy(h, policy()).reasons).toContain("Development evidence is never accepted for a network host.");
    }
    const p = policy(); (p.rules as any).allow_dev = true;
    expect(checkHostAgainstPolicy(host(), p)).toEqual({ ok: false, reasons: ["The host policy is invalid."] });
  });
  test("GPU rules also apply to CPU-listed models; verified GPU evidence satisfies both requirements", () => {
    const h = host(), p = policy(); p.rules.require_gpu_cc_for = ["cpu"];
    expect(checkHostAgainstPolicy(h, p).ok).toBe(false);
    h.gpu_cc_verified = true;
    expect(checkHostAgainstPolicy(h, p).ok).toBe(true);
    h.bindings.model_id = "gpu"; h.bindings.model_digest = d(5);
    expect(checkHostAgainstPolicy(h, p).ok).toBe(true);
  });
  test("all models and engines are checked, including simultaneous singular and list fields", () => {
    const h = host(); h.bindings.models = [{ id: "gpu", model_digest: d(5) }];
    h.bindings.engines!.push({ name: "other", image_digest: d(7) });
    expect(checkHostAgainstPolicy(h, policy()).reasons).toHaveLength(2);
    h.bindings.models = [{ id: "cpu", model_digest: d(4) }]; h.bindings.model_digest = d(7);
    expect(checkHostAgainstPolicy(h, policy()).reasons).toContain("Model cpu has an unknown model ID or digest.");
  });
  test("invalid input, duplicate identities, unknown GPU rules and open-ended fields fail closed", () => {
    expect(checkHostAgainstPolicy({} as any, policy()).ok).toBe(false);
    const p = policy(); p.models.push(p.models[0]); expect(hostPolicySchema.safeParse(p).success).toBe(false);
    p.models.pop(); p.rules.require_gpu_cc_for = ["unknown"]; expect(hostPolicySchema.safeParse(p).success).toBe(false);
    expect(hostPolicySchema.safeParse({ ...policy(), extra: true }).success).toBe(false);
  });
  test("draft refuses stale evidence and leaves unsupported provenance fields unfilled", () => {
    const record = { status: "attested", tee: "tdx", verifiers: ["dcap"], checks: { quote_verified: true, digests_bound_to_quote: true }, measurement: { attested_now: true, image_digest: d(1), compose_hash: d(6), model_digest: d(4) } };
    const draft = draftHostPolicy(record, "cpu");
    expect(draft.sidecar.image_digests).toEqual([d(1)]);
    expect(draft.sidecar.source_hashes).toEqual([]); expect(draft.engines).toEqual([]);
    expect(hostPolicySchema.safeParse(draft).success).toBe(false);
    expect(() => draftHostPolicy({ ...record, status: "simulated" }, "cpu")).toThrow("fresh, verified");
    expect(() => draftHostPolicy({ ...record, checks: {} }, "cpu")).toThrow("fresh, verified");
  });
});

test("production config starts with the feature enabled and preserves log independence guards", () => {
  const witnesses = [1, 2].map(i => noteSigner(`w${i}.example/w`, SIG_COSIGNATURE_V1, randomBytes(32)).verifierKey).join(",");
  const production = { NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: "0x" + "1".repeat(40), CALLPAY_ADDRESS: "0x" + "1".repeat(40), PROVIDER_BOND_ADDRESS: "0x" + "1".repeat(40), RECEIPT_ANCHOR_ADDRESS: "0x" + "1".repeat(40), ROUTER_PRIVATE_KEY: "0x" + "2".repeat(64), ALLOW_DEV_ATTESTATION: "false", ...TLOG, TLOG_SIGNING_KEY: formatSignerKey("policy.test/tlog", randomBytes(32)), TLOG_WITNESSES: witnesses };
  expect(loadConfig(production).networkPolicyEnabled).toBe(true);
  expect(() => loadConfig({ ...production, TLOG_WITNESSES: "" })).toThrow("independent check");
  expect(() => loadConfig({ NETWORK_POLICY_ENABLED: "true", TLOG_ENABLED: "false" })).toThrow("needs TLOG_ENABLED");
  expect(loadConfig({ NETWORK_POLICY_ENABLED: "false" }).networkPolicyEnabled).toBe(false);
});

describe("policy publication and public history", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter({ env: TLOG }); await h.ctx.tlog!.idle(); });
  afterAll(async () => h.close());
  const publish = (p: HostPolicy, token?: string) => h.request("/trpc/network.publishPolicy", { method: "POST", headers: token ? { "x-admin-token": token } : {}, json: p });
  test("nothing is seeded; publishing requires admin, including for an API key holder", async () => {
    expect((await h.request("/api/v1/network/policy")).status).toBe(404);
    expect((await publish(policy())).status).toBe(401);
    expect((await publish(policy(), "wrong")).status).toBe(401);
    const key = await h.newKey(); expect((await publish(policy(), key.secret)).status).toBe(401);
    expect(await h.ctx.db.select().from(hostPolicies)).toHaveLength(0);
  });
  test("publish signs canonical bytes, logs its hash under a signed checkpoint and serves the same version", async () => {
    const r = await publish(policy(), ADMIN); expect(r.status).toBe(200);
    const current = await h.request("/api/v1/network/policy"); expect(current.status).toBe(200);
    const body = (await current.json()).data;
    expect(body.canonical).toBe(policyJson(policy())); expect(body.sha256).toBe(policyHash(policy()));
    expect(verify(null, Buffer.from(body.canonical), parseVerifierKey(body.signature.verifier_key).key, Buffer.from(body.signature.value, "base64"))).toBe(true);
    const proof = await h.request(body.transparency_log.proof_url); expect(proof.status).toBe(200);
    expect((await proof.json()).data).toMatchObject({ kind: "host_policy", sha256: body.sha256 });
    const version = await h.request("/api/v1/network/policy/1"); expect((await version.json()).data).toEqual(body);
    expect(version.headers.get("cache-control")).toContain("immutable"); expect(current.headers.get("cache-control")).toBe("no-store");
  });
  test("versions are consecutive, immutable and idempotent; previous versions remain public", async () => {
    expect((await publish(policy(), ADMIN)).status).toBe(200);
    const changed = policy(); changed.sidecar.image_digests = [d(7)]; expect((await publish(changed, ADMIN)).status).toBe(409);
    expect((await publish(policy(3), ADMIN)).status).toBe(409);
    expect((await publish(policy(2), ADMIN)).status).toBe(200);
    expect((await (await h.request("/api/v1/network/policy")).json()).data.policy.version).toBe(2);
    expect((await (await h.request("/api/v1/network/policy/1")).json()).data.policy.version).toBe(1);
    expect(await h.ctx.db.select().from(tlogEntries).where(eq(tlogEntries.kind, "host_policy"))).toHaveLength(2);
    expect((await h.request("/api/v1/network/policy/999")).status).toBe(404);
    expect((await h.request("/api/v1/network/policy/01")).status).toBe(400);
    const future = policy(3); future.issued_at = "2099-01-01T00:00:00.000Z"; expect((await publish(future, ADMIN)).status).toBe(400);
    const older = policy(3); older.issued_at = "2025-01-01T00:00:00.000Z"; expect((await publish(older, ADMIN)).status).toBe(400);
    expect((await publish({ ...policy(3), rules: { ...policy().rules, allow_dev: true } } as any, ADMIN)).status).toBe(400);
  });
  test("a log failure rolls back the version and it can be published after repair", async () => {
    await h.ctx.db.execute(sql`CREATE FUNCTION reject_host_policy_leaf() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind = 'host_policy' THEN RAISE EXCEPTION 'fixture log unavailable'; END IF; RETURN NEW; END $$`);
    await h.ctx.db.execute(sql`CREATE TRIGGER reject_host_policy_leaf BEFORE INSERT ON tlog_entries FOR EACH ROW EXECUTE FUNCTION reject_host_policy_leaf()`);
    await expect(publishHostPolicy(h.ctx, policy(3))).rejects.toThrow();
    expect(await h.ctx.db.select().from(hostPolicies).where(eq(hostPolicies.version, 3))).toHaveLength(0);
    await h.ctx.db.execute(sql`DROP TRIGGER reject_host_policy_leaf ON tlog_entries`);
    expect((await publish(policy(3), ADMIN)).status).toBe(200);
  });
});

test("off by default leaves public endpoints absent and publication disabled", async () => {
  const h = await startRouter({ env: { NETWORK_POLICY_ENABLED: "false" } });
  try {
    expect((await h.request("/api/v1/network/policy")).status).toBe(404);
    expect((await h.request("/trpc/network.publishPolicy", { method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, json: policy() })).status).toBe(412);
  } finally { await h.close(); }
});
