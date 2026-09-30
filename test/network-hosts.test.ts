import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { providers, sanctionsAddresses, sanctionsMeta } from "../src/db/schema.ts";
import { loadConfig } from "../src/config.ts";
import { canonicalJson, decrypt, sha256 } from "../src/lib/util.ts";
import { attestProvider } from "../src/services/attestor.ts";
import { onKeyPublished } from "../src/tlog/hooks.ts";
import { MemoryRateLimiter } from "../src/lib/ratelimit.ts";
import { admissionReasons } from "../src/network/admit.ts";
import { publishHostPolicy } from "../src/network/publication.ts";
import type { HostPolicy, HostPolicyBindings } from "../src/network/policy.ts";
import { formatSignerKey, noteSigner, SIG_COSIGNATURE_V1 } from "../src/tlog/note.ts";
import { createTlsIdentity, generateTlsKey } from "../sidecar/src/tls.ts";
import { bindingsObject, reportDataHex, type Bindings } from "../sidecar/src/reportdata.ts";
import { bindingsFor, DIGESTS, REGS, tdxQuote } from "./measurement-fixtures.ts";
import { startRouter, type Harness } from "./helpers.ts";

const digest = `sha256:${"44".repeat(32)}`;
const policy: HostPolicy = { version: 1, issued_at: "2026-01-01T00:00:00.000Z", tee_kinds: ["tdx"], sidecar: { image_digests: [DIGESTS.image], source_hashes: [digest] }, engines: [{ name: "engine", image_digest: digest }], models: [{ id: "cpu", model_digest: DIGESTS.model, min_gpu_cc: false }], rules: { require_gpu_cc_for: [], allow_dev: false } };
const env = { NETWORK_HOSTS_ENABLED: "true", NETWORK_POLICY_ENABLED: "true", TLOG_ENABLED: "true" };

