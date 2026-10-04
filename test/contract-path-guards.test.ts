import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { desc, eq } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { parse } from "yaml";
import { verifyDeployment, type ChainReader, type DeploymentManifest } from "../scripts/deployment-verification";
import { collectEvidence, lastMigration, writeEvidence } from "../scripts/release-evidence.ts";
import { recordEvents } from "../src/chain/indexer.ts";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/client.ts";
import { chainEvents, spentRoots } from "../src/db/schema.ts";
import { clearFairCache } from "../src/pay/paywith.ts";
import { readiness } from "../src/services/readiness.ts";
import { reconcileSpentRoots } from "../src/services/root-completeness.ts";
import { postSpentRoot } from "../src/services/settlement.ts";
import { fakeTx, startRouter, type Harness } from "./helpers.ts";

const root = resolve(import.meta.dir, "..");
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const VERIFIER_REVISION = "5".repeat(40);
const RELEASE = "6".repeat(40);
const SAFE_SINGLETON = a(80);

const manifest: DeploymentManifest = {
  schema: "anyroute.deployments/v1", mode: "production", chainId: 4663, blockNumber: 100,
  deployer: a(1), owner: a(1), pendingOwner: a(20),
  contracts: { usdg: a(30), anyrToken: a(45), credits: a(31), callPay: a(32), receiptAnchor: a(33), royalty: a(34), providerBond: a(35), payWithStock: a(37), stockOracle: a(38), paymaster: a(39), uniswapV4Adapter: a(40), uniswapV3Adapter: a(41), entryPoint: a(42), poolManager: a(43), swapRouter02: a(44), timelock: a(20), buybackAdapter: a(40) },
  roles: { ownerSafe: a(50), settlement: a(51), slasher: a(52), router: a(53), registrar: a(54), anchorer: a(55), keeper: a(56), paymasterSigner: a(58), refundPool: a(59), callPayTreasury: a(60), guardian: a(61), anyrRecipients: [a(62), a(63), a(64), a(65)] },
  params: { timelockMinDelay: 86400, paymasterDailyCap: "10000000000000000", paymasterDeposit: "20000000000000000", paymasterStake: "10000000000000000" },
  stockTokens: [{ address: a(70), feed: a(71), primaryAdapter: a(41), fallbackAdapter: a(0) }],
};

/** A chain whose state matches the manifest, so the real read-only verifier passes against it. */
function chainMatching(m: DeploymentManifest): ChainReader {
  const owned = ["credits", "callPay", "receiptAnchor", "royalty", "providerBond", "payWithStock", "stockOracle", "paymaster", "uniswapV4Adapter", "uniswapV3Adapter"];
  const timelockOwned = new Set(Object.entries(m.contracts).filter(([k]) => owned.includes(k)).map(([, v]) => v.toLowerCase()));
  const roles = m.roles as Record<string, Address>;
  const answers: Record<string, unknown> = {
    "pendingOwner()": a(0), "CONTROL_VERSION()": 2n, "settlement()": roles.settlement, "isCreditor(address)": true, "usdg()": m.contracts.usdg,
    "anyr()": m.contracts.anyrToken, "slasher()": roles.slasher, "refundPool()": roles.refundPool, "treasury()": roles.callPayTreasury, "anchorer()": roles.anchorer,
    "registrar()": roles.registrar, "keeper()": roles.keeper, "adapter()": m.contracts.buybackAdapter, "poolManager()": m.contracts.poolManager,
    "isCaller(address)": true, "tokens(address)": [true, m.stockTokens![0].primaryAdapter, m.stockTokens![0].fallbackAdapter], "masterCopy()": SAFE_SINGLETON,
    "oracle()": m.contracts.stockOracle, "verifyingSigner()": roles.paymasterSigner, "entryPoint()": m.contracts.entryPoint, "dailyCap()": BigInt(String(m.params.paymasterDailyCap)),
    "guardian()": roles.guardian, "getMinDelay()": 86400n, "getThreshold()": 2n, "getDepositInfo(address)": [20_000_000_000_000_000n, true, 10_000_000_000_000_000n, 86400, 0],
    "configOf(address)": [m.stockTokens![0].feed, 8, 302400, false, false],
  };
  return {
    async chainId() { return 4663; },
    async snapshot() { return { number: 123n, hash: `0x${"ab".repeat(32)}` as Hex }; },
    async code() { return "0x6001" as Hex; },
    async read(address, signature, args = []) {
      if (signature === "owner()") return timelockOwned.has(address.toLowerCase()) ? m.contracts.timelock : a(1);
      if (signature === "router()") return address.toLowerCase() === m.contracts.uniswapV3Adapter.toLowerCase() ? m.contracts.swapRouter02 : roles.router;
      if (signature === "getOwners()") return address.toLowerCase() === roles.ownerSafe.toLowerCase() ? [a(66), a(67), a(68)] : [a(73), a(74), a(75)];
      if (signature === "hasRole(bytes32,address)") {
        const [role, account] = args.map((v) => String(v).toLowerCase());
        if (role === `0x${"00".repeat(32)}`) return account === m.contracts.timelock.toLowerCase();
        return account !== m.deployer.toLowerCase() && account !== a(0);
      }
      if (signature in answers) return answers[signature];
      throw new Error(`unexpected read ${signature}`);
    },
  };
}

