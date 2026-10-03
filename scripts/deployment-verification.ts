import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, keccak256, parseAbi, stringToHex, type Abi, type Address, type Hex } from "viem";
import {
  AnyrPaymasterAbi, AnyrStakingAbi, CallPayAbi, CreditsAbi, PayWithStockAbi, ProviderBondAbi,
  ReceiptAnchorAbi, RoyaltyAbi, StockOracleAbi, UniswapV3AdapterAbi, UniswapV4AdapterAbi,
} from "../src/chain/abis";
import { runtimeMatches, type DeploymentBuild } from "./runtime-proof.ts";

export type DeploymentManifest = {
  schema: string; chainId: number | string; mode: string; blockNumber: number | string;
  deployer: Address; owner: Address; pendingOwner: Address;
  contracts: Record<string, Address>;
  roles: Record<string, Address | Address[]>;
  params: Record<string, string | number>;
  stockTokens?: Array<{ address: Address; feed: Address; primaryAdapter: Address; fallbackAdapter: Address }>;
};

export type ChainReader = {
  chainId(): Promise<number>;
  snapshot(): Promise<{ number: bigint; hash: Hex }>;
  code(address: Address, blockNumber?: bigint): Promise<Hex | undefined>;
  read(address: Address, signature: string, args?: readonly unknown[], blockNumber?: bigint): Promise<unknown>;
};

export type Check = { id: string; status: "pass" | "fail" | "info"; evidence: unknown; detail?: string };

function tupleFields(value: unknown, names: string[]): Record<string, unknown> | undefined {
  let tuple = value;
  if (Array.isArray(tuple) && tuple.length === 1 && (Array.isArray(tuple[0]) || (tuple[0] && typeof tuple[0] === "object"))) tuple = tuple[0];
  if (Array.isArray(tuple) && tuple.length >= names.length) return Object.fromEntries(names.map((name, i) => [name, tuple[i]]));
  if (tuple && typeof tuple === "object") {
    const record = tuple as Record<string, unknown>;
    if (names.every((name) => name in record)) return Object.fromEntries(names.map((name) => [name, record[name]]));
  }
  return undefined;
}
const isUnsigned = (value: unknown) => typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) || (typeof value === "string" && /^\d+$/.test(value));
const isAddress = (value: unknown) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

// SEAL contracts are checked when the manifest lists them (older manifests predate them).
const owned = ["credits", "callPay", "receiptAnchor", "royalty", "providerBond", "anyrStaking", "payWithStock", "stockOracle", "paymaster", "uniswapV4Adapter", "uniswapV3Adapter", "sealMeasurementRegistry", "policyRegistry", "kmsGovernance", "hostBond", "creditMintEvents", "skillRegistry"] as const;
const requiredContracts = ["usdg", "anyrToken", "credits", "callPay", "receiptAnchor", "royalty", "providerBond", "anyrStaking", "payWithStock", "stockOracle", "uniswapV4Adapter", "uniswapV3Adapter", "paymaster", "entryPoint", "poolManager", "swapRouter02", "timelock", "buybackAdapter"] as const;
const zero = "0x0000000000000000000000000000000000000000" as Address;
const role = (name: string) => keccak256(stringToHex(name)) as Hex;
const appAbis = [AnyrPaymasterAbi, AnyrStakingAbi, CallPayAbi, CreditsAbi, PayWithStockAbi, ProviderBondAbi, ReceiptAnchorAbi, RoyaltyAbi, StockOracleAbi, UniswapV3AdapterAbi, UniswapV4AdapterAbi] as unknown as Abi[];
export const governanceAbi = parseAbi([
  "function getOwners() view returns (address[] owners)",
  "function getThreshold() view returns (uint256 threshold)",
  "function masterCopy() view returns (address singleton)",
  "function getMinDelay() view returns (uint256 delay)",
  "function hasRole(bytes32 role,address account) view returns (bool authorized)",
]);
export const entryPointAbi = parseAbi([
  "function getDepositInfo(address account) view returns ((uint256 deposit,bool staked,uint112 stake,uint32 unstakeDelaySec,uint48 withdrawTime) info)",
]);

