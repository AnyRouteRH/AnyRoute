// Real HostBond bytecode on an isolated anvil. Run: E2E_HOST_BOND_ANVIL=1 bun test test/network-bonds-anvil.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toBytes, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { createApp } from "../src/app.ts";
import { hostBondAbi } from "../src/network/bond-abi.ts";
import { pollHostBonds } from "../src/network/bond-indexer.ts";
import { bondHostId } from "../src/network/bond-state.ts";
import { readRoutingBond } from "../src/network/bonds.ts";
import { hostBondEvents, hostSlashEvidence } from "../src/network/bond-schema.ts";
import { providers } from "../src/db/schema.ts";
import { runHostSlasher, storeSlashEvidence } from "../src/network/slashing.ts";
const RUN = process.env.E2E_HOST_BOND_ANVIL === "1";
const ROOT = resolve(import.meta.dir, "..");
const RPC = "http://127.0.0.1:8558";
const chain = defineChain({ id: 4663, name: "HostBond anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
// Anvil's documented fixture mnemonic; not a live wallet.
const accounts = [0, 1, 2, 3].map(addressIndex => mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex }));
const pub = createPublicClient({ chain, cacheTime: 0, transport: http(RPC, { retryCount: 0 }) });
const wallets = accounts.map(account => createWalletClient({ account, chain, transport: http(RPC) }));
const artifact = (name: string) => JSON.parse(readFileSync(resolve(ROOT, `contracts/out/${name}.sol/${name}.json`), "utf8"));
const digest = (s: string) => keccak256(toBytes(s));
describe.skipIf(!RUN)("HostBond on anvil", () => {
  let process: ReturnType<typeof Bun.spawn>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let bond: Hex, usdg: Hex, bondArtifact: any, token: any;
  const id = "anvil-bond-host", hostId = bondHostId(id);
  const send = async (i: number, address: Hex, abi: any, functionName: string, args: unknown[] = []) => {
    const hash = await wallets[i].writeContract({ address, abi, functionName, args } as never);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw Error(`${functionName} reverted`);
    return receipt;
  };
  const mine = async (seconds = 0) => {
    if (seconds) await pub.request({ method: "evm_increaseTime" as never, params: [seconds] as never });
    await pub.request({ method: "evm_mine" as never, params: [] as never });
  };
  const index = async () => {
    await pub.request({ method: "anvil_mine" as never, params: ["0x40", "0x1"] as never });
    return pollHostBonds(app.ctx);
  };
  beforeAll(async () => {
    const build = Bun.spawn(["bash", "../scripts/foundry.sh", "forge", "build", "--offline"], { cwd: resolve(ROOT, "contracts"), stdout: "ignore", stderr: "pipe" });
    if (await build.exited !== 0) throw Error("forge build failed");
    process = Bun.spawn(["bash", "scripts/foundry.sh", "anvil", "--port", "8558", "--chain-id", "4663", "--silent"], { cwd: ROOT, stdout: "ignore", stderr: "pipe" });
    let ready = false;
    for (let i = 0; i < 50; i++) { try { await pub.getBlockNumber(); ready = true; break; } catch { await Bun.sleep(100); } }
    if (!ready) throw Error("anvil unavailable on isolated port 8558");
    token = artifact("MockUSDG"); bondArtifact = artifact("HostBond");
    const deployedToken = await pub.waitForTransactionReceipt({ hash: await wallets[0].deployContract({ abi: token.abi, bytecode: token.bytecode.object }) });
    usdg = deployedToken.contractAddress!;
    const deployed = await pub.waitForTransactionReceipt({ hash: await wallets[0].deployContract({ abi: bondArtifact.abi, bytecode: bondArtifact.bytecode.object, args: [usdg, accounts[0].address, accounts[1].address, accounts[3].address] }) });
    bond = deployed.contractAddress!;
    app = await createApp({ startJobs: false, env: { ANYROUTE_ENV: "test", DATABASE_URL: "pglite://memory", RHC_RPC_URL: RPC, NETWORK_BONDS_ENABLED: true, HOST_BOND_ADDRESS: bond, HOST_BOND_START_BLOCK: deployed.blockNumber.toString(), CHAIN_CONFIRMATIONS: "1" } });
    await app.ctx.db.insert(providers).values({ id, name: "Bond host", baseUrl: "https://host.example", networkHost: true, operator: accounts[2].address });
    await send(0, usdg, token.abi, "mint", [accounts[2].address, 30_000_000_000n]);
    await send(2, usdg, token.abi, "approve", [bond, 30_000_000_000n]);
  }, 120_000);
  afterAll(async () => { await app?.close(); process?.kill(); });
  const readBond = () => readRoutingBond(app.ctx.db, { id, operator: accounts[2].address }, { enabled: true, fullUsdg: 5_000, scope: `4663:${bond.toLowerCase()}` });
  test("bond, request, cancellation, cooldown completion and minimum parameter change", async () => {
    await send(2, bond, bondArtifact.abi, "bond", [hostId, 20_000_000_000n]);
    await index(); expect(await readBond()).toBe(20_000_000_000n);
    await send(2, bond, bondArtifact.abi, "requestUnbond", [hostId, 10_000_000_000n]);
    await index(); expect(await readBond()).toBe(10_000_000_000n);
    await send(2, bond, bondArtifact.abi, "cancelUnbond", [hostId]);
    await index(); expect(await readBond()).toBe(20_000_000_000n);
    await send(2, bond, bondArtifact.abi, "requestUnbond", [hostId, 10_000_000_000n]);
    await mine(14 * 86400 + 1);
    await send(2, bond, bondArtifact.abi, "unbond", [hostId, accounts[2].address]);
    await index(); expect(await readBond()).toBe(10_000_000_000n);
    await send(0, bond, bondArtifact.abi, "setMinBond", [15_000_000_000n]);
    await index(); expect(await readBond()).toBe(0n);
    await send(0, bond, bondArtifact.abi, "setMinBond", [5_000_000_000n]);
  }, 30_000);
  test("propose/dispute/approve/cancel, and independently approved execution", async () => {
    await send(1, bond, bondArtifact.abi, "proposeSlash", [hostId, 0, 1_000_000_000n, digest("disputed evidence"), false]);
    await send(2, bond, bondArtifact.abi, "disputeSlash", [1n, digest("operator dispute")]);
    await send(0, bond, bondArtifact.abi, "approveSlash", [1n, digest("operator dispute")]);
    await send(1, bond, bondArtifact.abi, "cancelSlash", [1n]);
    await send(1, bond, bondArtifact.abi, "proposeSlash", [hostId, 0, 1_000_000_000n, digest("undisputed evidence"), false]);
    await send(0, bond, bondArtifact.abi, "approveSlash", [2n, `0x${"0".repeat(64)}`]);
    await mine(72 * 3600 + 1);
    await send(1, bond, bondArtifact.abi, "executeSlash", [2n]);
    await index(); expect(await readBond()).toBe(9_000_000_000n);
    const events = await app.ctx.db.select().from(hostBondEvents);
    for (const name of ["Bonded", "UnbondRequested", "UnbondCancelled", "Unbonded", "SlashProposed", "SlashDisputed", "SlashApproved", "SlashCancelled", "SlashExecuted", "MinBondSet"]) expect(events.some(e => e.event === name)).toBe(true);
  }, 30_000);
  test("canonical reorg removes orphaned top-up; resumes across repeated scans", async () => {
    await index();
    const snapshot = await pub.request({ method: "evm_snapshot" as never, params: [] as never });
    await send(2, bond, bondArtifact.abi, "bond", [hostId, 5_000_000_000n]);
    await index(); expect(await readBond()).toBe(14_000_000_000n);
    await pub.request({ method: "evm_revert" as never, params: [snapshot] as never });
    await mine(1);
    expect((await index()).reorg).toBe(true); expect(await readBond()).toBe(9_000_000_000n);
    expect((await index()).recorded).toBe(0);
  }, 30_000);
  test("real slasher persists signed bytes once, requires owner approval, then executes", async () => {
    const bundle = { format: "anyroute.host-slash/1" as const, provider_id: id, host_id: hostId, kind: "policy_rejection" as const, reason: 0 as const, observed_sha256: "cd".repeat(32), attestation_ref: "ab".repeat(32), rejection_sha256: "ef".repeat(32) };
    await storeSlashEvidence(app.ctx, bundle);
    await runHostSlasher(app.ctx);
    app.ctx.cfg.hostBonds.slashing = true;
    app.ctx.cfg.chain.slasherKey = accounts[1].getHdKey().privateKey ? `0x${Buffer.from(accounts[1].getHdKey().privateKey!).toString("hex")}` : undefined;
    // ChainService creates its signing wallets from config at construction, so replace with a fresh service.
    const { ChainService } = await import("../src/chain/service.ts"); app.ctx.chain = new ChainService(app.ctx.cfg);
    await runHostSlasher(app.ctx);
    const before = (await app.ctx.db.select().from(hostSlashEvidence))[0];
    expect(before.proposalTx).toMatch(/^0x/); expect(before.proposalRaw).toMatch(/^v1\./);
    await runHostSlasher(app.ctx);
    expect((await app.ctx.db.select().from(hostSlashEvidence))[0].proposalTx).toBe(before.proposalTx);
    await index();
    await mine(72 * 3600 + 1); await index();
    expect(await runHostSlasher(app.ctx)).toMatchObject({ skipped: "nothing ready" });
    const zero = `0x${"0".repeat(64)}` as Hex;
    await send(0, bond, bondArtifact.abi, "approveSlash", [3n, zero]);
    await index();
    await runHostSlasher(app.ctx);
    await index(); await runHostSlasher(app.ctx);
    expect((await app.ctx.db.select().from(hostSlashEvidence))[0].status).toBe("executed");
    expect(await readBond()).toBe(0n);
    const liveSlasher = await pub.readContract({ address: bond, abi: hostBondAbi, functionName: "slasher" });
    expect(liveSlasher.toLowerCase()).toBe(accounts[1].address.toLowerCase());
  }, 30_000);
});