describe("wallet-authenticated host admission with the existing attestor", () => {
  let h: Harness;
  let sidecar: ReturnType<typeof Bun.serve>;
  let verifier: ReturnType<typeof Bun.serve>;
  let offPolicySidecar: ReturnType<typeof Bun.serve>;
  let offPolicyEndpoint: string;
  let mode = "pass";
  let quoteCalls = 0;
  let wallet = privateKeyToAccount(generatePrivateKey());
  let endpoint: string;
  const otherWallet = privateKeyToAccount(generatePrivateKey());
  const body = (extra = {}) => ({ name: "CPU host", endpoint: mode === "off-policy" ? offPolicyEndpoint : endpoint, payout_address: wallet.address, models: ["cpu"], ...extra });
  async function signed(path: string, data: unknown, method = "POST", account = wallet) {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = await account.signMessage({ message: `anyroute:${ts}:${sha256(canonicalJson(data))}` });
    return h.request(path, { method, headers: { "X-Wallet-Auth": `${account.address}:${ts}:${signature}` }, json: data });
  }
  const apply = (extra = {}) => signed("/api/v1/network/hosts", body(extra));

  beforeAll(async () => {
    function createSidecar(offPolicy: boolean) {
      const key = generateTlsKey();
      const bindings: Bindings = { tlsPubkey: key.spkiDer.toString("hex"), receiptPubkey: bindingsFor().receipt_pubkey, imageDigest: DIGESTS.image, composeHash: DIGESTS.compose, modelDigest: DIGESTS.model,
        v2: { v: 2, source_hash: offPolicy ? `sha256:${"55".repeat(32)}` : digest, engine: { name: "engine", image_digest: digest }, model: { id: "cpu", digest: DIGESTS.model } } };
      const document = (nonce: string, dev = false, tamper = false) => {
        const committed = reportDataHex(bindings, Buffer.from(nonce, "hex"));
        const reportData = tamper ? "00".repeat(32) + committed.slice(64) : committed;
        return { v: 1, type: "anyroute.sidecar.attestation", dev, bindings: bindingsObject(bindings),
          evidence: { kind: "dstack", dev, format: "tdx-quote-v4", quote: tdxQuote(reportData), report_data: reportData, event_log: null, measurements: { mrtd: REGS.mrtd }, nonce } };
      };
      const zero = "00".repeat(32);
      const boot = document(zero);
      const ref = sha256(Buffer.from(boot.evidence.quote, "hex"));
      const tls = createTlsIdentity(key.privateKey, { attestationRef: ref, hostnames: ["localhost"] });
      return Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: tls.keyPem, cert: tls.certPem }, fetch(req) {
        quoteCalls++;
        const nonce = new URL(req.url).searchParams.get("nonce");
        return Response.json({ ...(nonce ? document(nonce, mode === "dev", mode === "tamper") : boot), attestation_ref: ref });
      } });
    }
    sidecar = createSidecar(false); offPolicySidecar = createSidecar(true);
    endpoint = `https://127.0.0.1:${sidecar.port}`; offPolicyEndpoint = `https://127.0.0.1:${offPolicySidecar.port}`;
    verifier = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ verified: mode !== "verifier-refusal" }) });
    h = await startRouter({ providers: [], env: { ...env, TDX_VERIFIER_URL: `http://127.0.0.1:${verifier.port}` } });
    await publishHostPolicy(h.ctx, policy);
  });
  afterAll(async () => { await h.close(); sidecar.stop(true); offPolicySidecar.stop(true); verifier.stop(true); });
  beforeEach(async () => {
    mode = "pass"; wallet = privateKeyToAccount(generatePrivateKey()); quoteCalls = 0;
    h.ctx.cfg.sanctions.enabled = false;
    await h.ctx.limiter.close(); h.ctx.limiter = new MemoryRateLimiter();
  });

  test("pass creates probation, an honest fresh status and a nonroutable sidecar row", async () => {
    const entries: string[] = []; onKeyPublished(h.ctx.db, kind => entries.push(kind));
    const response = await apply(); expect(response.status).toBe(201);
    onKeyPublished(h.ctx.db, null); expect(entries).toContain("attestation_binding");
    const result = await response.json(); expect(result).toMatchObject({ status: "probation", reasons: [] });
    expect(quoteCalls).toBeGreaterThanOrEqual(2);
    const [row] = await h.ctx.db.select().from(providers).where(eq(providers.id, result.provider_id));
    expect(row).toMatchObject({ status: "probation", networkHost: true, kind: "sidecar", operator: wallet.address.toLowerCase(), payoutMode: "usdg", payoutAddress: wallet.address.toLowerCase(), apiKeyEnc: null, attested: true, baseUrl: `${endpoint}/v1`, networkModels: ["cpu"], staticModels: null });
    expect(row.shadowUntil!.getTime() - Date.now()).toBeGreaterThan(6.99 * 86_400_000);
    const status = await h.request(`/api/v1/network/hosts/${row.id}/status`);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await status.json()).toEqual({ provider_id: row.id, status: "probation", reasons: [], attested: true, probation_until: row.shadowUntil!.toISOString(), weight: 0 });
    expect(result.dashboard).toBe(`/hosts/?id=${row.id}`);
    const scheduledResult = await attestProvider(h.ctx, { ...row, status: "shadow" });
    expect(scheduledResult).not.toHaveProperty("networkEvidence");
  });
  for (const [scenario, reason] of [["dev", "hardware TDX quote"], ["off-policy", "source hash is missing or off-policy"], ["tamper", "not committed"], ["verifier-refusal", "Attestation failed"]]) test(`${scenario} is refused with a precise reason`, async () => {
    mode = scenario;
    const response = await apply(); expect(response.status).toBe(201);
    const result = await response.json(); expect(result.status).toBe("rejected"); expect(result.reasons.join(" ")).toContain(reason);
  });
  test("requested models must be committed, rather than merely approved in a policy", async () => {
    const result = await (await apply({ models: ["not-committed"] })).json();
    expect(result.status).toBe("rejected"); expect(result.reasons.join(" ")).toContain("Requested model not-committed is not bound");
  });
  test("HTTP is rejected without a quote fetch; unreachable HTTPS records the transport refusal", async () => {
    const http = await (await apply({ endpoint: "http://127.0.0.1:1" })).json();
    expect(http).toMatchObject({ status: "rejected", reasons: ["The sidecar endpoint must use HTTPS."] }); expect(quoteCalls).toBe(0);
    const unreachable = await (await apply({ endpoint: "https://127.0.0.1:1" })).json();
    expect(unreachable.status).toBe("rejected"); expect(unreachable.reasons.join(" ")).toContain("unreachable");
  });
  test("sanctioned payout and operator wallets are refused after attestation", async () => {
    h.ctx.cfg.sanctions.enabled = true;
    await h.ctx.db.delete(sanctionsAddresses); await h.ctx.db.delete(sanctionsMeta);
    await h.ctx.db.insert(sanctionsMeta).values({ id: 1, listDate: new Date(), sourceHash: "fixture", entryCount: 1, ignoredCount: 0, refreshedAt: new Date() });
    await h.ctx.db.insert(sanctionsAddresses).values({ address: otherWallet.address.toLowerCase(), listDate: new Date(), sourceHash: "fixture" });
    const payout = await (await apply({ payout_address: otherWallet.address })).json();
    expect(payout.status).toBe("rejected"); expect(payout.reasons.join(" ")).toContain("Payout screening: Payout address is on the public OFAC SDN list."); expect(quoteCalls).toBeGreaterThan(0);
    const operator = await (await signed("/api/v1/network/hosts", body(), "POST", otherWallet)).json();
    expect(operator.reasons.join(" ")).toContain("Operator screening:");
  });
  test("missing sanctions list fails closed", async () => {
    h.ctx.cfg.sanctions.enabled = true; await h.ctx.db.delete(sanctionsMeta);
    const result = await (await apply()).json(); expect(result.status).toBe("rejected"); expect(result.reasons.join(" ")).toContain("A current sanctions list is required");
  });
  test("re-apply updates the same row, rechecks evidence and preserves only the encrypted credential", async () => {
    const first = await (await apply()).json();
    const api_key = randomBytes(32).toString("hex");
    const data = { provider_id: first.provider_id, api_key };
    expect((await signed(`/api/v1/network/hosts/${first.provider_id}/credential`, data, "PUT", otherWallet)).status).toBe(404);
    expect((await signed(`/api/v1/network/hosts/${first.provider_id}/credential`, data, "PUT")).status).toBe(200);
    mode = "verifier-refusal";
    const second = await apply({ name: "Changed host", contact: "operator contact" }); expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ provider_id: first.provider_id, status: "rejected" });
    const rows = await h.ctx.db.select().from(providers).where(eq(providers.operator, wallet.address.toLowerCase()));
    expect(rows).toHaveLength(1); expect(rows[0].name).toBe("Changed host"); expect(rows[0].apiKeyEnc).not.toContain(api_key);
    expect(decrypt(h.ctx.cfg.appSecret, rows[0].apiKeyEnc!)).toBe(api_key);
  });
  test("wallet auth, replay protection, bounded fields and signed credential scope are enforced", async () => {
    expect((await h.request("/api/v1/network/hosts", { method: "POST", json: body() })).status).toBe(401);
    expect((await h.request("/api/v1/network/hosts", { method: "POST", headers: { "X-Wallet-Auth": "invalid" }, json: body() })).status).toBe(401);
    const first = await (await apply()).json(); expect((await apply()).status).toBe(401);
    expect((await signed(`/api/v1/network/hosts/${first.provider_id}/credential`, { provider_id: "another-host", api_key: "a".repeat(32) }, "PUT")).status).toBe(400);
    expect((await apply({ name: "x".repeat(61) })).status).toBe(400);
    expect((await h.request("/api/v1/network/hosts/missing/status")).status).toBe(404);
  });
  test("limits signup independently by wallet and network address", async () => {
    for (let i = 0; i < 3; i++) expect((await apply({ endpoint: "http://127.0.0.1:1", name: `Host ${i}` })).status).toBe(i === 0 ? 201 : 200);
    expect((await apply({ endpoint: "http://127.0.0.1:1", name: "Fourth" })).status).toBe(429);
    await h.ctx.limiter.close(); h.ctx.limiter = new MemoryRateLimiter();
    for (let i = 0; i < 10; i++) { wallet = privateKeyToAccount(generatePrivateKey()); expect((await apply({ endpoint: "http://127.0.0.1:1" })).status).toBe(201); }
    wallet = privateKeyToAccount(generatePrivateKey()); expect((await apply()).status).toBe(429);
  });
});

