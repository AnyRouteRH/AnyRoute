import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, keccak256, parseAbi, stringToHex, type Abi, type Address, type Hex } from "viem";

export type DeploymentManifest = {
  schema: string; chainId: number | string; mode: string; blockNumber: number | string;
  deployer: Address; owner: Address; pendingOwner: Address;
  contracts: Record<string, Address>;
  roles: Record<string, Address | Address[]>;
  params: Record<string, string | number>;
  stockTokens?: Array<{ address: Address; feed: Address }>;
};

export type ChainReader = {
  chainId(): Promise<number>;
  snapshot(): Promise<{ number: bigint; hash: Hex }>;
  code(address: Address, blockNumber?: bigint): Promise<Hex | undefined>;
  read(address: Address, signature: string, args?: readonly unknown[], blockNumber?: bigint): Promise<unknown>;
};

export type Check = { id: string; status: "pass" | "fail" | "info"; evidence: unknown; detail?: string };

const owned = ["credits", "callPay", "receiptAnchor", "royalty", "providerBond", "anyrStaking", "payWithStock", "stockOracle", "paymaster", "uniswapV4Adapter", "uniswapV3Adapter"] as const;
const requiredContracts = ["usdg", "anyrToken", "credits", "callPay", "receiptAnchor", "royalty", "providerBond", "anyrStaking", "payWithStock", "stockOracle", "uniswapV4Adapter", "uniswapV3Adapter", "paymaster", "entryPoint", "poolManager", "swapRouter02", "timelock", "buybackAdapter"] as const;
const zero = "0x0000000000000000000000000000000000000000" as Address;
const role = (name: string) => keccak256(stringToHex(name)) as Hex;

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
      const abi = parseAbi([`function ${signature} view returns (${returnShape(signature)})` as never]) as Abi;
      const fn = signature.slice(0, signature.indexOf("("));
      const data = encodeFunctionData({ abi, functionName: fn as never, args: args as never } as never);
      const result = await client.call({ to: address, data, blockNumber });
      if (!result.data) throw new Error(`${fn} returned no data`);
      return decodeFunctionResult({ abi, functionName: fn as never, data: result.data } as never);
    },
  };
}

// Kept explicit so signatures stay reviewable at the read boundary.
function returnShape(signature: string): string {
  const shapes: Record<string, string> = {
    "owner()": "address", "pendingOwner()": "address", "CONTROL_VERSION()": "uint256", "settlement()": "address",
    "isCreditor(address)": "bool", "usdg()": "address", "treasury()": "address", "anchorer()": "address",
    "registrar()": "address", "slasher()": "address", "refundPool()": "address", "keeper()": "address",
    "opsWallet()": "address", "adapter()": "address", "buybackPriceOracle()": "address", "router()": "address",
    "oracle()": "address", "verifyingSigner()": "address", "guardian()": "address", "getMinDelay()": "uint256",
    "hasRole(bytes32,address)": "bool", "getOwners()": "address[]", "getThreshold()": "uint256",
    "getDepositInfo(address)": "uint112 deposit, bool staked, uint112 stake, uint32 unstakeDelaySec", "dailyCap()": "uint256", "entryPoint()": "address",
    "configOf(address)": "(address feed, uint8 feedDecimals, uint32 maxStaleness, bool paused, bool applyMultiplier)",
  };
  const shape = shapes[signature];
  if (!shape) throw new Error(`unsupported getter: ${signature}`);
  return shape;
}