/** The verifier's own JSON output for a manifest, as scripts/verify-deployment.ts prints it. */
async function verifierReport(m: DeploymentManifest) {
  const report = await verifyDeployment(m, chainMatching(m), VERIFIER_REVISION, SAFE_SINGLETON, { sourceRevision: VERIFIER_REVISION, contracts: Object.fromEntries(Object.keys(m.contracts).map(name => [name, { object: "0x6001" as Hex, immutableReferences: {}, immutableValues: {} }])) });
  expect(report.ok).toBe(true);
  return JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

const prodApi = {
  ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0",
  APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3),
  PUBLIC_BASE_URL: "https://router.anyroute-fixture.com",
  DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test",
  REDIS_URL: "redis://:fixture-only-credential@localhost:6379",
  USDG_ADDRESS: manifest.contracts.usdg, CREDITS_ADDRESS: manifest.contracts.credits, CALLPAY_ADDRESS: manifest.contracts.callPay,
  PROVIDER_BOND_ADDRESS: manifest.contracts.providerBond, RECEIPT_ANCHOR_ADDRESS: manifest.contracts.receiptAnchor,
  ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64),
};
let report = "";
const verified = (overrides: Record<string, string> = {}) => ({ ...prodApi, RELEASE_COMMIT: RELEASE, DEPLOYMENT_MANIFEST: JSON.stringify(manifest), DEPLOYMENT_VERIFICATION: report, ...overrides });
beforeAll(async () => {
  report = await verifierReport(manifest);
});