export function rpcAbiFor(signature: string): Abi {
  const name = signature.slice(0, signature.indexOf("("));
  const inputs = signature.slice(signature.indexOf("(") + 1, -1).split(",").filter(Boolean);
  for (const abi of appAbis) {
    const found = abi.find((item) => item.type === "function" && item.name === name && item.inputs.map((input) => input.type).join(",") === inputs.join(","));
    if (found) return [found];
  }
  if (signature === "getDepositInfo(address)") return entryPointAbi as Abi;
  const gov = governanceAbi.find((item) => item.type === "function" && item.name === name && item.inputs.map((input) => input.type).join(",") === inputs.join(","));
  if (gov) return [gov];
  throw new Error("unsupported contract read");
}

function rpcErrorCategory(error: unknown): string {
  if (!(error instanceof Error)) return "rpc_error";
  if (/timeout/i.test(error.name)) return "rpc_timeout";
  if (error.name === "RpcRequestError") return "rpc_rejected";
  if (/http|fetch|transport/i.test(error.name)) return "rpc_transport";
  return "rpc_error";
}

export function makeRpcReader(rpcUrl: string): ChainReader {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return {
    chainId: () => client.getChainId(),
    async snapshot() {
      const b = await client.getBlock({ blockTag: "latest" });
      if (!b.hash) throw new Error("latest block has no hash");
      return { number: b.number, hash: b.hash };
    },
    code: (address, blockNumber) => client.getCode({ address, blockNumber }),
    async read(address, signature, args = [], blockNumber) {
      const fn = signature.slice(0, signature.indexOf("("));
      const abi = rpcAbiFor(signature);
      const data = encodeFunctionData({ abi, functionName: fn as never, args: args as never } as never);
      const result = await client.call({ to: address, data, blockNumber });
      if (!result.data) throw new Error("Malformed RPC result");
      return decodeFunctionResult({ abi, functionName: fn as never, data: result.data } as never);
    },
  };
}