test("disabled flag leaves routes absent, no provider writes and curated application path available", async () => {
  const h = await startRouter({ providers: [], env: { NETWORK_HOSTS_ENABLED: "false" } });
  try {
    for (const [path, method] of [["/api/v1/network/hosts", "POST"], ["/api/v1/network/hosts/id/status", "GET"], ["/api/v1/network/hosts/id/credential", "PUT"]]) expect((await h.request(path, { method, ...(method !== "GET" ? { json: {} } : {}) })).status).toBe(404);
    expect(await h.ctx.db.select().from(providers)).toHaveLength(0);
    expect((await h.request("/api/v1/providers/apply", { method: "POST", json: {} })).status).toBe(400);
  } finally { await h.close(); }
});

test("development evidence cannot pass policy even when development attestation is allowed", () => {
  const evidence: HostPolicyBindings = { tee_kind: "tdx", hardware_verified: true, bindings_committed: true, simulated: true, bindings: { ...bindingsFor(), source_hash: digest, engines: [{ name: "engine", image_digest: digest }], model_id: "cpu" } };
  expect(admissionReasons(evidence, policy, ["cpu"])).toContain("Development evidence is never accepted for a network host.");
  expect(admissionReasons({ ...evidence, simulated: false, bindings: { ...evidence.bindings, models: "invalid" } } as unknown as HostPolicyBindings, policy, ["cpu"])).toEqual(["The verified host bindings are invalid or missing."]);
});