describe("H-02: production contract mode starts only against a verified deployment", () => {
  test("refuses contract mode on a public origin without a manifest, its verifier report and the release commit", () => {
    expect(() => loadConfig(prodApi)).toThrow(/DEPLOYMENT_MANIFEST/);
    expect(() => loadConfig(verified({ DEPLOYMENT_VERIFICATION: "" }))).toThrow(/DEPLOYMENT_VERIFICATION/);
    expect(() => loadConfig(verified({ RELEASE_COMMIT: "" }))).toThrow(/RELEASE_COMMIT/);
    expect(() => loadConfig(verified({ RELEASE_COMMIT: RELEASE.slice(0, 12) }))).toThrow(/full git commit/);
  });

  test("accepts the manifest with the verifier's own passing report, inline or from files", () => {
    expect(loadConfig(verified()).release).toEqual({
      commit: RELEASE,
      deployment: { status: "verified", manifestSha256: sha256(JSON.stringify(manifest)), manifestBlock: 100, verifiedAtBlock: "123", verifierRevision: VERIFIER_REVISION },
    });
    const dir = mkdtempSync(join(tmpdir(), "anyroute-deployment-"));
    try {
      const text = JSON.stringify(manifest, null, 2) + "\n";
      writeFileSync(join(dir, "4663.json"), text);
      writeFileSync(join(dir, "4663.verification.json"), report);
      const cfg = loadConfig(verified({ DEPLOYMENT_MANIFEST: join(dir, "4663.json"), DEPLOYMENT_VERIFICATION: join(dir, "4663.verification.json") }));
      expect(cfg.release.deployment.manifestSha256).toBe(sha256(text));
      expect(() => loadConfig(verified({ DEPLOYMENT_MANIFEST: join(dir, "absent.json") }))).toThrow(/could not be read/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a manifest that does not describe exactly the configured production contracts", () => {
    const edited = (patch: Partial<DeploymentManifest>) => JSON.stringify({ ...manifest, ...patch });
    const cases: [Record<string, string>, RegExp][] = [
      [{ DEPLOYMENT_MANIFEST: edited({ schema: "anyroute.deployments/v0" }) }, /schema/],
      [{ DEPLOYMENT_MANIFEST: edited({ mode: "local" }) }, /production deployment/],
      [{ DEPLOYMENT_MANIFEST: edited({ chainId: 1 }) }, /chain 4663/],
      [{ DEPLOYMENT_MANIFEST: "{not json" }, /valid JSON/],
      [{ CREDITS_ADDRESS: a(99) }, /CREDITS_ADDRESS/],
      [{ USDG_ADDRESS: a(98) }, /USDG_ADDRESS/],
      [{ ROYALTY_ADDRESS: a(97) }, /ROYALTY_ADDRESS/],
      [{ CALLPAY_TREASURY: a(96) }, /CALLPAY_TREASURY/],
    ];
    for (const [change, reason] of cases) expect(() => loadConfig(verified(change))).toThrow(reason);
  });

  test("refuses a report that failed, is incomplete or certifies a different deployment", async () => {
    const r = JSON.parse(report);
    const variant = (patch: Record<string, unknown>) => JSON.stringify({ ...r, ...patch });
    const cases: [string, RegExp][] = [
      [variant({ ok: false }), /passing/],
      [variant({ checks: [...r.checks, { id: "fixture", status: "fail", evidence: null }] }), /passing/],
      [variant({ checks: [] }), /passing/],
      [variant({ checks: r.checks.map((c: any) => c.id === "contracts.source_equivalence" ? { ...c, status: "info" } : c) }), /runtime build/],
      [variant({ checks: r.checks.filter((c: any) => c.id !== "contracts.source_equivalence") }), /runtime build/],
      [variant({ verifierRevision: "fixture-revision" }), /revision/],
      [variant({ manifest: { ...r.manifest, blockNumber: 99 } }), /different manifest/],
      [variant({ observed: { ...r.observed, chainId: 1 } }), /this chain/],
      [variant({ observed: { ...r.observed, blockNumber: "99" } }), /deployment block/],
    ];
    for (const [bad, reason] of cases) expect(() => loadConfig(verified({ DEPLOYMENT_VERIFICATION: bad }))).toThrow(reason);
    // A genuine passing report for another deployment does not verify this manifest's contracts.
    const other = { ...manifest, contracts: { ...manifest.contracts, royalty: a(95) } };
    const otherReport = await verifierReport(other);
    expect(() => loadConfig(verified({ DEPLOYMENT_VERIFICATION: otherReport }))).toThrow(/royalty/);
  });

  test("reserved-TLD fixtures run unverified and say so; escrow and non-production modes are unaffected", () => {
    expect(loadConfig({ ...prodApi, PUBLIC_BASE_URL: "https://router.example" }).release.deployment.status).toBe("fixture");
    expect(loadConfig({ ...prodApi, PUBLIC_BASE_URL: "https://router.fixture.invalid" }).release.deployment.status).toBe("fixture");
    expect(() => loadConfig({ ...prodApi, PUBLIC_BASE_URL: "https://example.com" })).toThrow(/DEPLOYMENT_MANIFEST/);
    const { CREDITS_ADDRESS, CALLPAY_ADDRESS, PROVIDER_BOND_ADDRESS, RECEIPT_ANCHOR_ADDRESS, ROUTER_PRIVATE_KEY, ...noContracts } = prodApi;
    const escrow = loadConfig({ ...noContracts, PAYMENTS_MODE: "escrow", ESCROW_ADDRESS: a(77), ESCROW_START_BLOCK: "1", ESCROW_TOKENS: JSON.stringify([{ symbol: "NVDA", address: a(70), decimals: 18, feed: a(71) }]) });
    expect(escrow.release).toEqual({ commit: null, deployment: { status: "none", manifestSha256: null, manifestBlock: null, verifiedAtBlock: null, verifierRevision: null } });
    expect(loadConfig({ ANYROUTE_ENV: "test", CREDITS_ADDRESS: a(31) }).release.deployment.status).toBe("unverified");
    expect(() => loadConfig({ ANYROUTE_ENV: "test", RELEASE_COMMIT: "not-a-commit" })).toThrow(/RELEASE_COMMIT/);
  });
});

describe("M-06: PayWithStock delegation is explicit and bounded", () => {
  const paywith = { PAYWITHSTOCK_ADDRESS: manifest.contracts.payWithStock, PAYWITH_DELEGATION_ACCEPTED: "true", PAYWITH_MAX_DAILY_CAP_USD: "20" };

  test("production refuses PayWithStock without an explicit acceptance or above the ceilings", () => {
    expect(loadConfig(verified(paywith)).paywith.maxDailyCapUsd).toBe(20);
    const cases: [Record<string, string>, RegExp][] = [
      [{ PAYWITH_DELEGATION_ACCEPTED: "false" }, /PAYWITH_DELEGATION_ACCEPTED/],
      [{ PAYWITH_MAX_DEBT_USD: "6" }, /PAYWITH_MAX_DEBT_USD/],
      [{ PAYWITH_MAX_DEBT_USD: "0" }, /PAYWITH_MAX_DEBT_USD/],
      [{ PAYWITH_MAX_DAILY_CAP_USD: "" }, /PAYWITH_MAX_DAILY_CAP_USD/],
      [{ PAYWITH_MAX_DAILY_CAP_USD: "26" }, /PAYWITH_MAX_DAILY_CAP_USD/],
      [{ PAYWITH_MAX_DAILY_CAP_USD: "2" }, /PAYWITH_MAX_DAILY_CAP_USD/],
      [{ PAYWITH_MAX_DAILY_CAP_USD: "many" }, /positive/],
      [{ PAYWITHSTOCK_ADDRESS: a(94) }, /PAYWITHSTOCK_ADDRESS/],
    ];
    for (const [change, reason] of cases) expect(() => loadConfig(verified({ ...paywith, ...change }))).toThrow(reason);
    expect(loadConfig({ ANYROUTE_ENV: "test" }).paywith.maxDailyCapUsd).toBeNull();
  });

  test("the API builds no session whose daily cap is worth more than PAYWITH_MAX_DAILY_CAP_USD", async () => {
    const h = await startRouter({ env: { PAYWITH_MAX_DAILY_CAP_USD: "20" } });
    try {
      clearFairCache();
      const k = await h.newKey();
      const open = (raw: bigint) => h.request("/api/v1/paywith/open", { method: "POST", headers: k.auth, json: { token: "NVDA", cap_raw_per_day: raw.toString(), wallet: a(0x2222) } });
      // The fake chain prices NVDA at $225.
      const tooHigh = await open(10n ** 18n);
      expect(tooHigh.status).toBe(400);
      expect((await tooHigh.json()).error.type).toBe("cap_too_high");
      expect((await open(8n * 10n ** 16n)).status).toBe(200); // 0.08 NVDA = $18 a day
      h.chain.fair18 = null;
      clearFairCache();
      expect((await open(10n ** 16n)).status).toBe(503);
    } finally {
      clearFairCache();
      await h.close();
    }
  });
});

describe("M-04: spent roots cover every funded key", () => {
  let h: Harness;
  const graceMs = 50 * 3_600_000;
  const reconcile = (now?: Date) => reconcileSpentRoots(h.ctx.db, { graceMs, verifyMerkle: true, now });
  const latestRoot = async () => (await h.ctx.db.select().from(spentRoots).orderBy(desc(spentRoots.epoch)).limit(1))[0];
  const fundUnregistered = async (keyHash: string, createdAt: Date) => {
    const txHash = fakeTx();
    await recordEvents(h.ctx, [{ contract: "credits", event: "Deposited", args: { keyHash, from: a(0xabc), amount: 5_000_000n }, txHash, logIndex: 0, blockNumber: 70n }]);
    await h.ctx.db.update(chainEvents).set({ createdAt }).where(eq(chainEvents.txHash, txHash));
    return txHash;
  };
  beforeAll(async () => {
    h = await startRouter();
  });
  afterAll(async () => h.close());

  test("funded keys wait for the next root within the grace period, then fail", async () => {
    await h.fundedKey();
    await h.fundedKey();
    const before = await reconcile();
    expect(before).toMatchObject({ ok: true, root: null, funded_keys: 2, covered_keys: 0 });
    expect(before.pending_keys).toHaveLength(2);
    const late = await reconcile(new Date(Date.now() + graceMs + 3_600_000));
    expect(late.ok).toBe(false);
    expect(late.overdue_keys).toHaveLength(2);
  });

  test("a posted root covers every funded key and reconciles with the ledger", async () => {
    expect(await postSpentRoot(h.ctx)).toMatchObject({ posted: true });
    const r = await reconcile();
    expect(r.failures).toEqual([]);
    expect(r).toMatchObject({ ok: true, funded_keys: 2, covered_keys: 2 });
    expect(r.root?.merkle_matches).toBe(true);
    expect(r.totals).toMatchObject({ total_matches: true, funded_usdg: "20000000", processed_without_credit: 0, credit_amount_mismatches: 0, credits_without_event: 0 });
    expect((await readiness(h.ctx)).checks.root_completeness).toBe(true);
  });

  test("a key funded before the root but missing from it fails readiness; a later one is pending", async () => {
    const root = await latestRoot();
    const omitted = "0x" + "e1".repeat(32);
    const tx = await fundUnregistered(omitted, new Date(root.createdAt.getTime() - 3_600_000));
    try {
      const r = await reconcile();
      expect(r.ok).toBe(false);
      expect(r.missing_keys).toEqual([omitted]);
      expect((await readiness(h.ctx)).checks.root_completeness).toBe(false);
      await h.ctx.db.update(chainEvents).set({ createdAt: new Date(root.createdAt.getTime() + 60_000) }).where(eq(chainEvents.txHash, tx));
      expect((await reconcile()).pending_keys).toEqual([omitted]);
      expect((await reconcile()).ok).toBe(true);
      expect((await reconcile(new Date(Date.now() + graceMs + 3_600_000))).overdue_keys).toEqual([omitted]);
    } finally {
      await h.ctx.db.delete(chainEvents).where(eq(chainEvents.txHash, tx));
    }
  });

  test("an overspent leaf, a wrong total or edited leaves fail", async () => {
    const root = await latestRoot();
    const leaves = root.leaves as [string, string][];
    try {
      await h.ctx.db.update(spentRoots).set({ leaves: [[leaves[0][0], "999000000"], ...leaves.slice(1)] }).where(eq(spentRoots.epoch, root.epoch));
      const overspent = await reconcile();
      expect(overspent.ok).toBe(false);
      expect(overspent.overspent_keys).toEqual([{ key_hash: leaves[0][0].toLowerCase(), spent_usdg: "999000000", net_funded_usdg: "10000000" }]);
      expect(overspent.root?.merkle_matches).toBe(false);
      await h.ctx.db.update(spentRoots).set({ leaves, totalSpentUsdg: 7n }).where(eq(spentRoots.epoch, root.epoch));
      const wrongTotal = await reconcile();
      expect(wrongTotal.totals.total_matches).toBe(false);
      expect(wrongTotal.root?.merkle_matches).toBe(true);
    } finally {
      await h.ctx.db.update(spentRoots).set({ leaves, totalSpentUsdg: root.totalSpentUsdg }).where(eq(spentRoots.epoch, root.epoch));
    }
    expect((await reconcile()).ok).toBe(true);
  });

  test("a processed funding event without its ledger credit fails", async () => {
    const [[covered]] = (await latestRoot()).leaves as [string, string][];
    const txHash = fakeTx();
    await h.ctx.db.insert(chainEvents).values({ txHash, logIndex: 0, contract: "credits", event: "Deposited", blockNumber: 71n, args: { keyHash: covered, from: a(1), amount: "1000000" }, processed: true });
    try {
      const r = await reconcile();
      expect(r.ok).toBe(false);
      expect(r.totals.processed_without_credit).toBe(1);
    } finally {
      await h.ctx.db.delete(chainEvents).where(eq(chainEvents.txHash, txHash));
    }
  });

  test("root_completeness is checked only in contract mode, and alerts when it fails", async () => {
    const mode = h.ctx.cfg.escrow.mode;
    h.ctx.cfg.escrow.mode = "escrow";
    try {
      expect((await readiness(h.ctx)).checks).not.toHaveProperty("root_completeness");
    } finally {
      h.ctx.cfg.escrow.mode = mode;
    }
    const rules = (parse(readFileSync(resolve(root, "monitoring/alerts.yml"), "utf8")) as { groups: { rules: { alert: string; expr: string; labels: Record<string, string> }[] }[] }).groups.flatMap((g) => g.rules);
    const rule = rules.find((r) => r.alert === "AnyRouteSpentRootIncomplete");
    expect(rule?.expr).toBe('anyroute_readiness_check{job="anyroute",check="root_completeness"} == 0');
    expect(rule?.labels.severity).toBe("critical");
  });

  test("scripts/reconcile-roots.ts exits 1 for an uncovered funded key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anyroute-roots-"));
    try {
      const url = `pglite://${join(dir, "db")}`;
      const db = await openDatabase(url);
      await db.db.insert(chainEvents).values({ txHash: fakeTx(), logIndex: 0, contract: "credits", event: "Deposited", blockNumber: 1n, args: { keyHash: "0x" + "e2".repeat(32), from: a(1), amount: "1000000" }, createdAt: new Date(Date.now() - 30 * 86_400_000) });
      await db.close();
      const run = Bun.spawnSync(["bun", "scripts/reconcile-roots.ts"], { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdout: "pipe", stderr: "pipe" });
      expect(run.exitCode).toBe(1);
      const out = JSON.parse(run.stdout.toString());
      expect(out).toMatchObject({ ok: false, funded_keys: 1, overdue_keys: ["0x" + "e2".repeat(32)] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("H-06: release evidence", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ env: { RELEASE_COMMIT: RELEASE } });
  });
  afterAll(async () => h.close());
  const viaApp = (url: string, init?: RequestInit) => {
    const u = new URL(url);
    return Promise.resolve(h.app.request(u.pathname + u.search, init));
  };

  test("public status names the running commit", async () => {
    const status = (await (await h.request("/api/v1/status")).json()).data;
    expect(status.release).toEqual({ commit: RELEASE, deployment: { status: "none", manifest_sha256: null, manifest_block: null, verified_at_block: null, verifier_revision: null } });
  });

  test("the collector records health, readiness, status, headers and migration, then writes the bundle and its SHA-256", async () => {
    const bundle = await collectEvidence("http://127.0.0.1:8787", { fetch: viaApp, expectCommit: RELEASE.slice(0, 12) });
    expect(bundle.release).toMatchObject({ live_commit: RELEASE, expected_commit: RELEASE.slice(0, 12), live_matches_expected: true });
    expect(bundle.health).toMatchObject({ status: 200, body: { ok: true } });
    expect(bundle.readiness.checks).toHaveProperty("database");
    expect(bundle.readiness_metrics.reachable).toBe(true);
    expect(bundle.status).not.toHaveProperty("launch");
    expect(JSON.stringify(bundle.status)).not.toContain("public_rpc");
    expect(bundle.catalog.models).toBeGreaterThan(0);
    expect(bundle.security_headers.map((x) => x.path)).toEqual(["/", "/docs/", "/dashboard/"]);
    expect(bundle.security_headers[0]).toMatchObject({ x_content_type_options: "nosniff", x_frame_options: "DENY", referrer_policy: "no-referrer" });
    // A non-production app sends no HSTS, and the evidence says so.
    expect(bundle.findings.some((f) => f.id === "headers/.hsts_missing")).toBe(true);
    expect(bundle.findings.some((f) => f.id === "ready" && f.severity === "high")).toBe(true);
    expect(bundle.migrations).toEqual(lastMigration());
    expect(bundle.migrations.hash).toBe(sha256(readFileSync(resolve(root, `drizzle/${bundle.migrations.tag}.sql`), "utf8")));

    const dir = mkdtempSync(join(tmpdir(), "anyroute-evidence-"));
    try {
      const { path, sha256: digest } = writeEvidence(bundle, dir);
      expect(sha256(readFileSync(path, "utf8"))).toBe(digest);
      expect(readFileSync(`${path}.sha256`, "utf8")).toBe(`${digest}  ${basename(path)}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const mismatch = await collectEvidence("http://127.0.0.1:8787", { fetch: viaApp, expectCommit: "deadbeef" });
    expect(mismatch.findings.find((f) => f.id === "release.commit_mismatch")?.severity).toBe("high");
    await expect(collectEvidence("http://router.example")).rejects.toThrow(/https/);
  });

  test("evidence output stays out of git", () => {
    const check = Bun.spawnSync(["git", "check-ignore", "-q", "release-evidence/bundle.json"], { cwd: root });
    expect(check.exitCode).toBe(0);
  });
});