export async function verifyDeployment(manifest: DeploymentManifest, reader: ChainReader, verifierRevision: string, expectedSafeSingleton: Address, build?: DeploymentBuild): Promise<{ ok: boolean; verifierRevision: string; manifest: { schema: string; mode: string; chainId: number; blockNumber: number }; observed: { chainId: number; blockNumber: string; blockHash: Hex }; checks: Check[] }> {
  const checks: Check[] = [];
  const add = (id: string, pass: boolean, evidence: unknown, detail?: string) => checks.push({ id, status: pass ? "pass" : "fail", evidence, ...(detail ? { detail } : {}) });
  const info = (id: string, evidence: unknown, detail: string) => checks.push({ id, status: "info", evidence, detail });
  const expectedChain = Number(manifest.chainId);
  const [chainId, snapshot] = await Promise.all([reader.chainId(), reader.snapshot()]);
  add("manifest.schema", manifest.schema === "anyroute.deployments/v1", manifest.schema);
  add("manifest.production", manifest.mode === "production", manifest.mode);
  add("chain.id", chainId === expectedChain && expectedChain === 4663, { rpc: chainId, manifest: expectedChain, expectedProduction: 4663 });
  add("manifest.handoff.intent", manifest.owner === manifest.deployer && manifest.pendingOwner === manifest.contracts.timelock, { deploymentOwner: manifest.owner, deployer: manifest.deployer, intendedPendingOwner: manifest.pendingOwner, timelock: manifest.contracts.timelock }, "Confirms the deployment artifact recorded the expected transfer request; current ownership is checked from chain state below.");

  const entries = Object.entries(manifest.contracts).filter(([, address]) => address && address !== zero);
  const codeResults = await Promise.all(entries.map(async ([name, address]) => [name, address, await reader.code(address, snapshot.number)] as const));
  const codeMap = new Map(codeResults.map(([n, a, code]) => [n, { address: a, present: !!code && code !== "0x", bytes: code ? Math.max(0, (code.length - 2) / 2) : 0 }]));
  const absent = [...requiredContracts.filter((name) => !manifest.contracts[name] || manifest.contracts[name] === zero), ...codeResults.filter(([, , code]) => !code || code === "0x").map(([name]) => name)];
  add("contracts.bytecode_present", absent.length === 0, Object.fromEntries(codeMap), absent.length ? `No runtime bytecode for: ${absent.join(", ")}` : "Presence only; this does not establish source equivalence.");
  const mismatches = codeResults.filter(([name, , code]) => !build?.contracts[name] || !runtimeMatches(code, build.contracts[name])).map(([name]) => name);
  const sameRevision = !!build && build.sourceRevision === verifierRevision;
  add("contracts.source_equivalence", sameRevision && absent.length === 0 && mismatches.length === 0,
    { sourceRevision: build?.sourceRevision ?? null, mismatches },
    "Requires local compiler artifacts, exact reviewed immutable values and reviewed full hashes for external infrastructure; missing proof fails.");

  const call = async (id: string, address: Address | undefined, sig: string, args: readonly unknown[] = []): Promise<unknown> => {
    if (!address || address === zero) { add(id, false, address ?? null, "Manifest address missing or zero."); return undefined; }
    try { return await reader.read(address, sig, args, snapshot.number); }
    catch (e) { add(id, false, { category: rpcErrorCategory(e) }); return undefined; }
  };
  const equalAddress = (id: string, actual: unknown, expected: unknown) => add(id, typeof actual === "string" && typeof expected === "string" && actual.toLowerCase() === expected.toLowerCase(), { actual, expected });

  for (const name of owned) {
    const address = manifest.contracts[name];
    if (!address || address === zero) continue;
    const [owner, pending] = await Promise.all([call(`ownership.${name}.owner`, address, "owner()"), call(`ownership.${name}.pendingOwner`, address, "pendingOwner()")]);
    if (owner !== undefined && pending !== undefined) {
      equalAddress(`ownership.${name}.accepted_by_timelock`, owner, manifest.contracts.timelock);
      equalAddress(`ownership.${name}.pending_owner_clear`, pending, zero);
    }
  }
  const credits = manifest.contracts.credits, bond = manifest.contracts.providerBond, lock = manifest.contracts.timelock;
  for (const [name, addr] of [["credits", credits], ["providerBond", bond]] as const) {
    const v = await call(`controls.${name}.version`, addr, "CONTROL_VERSION()");
    if (v !== undefined) add(`controls.${name}.version_is_2`, BigInt(String(v)) === 2n, String(v));
  }
  const get = (id: string, addr: Address | undefined, sig: string) => call(id, addr, sig);
  equalAddress("roles.credits.settlement", await get("roles.credits.settlement.read", credits, "settlement()"), manifest.roles.settlement);
  equalAddress("roles.credits.usdg", await get("roles.credits.usdg.read", credits, "usdg()"), manifest.contracts.usdg);
  const creditor = await call("roles.credits.payWithStockCreditor.read", credits, "isCreditor(address)", [manifest.contracts.payWithStock]);
  if (creditor !== undefined) add("roles.credits.payWithStockCreditor", creditor === true, creditor);
  equalAddress("roles.providerBond.slasher", await get("roles.providerBond.slasher.read", bond, "slasher()"), manifest.roles.slasher);
  equalAddress("roles.providerBond.refundPool", await get("roles.providerBond.refundPool.read", bond, "refundPool()"), manifest.roles.refundPool);
  equalAddress("roles.providerBond.usdg", await get("roles.providerBond.usdg.read", bond, "usdg()"), manifest.contracts.usdg);
  equalAddress("roles.callPay.treasury", await get("roles.callPay.treasury.read", manifest.contracts.callPay, "treasury()"), manifest.roles.callPayTreasury);
  equalAddress("roles.callPay.usdg", await get("roles.callPay.usdg.read", manifest.contracts.callPay, "usdg()"), manifest.contracts.usdg);
  equalAddress("roles.receiptAnchor.anchorer", await get("roles.receiptAnchor.anchorer.read", manifest.contracts.receiptAnchor, "anchorer()"), manifest.roles.anchorer);
  equalAddress("roles.royalty.registrar", await get("roles.royalty.registrar.read", manifest.contracts.royalty, "registrar()"), manifest.roles.registrar);
  equalAddress("roles.royalty.settlement", await get("roles.royalty.settlement.read", manifest.contracts.royalty, "settlement()"), manifest.roles.settlement);
  for (const [name, sig, expected] of [["keeper", "keeper()", manifest.roles.keeper], ["opsWallet", "opsWallet()", manifest.roles.opsWallet], ["adapter", "adapter()", manifest.contracts.buybackAdapter]] as const) {
    equalAddress(`roles.anyrStaking.${name}`, await get(`roles.anyrStaking.${name}.read`, manifest.contracts.anyrStaking, sig), expected);
  }
  equalAddress("roles.anyrStaking.usdg", await get("roles.anyrStaking.usdg.read", manifest.contracts.anyrStaking, "usdg()"), manifest.contracts.usdg);
  equalAddress("roles.anyrStaking.anyr", await get("roles.anyrStaking.anyr.read", manifest.contracts.anyrStaking, "anyr()"), manifest.contracts.anyrToken);
  for (const [name, sig, expected] of [["router", "router()", manifest.roles.router], ["oracle", "oracle()", manifest.contracts.stockOracle]] as const) {
    equalAddress(`roles.payWithStock.${name}`, await get(`roles.payWithStock.${name}.read`, manifest.contracts.payWithStock, sig), expected);
  }
  equalAddress("adapters.uniswapV3.router", await get("adapters.uniswapV3.router.read", manifest.contracts.uniswapV3Adapter, "router()"), manifest.contracts.swapRouter02);
  equalAddress("adapters.uniswapV4.poolManager", await get("adapters.uniswapV4.poolManager.read", manifest.contracts.uniswapV4Adapter, "poolManager()"), manifest.contracts.poolManager);
  equalAddress("roles.paymaster.verifyingSigner", await get("roles.paymaster.verifyingSigner.read", manifest.contracts.paymaster, "verifyingSigner()"), manifest.roles.paymasterSigner);
  equalAddress("roles.paymaster.entryPoint", await get("roles.paymaster.entryPoint.read", manifest.contracts.paymaster, "entryPoint()"), manifest.contracts.entryPoint);
  const dailyCap = await get("roles.paymaster.dailyCap.read", manifest.contracts.paymaster, "dailyCap()");
  if (dailyCap !== undefined) add("roles.paymaster.dailyCap", BigInt(String(dailyCap)) === BigInt(String(manifest.params.paymasterDailyCap ?? 0)), { actual: String(dailyCap), manifest: String(manifest.params.paymasterDailyCap ?? 0) });
  equalAddress("roles.stockOracle.guardian", await get("roles.stockOracle.guardian.read", manifest.contracts.stockOracle, "guardian()"), manifest.roles.guardian);

  const delay = await call("timelock.delay.read", lock, "getMinDelay()");
  if (delay !== undefined) add("timelock.delay_at_least_24h", BigInt(String(delay)) >= 86400n, String(delay));
  const proposerRole = role("PROPOSER_ROLE"), executorRole = role("EXECUTOR_ROLE");
  for (const [id, r] of [["proposer", proposerRole], ["executor", executorRole]] as const) {
    const authorized = await call(`timelock.${id}.ownerSafe.read`, lock, "hasRole(bytes32,address)", [r, manifest.roles.ownerSafe]);
    if (authorized !== undefined) add(`timelock.${id}.ownerSafe`, authorized === true, { role: r, account: manifest.roles.ownerSafe, authorized });
  }
  for (const [id, roleHash, account] of [
    ["deployer_admin", `0x${"00".repeat(32)}` as Hex, manifest.deployer],
    ["deployer_proposer", proposerRole, manifest.deployer],
    ["deployer_executor", executorRole, manifest.deployer],
    ["open_executor", executorRole, zero],
  ] as const) {
    const authorized = await call(`timelock.${id}.read`, lock, "hasRole(bytes32,address)", [roleHash, account]);
    if (authorized !== undefined) add(`timelock.${id}_disabled`, authorized === false, { role: roleHash, account, authorized });
  }
  const safe = manifest.roles.ownerSafe as Address | undefined;
  const slasherSafe = manifest.roles.slasher as Address | undefined;
  const inspectSafe = async (label: string, address: Address | undefined) => {
    const code = address ? await reader.code(address, snapshot.number) : undefined;
    add(`governance.${label}.contract`, !!code && code !== "0x", { address, bytecodeBytes: code ? (code.length - 2) / 2 : 0 });
    const [owners, threshold, singleton] = await Promise.all([call(`governance.${label}.owners.read`, address, "getOwners()"), call(`governance.${label}.threshold.read`, address, "getThreshold()"), call(`governance.${label}.singleton.read`, address, "masterCopy()")]);
    equalAddress(`governance.${label}.singleton`, singleton, expectedSafeSingleton);
    if (!Array.isArray(owners) || threshold === undefined) return undefined;
    const signers = owners.map(String); const t = Number(threshold);
    add(`governance.${label}.threshold_valid`, signers.length > 1 && t >= 2 && t <= signers.length, { owners: signers, threshold: t });
    add(`governance.${label}.settlement_excluded`, !signers.some((x) => typeof manifest.roles.settlement === "string" && x.toLowerCase() === manifest.roles.settlement.toLowerCase()), { owners: signers, settlement: manifest.roles.settlement });
    return signers;
  };
  const [ownerSigners, slasherSigners] = await Promise.all([inspectSafe("ownerSafe", safe), inspectSafe("slasherSafe", slasherSafe)]);
  if (ownerSigners && slasherSigners) add("governance.safes.signers_disjoint", !ownerSigners.some((x) => slasherSigners.some((y) => x.toLowerCase() === y.toLowerCase())), { ownerSafe: ownerSigners, slasherSafe: slasherSigners });
  for (const [id, worker] of [["settlement", manifest.roles.settlement], ["slasher", manifest.roles.slasher]] as const) {
    add(`roles.${id}.separate_from_owner_safe`, typeof worker === "string" && !!safe && worker.toLowerCase() !== safe.toLowerCase(), { worker, ownerSafe: safe });
  }

  const adminRole = `0x${"00".repeat(32)}` as Hex;
  const selfAdmin = await call("timelock.self_admin.read", lock, "hasRole(bytes32,address)", [adminRole, lock]);
  if (selfAdmin !== undefined) add("timelock.self_admin", selfAdmin === true, { role: adminRole, account: lock, authorized: selfAdmin });
  const ownerSafeAdmin = await call("timelock.ownerSafe_admin.read", lock, "hasRole(bytes32,address)", [adminRole, safe]);
  if (ownerSafeAdmin !== undefined) add("timelock.ownerSafe_not_admin", ownerSafeAdmin === false, { role: adminRole, account: safe, authorized: ownerSafeAdmin });

  const funding = await call("paymaster.funding.read", manifest.contracts.entryPoint, "getDepositInfo(address)", [manifest.contracts.paymaster]);
  const fundingFields = tupleFields(funding, ["deposit", "staked", "stake", "unstakeDelaySec", "withdrawTime"]);
  if (!fundingFields || !isUnsigned(fundingFields.deposit) || typeof fundingFields.staked !== "boolean" || !isUnsigned(fundingFields.stake) || !isUnsigned(fundingFields.unstakeDelaySec) || !isUnsigned(fundingFields.withdrawTime)) add("paymaster.funding.shape", false, "malformed", "EntryPoint v0.7 getDepositInfo must return its five-field DepositInfo tuple.");
  else {
    const { deposit, staked, stake, unstakeDelaySec } = fundingFields;
    const p = manifest.params;
    const minimumDeposit = BigInt(String(p.paymasterDeposit ?? 0));
    const twoDailyCaps = BigInt(String(p.paymasterDailyCap ?? 0)) * 2n;
    add("paymaster.deposit", BigInt(String(deposit)) > 0n && BigInt(String(deposit)) >= minimumDeposit && BigInt(String(deposit)) >= twoDailyCaps, { actual: String(deposit), manifestMinimum: minimumDeposit.toString(), twoDailyCaps: twoDailyCaps.toString() });
    add("paymaster.stake", staked === true && BigInt(String(stake)) >= BigInt(String(p.paymasterStake ?? 0)) && BigInt(String(stake)) >= 10_000_000_000_000_000n, { staked, actual: String(stake), manifestMinimum: String(p.paymasterStake ?? 0), hardMinimum: "10000000000000000" });
    add("paymaster.unstake_delay", BigInt(String(unstakeDelaySec)) >= 86400n, { actual: String(unstakeDelaySec), requiredMinimum: 86400 });
  }
  const priceOracle = await call("buybacks.oracle.read", manifest.contracts.anyrStaking, "buybackPriceOracle()");
  const buybacksEnabled = typeof priceOracle === "string" && priceOracle.toLowerCase() !== zero.toLowerCase();
  if (typeof priceOracle === "string") {
    info("buybacks.oracle", priceOracle, buybacksEnabled ? "Oracle address present; its policy and price quality require separate review." : "Buybacks are disabled until a price oracle is selected and configured.");
    if (buybacksEnabled) {
      const oracleCode = await reader.code(priceOracle as Address, snapshot.number);
      add("buybacks.oracle_code_present", !!oracleCode && oracleCode !== "0x", { address: priceOracle, present: !!oracleCode && oracleCode !== "0x" });
    }
  }

  const stockTokens = manifest.stockTokens ?? [];
  info("stockPay.feature", stockTokens.length ? `${stockTokens.length} manifest tokens` : "disabled/not certified", stockTokens.length ? "Every manifest-listed route is checked below; tokens omitted from the manifest cannot be enumerated from the on-chain mapping." : "No stock tokens are listed, so stock-pay readiness is not certified and does not block unrelated features.");
  const requiredAdapterCallers = new Map<string, { adapter: Address; caller: Address }>();
  for (const stock of stockTokens) {
    for (const adapter of [stock.primaryAdapter, stock.fallbackAdapter]) {
      if ([manifest.contracts.uniswapV3Adapter, manifest.contracts.uniswapV4Adapter].some((configured) => adapter.toLowerCase() === configured.toLowerCase())) {
        requiredAdapterCallers.set(`${adapter.toLowerCase()}:${manifest.contracts.payWithStock.toLowerCase()}`, { adapter, caller: manifest.contracts.payWithStock });
      }
    }
  }
  if (buybacksEnabled && [manifest.contracts.uniswapV3Adapter, manifest.contracts.uniswapV4Adapter].some((configured) => manifest.contracts.buybackAdapter.toLowerCase() === configured.toLowerCase())) {
    requiredAdapterCallers.set(`${manifest.contracts.buybackAdapter.toLowerCase()}:${manifest.contracts.anyrStaking.toLowerCase()}`, { adapter: manifest.contracts.buybackAdapter, caller: manifest.contracts.anyrStaking });
  }
  for (const { adapter, caller } of requiredAdapterCallers.values()) {
    const isCaller = await call(`adapters.${adapter}.${caller}.read`, adapter, "isCaller(address)", [caller]);
    if (isCaller !== undefined) add(`adapters.${adapter}.${caller}.enabled`, isCaller === true, { adapter, caller, isCaller });
  }
  for (const stock of stockTokens) {
    const tokenConfig = await call(`stocks.${stock.address}.config.read`, manifest.contracts.payWithStock, "tokens(address)", [stock.address]);
    const tokenFields = tupleFields(tokenConfig, ["enabled", "primaryAdapter", "fallbackAdapter"]);
    if (!tokenFields || typeof tokenFields.enabled !== "boolean" || !isAddress(tokenFields.primaryAdapter) || !isAddress(tokenFields.fallbackAdapter)) add(`stocks.${stock.address}.config_shape`, false, "malformed", "PayWithStock.tokens must return its enabled flag and both adapter addresses.");
    else {
      add(`stocks.${stock.address}.enabled`, tokenFields.enabled === true, tokenFields.enabled);
      equalAddress(`stocks.${stock.address}.primaryAdapter`, tokenFields.primaryAdapter, stock.primaryAdapter);
      equalAddress(`stocks.${stock.address}.fallbackAdapter`, tokenFields.fallbackAdapter, stock.fallbackAdapter);
      const primaryCode = await reader.code(tokenFields.primaryAdapter as Address, snapshot.number);
      add(`stocks.${stock.address}.primaryAdapter_code`, tokenFields.primaryAdapter !== zero && !!primaryCode && primaryCode !== "0x", { address: tokenFields.primaryAdapter, present: !!primaryCode && primaryCode !== "0x" });
      if (tokenFields.fallbackAdapter !== zero) {
        const fallbackCode = await reader.code(tokenFields.fallbackAdapter as Address, snapshot.number);
        add(`stocks.${stock.address}.fallbackAdapter_code`, !!fallbackCode && fallbackCode !== "0x", { address: tokenFields.fallbackAdapter, present: !!fallbackCode && fallbackCode !== "0x" });
      }
    }
    const config = await call(`feeds.${stock.address}.config.read`, manifest.contracts.stockOracle, "configOf(address)", [stock.address]);
    const feedFields = tupleFields(config, ["feed", "feedDecimals", "maxStaleness", "paused", "applyMultiplier"]);
    if (!feedFields || !isAddress(feedFields.feed) || !isUnsigned(feedFields.feedDecimals) || !isUnsigned(feedFields.maxStaleness) || typeof feedFields.paused !== "boolean" || typeof feedFields.applyMultiplier !== "boolean") add(`feeds.${stock.address}.config_shape`, false, "malformed", "Stock oracle configOf must return the five-field FeedConfig tuple.");
    else {
      const { feed, feedDecimals: decimals, maxStaleness: staleness, paused } = feedFields;
      equalAddress(`feeds.${stock.address}.matches_manifest`, feed, stock.feed);
      add(`feeds.${stock.address}.active`, feed !== zero && Number(decimals) <= 36 && Number(staleness) > 0 && paused === false, { feed, decimals, maxStaleness: staleness, paused });
      const feedCode = await reader.code(feed as Address, snapshot.number);
      add(`feeds.${stock.address}.bytecode_present`, !!feedCode && feedCode !== "0x", { feed, present: !!feedCode && feedCode !== "0x" });
    }
  }

  const ok = checks.every((c) => c.status !== "fail");
  return { ok, verifierRevision, manifest: { schema: manifest.schema, mode: manifest.mode, chainId: expectedChain, blockNumber: Number(manifest.blockNumber) }, observed: { chainId, blockNumber: snapshot.number.toString(), blockHash: snapshot.hash }, checks };
}