test("real production config loader starts with signup on and preserves prerequisites and independent-log guards", () => {
  const address = "0x" + "1".repeat(40);
  const witnesses = [1, 2].map(i => noteSigner(`w${i}.example/w`, SIG_COSIGNATURE_V1, randomBytes(32)).verifierKey).join(",");
  const production = { NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/fixture", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "2".repeat(64), ALLOW_DEV_ATTESTATION: "false", ...env, TLOG_ORIGIN: "router.example/tlog", TLOG_SIGNING_KEY: formatSignerKey("router.example/tlog", randomBytes(32)), TLOG_WITNESSES: witnesses, ATTESTATION_VERIFIERS: "phala" };
  const config = loadConfig(production); expect(config.production).toBe(true); expect(config.networkHosts).toEqual({ enabled: true, probationDays: 7 });
  expect(() => loadConfig({ ...production, NETWORK_POLICY_ENABLED: "false" })).toThrow("requires NETWORK_POLICY_ENABLED");
  expect(() => loadConfig({ ...production, REDIS_URL: "" })).toThrow("authenticated Redis");
  expect(() => loadConfig({ ...production, ATTESTATION_VERIFIERS: "dcap", TDX_VERIFIER_URL: "" })).toThrow("HTTPS TDX_VERIFIER_URL");
  expect(() => loadConfig({ ...production, TLOG_WITNESSES: "" })).toThrow("independent check");
  expect(() => loadConfig({ ...production, ALLOW_DEV_ATTESTATION: "true" })).toThrow("ALLOW_DEV_ATTESTATION");
  expect(loadConfig({ NETWORK_HOSTS_ENABLED: "false" }).networkHosts).toEqual({ enabled: false, probationDays: 7 });
});