export async function verifyDeployment(manifest: DeploymentManifest, reader: ChainReader, sourceRevision: string): Promise<{ ok: boolean; sourceRevision: string; manifest: { schema: string; mode: string; chainId: number; blockNumber: number }; observed: { chainId: number; blockNumber: string; blockHash: Hex }; checks: Check[] }> {
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
  info("contracts.source_equivalence", "not checked", "Runtime bytecode is reported for presence and size only; immutable masking or verified-source comparison is not performed.");

  const call = async (id: string, address: Address | undefined, sig: string, args: readonly unknown[] = []): Promise<unknown> => {
    if (!address || address === zero) { add(id, false, address ?? null, "Manifest address missing or zero."); return undefined; }
    try { return await reader.read(address, sig, args, snapshot.number); }
    catch (e) { add(id, false, String(e)); return undefined; }
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
  const safe = manifest.roles.ownerSafe as Address | undefined;
  const slasherSafe = manifest.roles.slasher as Address | undefined;
  const inspectSafe = async (label: string, address: Address | undefined) => {
    const code = address ? await reader.code(address, snapshot.number) : undefined;
    add(`governance.${label}.contract`, !!code && code !== "0x", { address, bytecodeBytes: code ? (code.length - 2) / 2 : 0 });
    const [owners, threshold] = await Promise.all([call(`governance.${label}.owners.read`, address, "getOwners()"), call(`governance.${label}.threshold.read`, address, "getThreshold()")]);
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

  const funding = await call("paymaster.funding.read", manifest.contracts.entryPoint, "getDepositInfo(address)", [manifest.contracts.paymaster]);
  if (Array.isArray(funding)) {
    const [deposit, staked, stake, unstakeDelaySec] = funding;
    const p = manifest.params;
    const minimumDeposit = BigInt(String(p.paymasterDeposit ?? 0));
    const twoDailyCaps = BigInt(String(p.paymasterDailyCap ?? 0)) * 2n;
    add("paymaster.deposit", BigInt(String(deposit)) > 0n && BigInt(String(deposit)) >= minimumDeposit && BigInt(String(deposit)) >= twoDailyCaps, { actual: String(deposit), manifestMinimum: minimumDeposit.toString(), twoDailyCaps: twoDailyCaps.toString() });
    add("paymaster.stake", staked === true && BigInt(String(stake)) >= BigInt(String(p.paymasterStake ?? 0)) && BigInt(String(stake)) >= 10_000_000_000_000_000n, { staked, actual: String(stake), manifestMinimum: String(p.paymasterStake ?? 0), hardMinimum: "10000000000000000" });
    add("paymaster.unstake_delay", BigInt(String(unstakeDelaySec)) >= 86400n, { actual: String(unstakeDelaySec), requiredMinimum: 86400 });
  }
  const priceOracle = await call("buybacks.oracle.read", manifest.contracts.anyrStaking, "buybackPriceOracle()");
  if (typeof priceOracle === "string") info("buybacks.oracle", priceOracle, priceOracle.toLowerCase() === zero ? "Buybacks are fail-closed until a price oracle is selected and configured." : "Oracle address present; its policy and price quality require separate review.");

  for (const stock of manifest.stockTokens ?? []) {
    const config = await call(`feeds.${stock.address}.config.read`, manifest.contracts.stockOracle, "configOf(address)", [stock.address]);
    if (Array.isArray(config)) {
      const [feed, decimals, staleness, paused] = config;
      equalAddress(`feeds.${stock.address}.matches_manifest`, feed, stock.feed);
      add(`feeds.${stock.address}.active`, feed !== zero && Number(decimals) <= 36 && Number(staleness) > 0 && paused === false, { feed, decimals, maxStaleness: staleness, paused });
      const feedCode = await reader.code(feed as Address, snapshot.number);
      add(`feeds.${stock.address}.bytecode_present`, !!feedCode && feedCode !== "0x", { feed, present: !!feedCode && feedCode !== "0x" });
    }
  }

  const ok = checks.every((c) => c.status !== "fail");
  return { ok, sourceRevision, manifest: { schema: manifest.schema, mode: manifest.mode, chainId: expectedChain, blockNumber: Number(manifest.blockNumber) }, observed: { chainId, blockNumber: snapshot.number.toString(), blockHash: snapshot.hash }, checks };
}
