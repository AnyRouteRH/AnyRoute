import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/app.ts";
import { attestations, providers } from "../src/db/schema.ts";
import { guardHostSlasher } from "../src/network/bond-config.ts";
import { pollHostBonds, type BondIndexChain, type IndexedBondLog } from "../src/network/bond-indexer.ts";
import { bondHostId, bondScope } from "../src/network/bond-state.ts";
import { hostBondCursor, hostBondEvents, hostSlashEvidence } from "../src/network/bond-schema.ts";
import { readRoutingBond } from "../src/network/bonds.ts";
import { networkWeight, type NetworkWeightInput } from "../src/network/weight.ts";
import { runHostSlasher, storeSlashEvidence, type SlashTransport, type SlashBundle } from "../src/network/slashing.ts";
import { privateKeyToAccount } from "viem/accounts";
const address = `0x${"1".repeat(40)}` as Hex;
const key = `0x${"3".repeat(64)}` as Hex;
const operator = privateKeyToAccount(key).address.toLowerCase();
const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const id = "bonded-host";
const hostId = bondHostId(id);
let app: Awaited<ReturnType<typeof createApp>>;
let logs: IndexedBondLog[] = [];
let head = 5n;
const hashes = new Map<bigint, string>();
const event = (block: number, event: string, args: Record<string, unknown>): IndexedBondLog => ({ event, args, block: BigInt(block), txHash: hex(100 + block), blockHash: hex(block), logIndex: 0 });
const chain: BondIndexChain = { tip: async () => ({ head, final: head }), hash: async n => hashes.get(n) ?? hex(Number(n)), logs: async (a, b) => logs.filter(l => l.block >= a && l.block <= b) };
beforeAll(async () => {
  app = await createApp({ startJobs: false, env: { ANYROUTE_ENV: "test", DATABASE_URL: "pglite://memory", NETWORK_BONDS_ENABLED: true, HOST_BOND_ADDRESS: address, HOST_BOND_START_BLOCK: "1", CHAIN_CONFIRMATIONS: "1", HOST_DASHBOARD_ENABLED: true } });
  await app.ctx.db.insert(providers).values({ id, name: "Bond host", baseUrl: "https://host.example", networkHost: true, operator, status: "live", teeKind: "tdx", attested: true, attestationHash: hex(40), attestedAt: new Date() });
  await app.ctx.db.insert(attestations).values({ providerId: id, ok: true, teeKind: "tdx" });
});
afterAll(async () => app?.close());
test("disabled flags preserve routing and expose no bond endpoint or host field", async () => {
  const off = await createApp({ startJobs: false, env: { ANYROUTE_ENV: "test", DATABASE_URL: "pglite://memory" } });
  try {
    expect(off.ctx.cfg.hostBonds.enabled).toBe(false); expect(off.ctx.cfg.hostBonds.slashing).toBe(false);
    expect(await pollHostBonds(off.ctx, { tip: async () => { throw Error("must not access chain"); } } as BondIndexChain)).toEqual({ skipped: "disabled" });
    expect(await runHostSlasher(off.ctx)).toEqual({ skipped: "disabled" });
    expect((await off.app.request("/api/v1/network/bonds")).status).toBe(404);
  } finally { await off.close(); }
});
test("bounded weight, neutral zero/off, health exclusion and probation cap", () => {
  const settings = { enabled: true, probationDays: 7, graduateRequests: 200, graduateUptime: 0.99, bonds: { enabled: true, fullUsdg: 5_000, scope: "fixture" } };
  const input: NetworkWeightInput = { networkHost: true, attested: true, unhealthy: false, probationUntil: 1, now: 2, attestedSuccesses: 200, recentSuccesses: 200, recentFailures: 0, probeSuccesses: 100, probeFailures: 0 };
  expect(networkWeight(input, settings)).toBe(1);
  expect(networkWeight({ ...input, bond: 2_500_000_000n }, settings)).toBe(1.25);
  for (const bond of [5_000_000_000n, 10n ** 75n]) expect(networkWeight({ ...input, bond }, settings)).toBe(1.5);
  expect(networkWeight({ ...input, bond: 5_000_000_000n, bondCheckedAt: 0, now: 120_001 }, settings)).toBe(1);
  expect(networkWeight({ ...input, bond: 5_000_000_000n, bondCheckedAt: 3 }, settings)).toBe(1);
  expect(networkWeight({ ...input, bond: -1n }, settings)).toBe(1);
  expect(networkWeight({ ...input, probationUntil: 5, bond: 5_000_000_000n }, settings)).toBeCloseTo(0.15);
  expect(networkWeight({ ...input, bond: 5_000_000_000n, unhealthy: true }, settings)).toBe(0);
  expect(networkWeight({ ...input, bond: 5_000_000_000n }, { ...settings, bonds: { ...settings.bonds, enabled: false } })).toBe(1);
  expect(networkWeight({ ...input, networkHost: false, bond: 5_000_000_000n }, settings)).toBe(1);
});
test("production loader starts with bond indexing and isolated host slasher, guard refuses mismatch", async () => {
  const env = { NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "worker", AUTO_MIGRATE: false, HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, NETWORK_BONDS_ENABLED: true, HOST_BOND_ADDRESS: address, WORKER_JOBS: "host-bond-indexer" };
  expect(loadConfig(env).hostBonds.enabled).toBe(true);
  const live = loadConfig({ ...env, WORKER_JOBS: "host-slasher", NETWORK_SLASHING_ENABLED: true, SLASHER_PRIVATE_KEY: key });
  await guardHostSlasher(live, async () => operator);
  await expect(guardHostSlasher(live, async () => address)).rejects.toThrow("does not equal");
  expect(() => loadConfig({ ...env, NETWORK_SLASHING_ENABLED: true })).toThrow();
  expect(() => loadConfig({ ...env, WORKER_JOBS: "host-slasher", NETWORK_SLASHING_ENABLED: true })).toThrow();
  expect(() => loadConfig({ ...env, RUNTIME_ROLE: "api", NETWORK_SLASHING_ENABLED: true, SLASHER_PRIVATE_KEY: key })).toThrow();
});
test("resumable journal, active bond, operator/host isolation, history/API and reorg replay", async () => {
  logs = [event(1, "MinBondSet", { minBond: "5000000000" }), event(2, "Bonded", { hostId, operator, amount: "10000000000", total: "10000000000" }), event(3, "UnbondRequested", { hostId, amount: "5000000000", availableAt: "2000000000" })];
  expect(await pollHostBonds(app.ctx, chain, 2n, 1)).toMatchObject({ block: "2", caught_up: false });
  const settings = { enabled: true, fullUsdg: 5_000, scope: bondScope(app.ctx.cfg) };
  expect(await readRoutingBond(app.ctx.db, { id, operator }, settings)).toBe(0n);
  await pollHostBonds(app.ctx, chain, 2n);
  expect(await readRoutingBond(app.ctx.db, { id, operator }, settings)).toBe(5_000_000_000n);
  expect(await readRoutingBond(app.ctx.db, { id: "other-host", operator }, settings)).toBe(0n);
  expect(await readRoutingBond(app.ctx.db, { id, operator: address }, settings)).toBe(0n);
  const res = await (await app.app.request(`/api/v1/hosts/${id}`)).json();
  expect(res.data.bond).toMatchObject({ amount_units: "10000000000", active_units: "5000000000", matched_operator: true, fresh: true, unbonding: { amount_units: "5000000000" } });
  expect((await (await app.app.request("/api/v1/network/bonds")).json()).data.total_units).toBe("10000000000");
  expect((await pollHostBonds(app.ctx, chain)).recorded).toBe(0);
  // Fork above block 2. Both cursor and the old unbond projection must rewind atomically.
  hashes.set(4n, hex(400)); hashes.set(5n, hex(500));
  logs = logs.slice(0, 2);
  expect((await pollHostBonds(app.ctx, chain, 2n)).reorg).toBe(true);
  expect(await readRoutingBond(app.ctx.db, { id, operator }, settings)).toBe(10_000_000_000n);
  expect((await app.ctx.db.select().from(hostBondEvents)).some(e => e.event === "UnbondRequested")).toBe(false);
  await app.ctx.db.update(hostBondCursor).set({ checkedAt: new Date(0) });
  expect(await readRoutingBond(app.ctx.db, { id, operator }, settings)).toBe(0n);
  await pollHostBonds(app.ctx, chain);
});
test("dry run once per commitment; durable proposal and execution retries; dispute and owner approval enforced", async () => {
  const bundle: SlashBundle = { format: "anyroute.host-slash/1", provider_id: id, host_id: hostId, kind: "policy_rejection", reason: 0, policy_version: 1, policy_sha256: "ab".repeat(32), observed_sha256: "cd".repeat(32), attestation_ref: "ef".repeat(32), rejection_sha256: "12".repeat(32) };
  const root = await storeSlashEvidence(app.ctx, bundle) as Hex;
  expect(await storeSlashEvidence(app.ctx, bundle)).toBe(root);
  expect((await app.ctx.db.select().from(hostSlashEvidence)).length).toBe(1);
  let prepares = 0, broadcasts = 0, approved = false, disputed = false, failBroadcast = true;
  const transport: SlashTransport = {
    guard: async () => {}, host: async () => ({ operator, bond: 10_000_000_000n }), time: async () => 2_000_000_000n,
    slash: async () => ({ status: 1, dispute: disputed ? hex(1) : hex(0), executableAt: 1n, approved, root, hostId }),
    prepare: async () => { prepares++; return { hash: hex(prepares + 1000), raw: "0x1234" }; },
    broadcast: async () => { broadcasts++; if (failBroadcast) throw Error("fixture broadcast failure"); },
  };
  expect(await runHostSlasher(app.ctx, transport)).toEqual({ skipped: "dry run" });
  const first = (await app.ctx.db.select().from(hostSlashEvidence))[0];
  await runHostSlasher(app.ctx, transport);
  expect((await app.ctx.db.select().from(hostSlashEvidence))[0]).toEqual(first);
  expect(prepares).toBe(0); expect(broadcasts).toBe(0);
  app.ctx.cfg.hostBonds.slashing = true;
  await expect(runHostSlasher(app.ctx, transport)).rejects.toThrow("fixture broadcast");
  expect(prepares).toBe(1);
  failBroadcast = false;
  await runHostSlasher(app.ctx, transport); expect(prepares).toBe(1); expect(broadcasts).toBe(2);
  head = 6n;
  logs.push(event(6, "SlashProposed", { slashId: "1", hostId, reason: 0, amount: "10000000000", evidenceRoot: root, executableAt: "1" }));
  await pollHostBonds(app.ctx, chain);
  await runHostSlasher(app.ctx, transport); expect(prepares).toBe(1); // No owner approval.
  approved = true; disputed = true;
  await runHostSlasher(app.ctx, transport); expect(prepares).toBe(1);
  disputed = false;
  await runHostSlasher(app.ctx, transport); expect(prepares).toBe(2);
  await runHostSlasher(app.ctx, transport); expect(prepares).toBe(2); // One execution intent.
  const host = (await (await app.app.request(`/api/v1/hosts/${id}`)).json()).data;
  expect(host.bond.slashes[0].transactions[0].url).toBe(`https://robinhoodchain.blockscout.com/tx/${hex(106)}`);
  app.ctx.cfg.hostBonds.slashing = false;
  await storeSlashEvidence(app.ctx, { ...bundle, kind: "invalid_receipt", reason: null, observed_sha256: "56".repeat(32) });
  expect((await app.ctx.db.select().from(hostSlashEvidence)).find(r => r.reason === -1)?.status).toBe("review");
});

test("confirmation and finality regression suspends boosts until the canonical cursor is safe again", async () => {
  const cfg = app.ctx.cfg;
  const settings = { enabled: true, fullUsdg: 5_000, scope: bondScope(cfg) };
  cfg.chain.confirmations = 3;
  const lagging: BondIndexChain = { ...chain, tip: async () => ({ head: 7n, final: 5n }) };
  expect(await pollHostBonds(app.ctx, lagging)).toMatchObject({ caught_up: false });
  expect(await readRoutingBond(app.ctx.db, { id, operator }, settings)).toBe(0n);
  cfg.chain.confirmations = 1;
  await pollHostBonds(app.ctx, chain);
  expect(await readRoutingBond(app.ctx.db, { id, operator }, settings)).toBe(10_000_000_000n);
});
