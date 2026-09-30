import { keccak256, toBytes } from "viem";
export const bondHostId = (id: string) => keccak256(toBytes(id));
export const bondScope = (cfg: { chain: { id: number }; hostBonds: { address?: string } }) => `${cfg.chain.id}:${cfg.hostBonds.address}`;
export type BondHost = { operator: string; bond: string; unbond: string; availableAt: string | null; delisted: boolean };
export type BondSlash = { hostId: string; amount: string; reason: number; evidenceRoot: string; executableAt: string; disputeHash: string | null; status: string; approval: number; transactions: { event: string; hash: string }[] };
export type BondParameters = { minBond: string; generation: number; slasher?: string; refundPool?: string; owner?: string; pendingOwner?: string };
export type BondEvent = { event: string; args: Record<string, unknown>; txHash: string };
export type BondState = Map<string, BondHost | BondSlash | BondParameters>;
export const emptyHost = (): BondHost => ({ operator: "", bond: "0", unbond: "0", availableAt: null, delisted: false });
export const parameters = (state: BondState): BondParameters => state.get("parameters:current") as BondParameters ?? { minBond: "5000000000", generation: 1 };
/** Journal projection; no provider data is mutated, so orphaned logs are fully reversible. */
export function applyBondEvent(state: BondState, e: BondEvent): string[] {
  const a = e.args;
  const changes = new Set<string>();
  const hostKey = `host:${String(a.hostId).toLowerCase()}`;
  const slashKey = `slash:${a.slashId}`;
  const h = structuredClone(state.get(hostKey) as BondHost ?? emptyHost());
  const p = structuredClone(parameters(state));
  const s = structuredClone(state.get(slashKey) as BondSlash | undefined);
  const put = (key: string, data: BondHost | BondSlash | BondParameters) => { state.set(key, data); changes.add(key); };
  switch (e.event) {
    case "Bonded": h.operator = String(a.operator).toLowerCase(); h.bond = String(a.total); put(hostKey, h); break;
    case "UnbondRequested": h.unbond = String(a.amount); h.availableAt = String(a.availableAt); put(hostKey, h); break;
    case "UnbondCancelled": h.unbond = "0"; h.availableAt = null; put(hostKey, h); break;
    case "Unbonded": h.bond = (BigInt(h.bond) - BigInt(String(a.amount))).toString(); h.unbond = "0"; h.availableAt = null; put(hostKey, h); break;
    case "Delisted": h.delisted = true; put(hostKey, h); break;
    case "SlashProposed": put(slashKey, { hostId: String(a.hostId).toLowerCase(), amount: String(a.amount), reason: Number(a.reason), evidenceRoot: String(a.evidenceRoot).toLowerCase(), executableAt: String(a.executableAt), disputeHash: null, status: "pending", approval: 0, transactions: [{ event: e.event, hash: e.txHash }] }); break;
    case "SlashDisputed": case "SlashApproved": case "SlashCancelled": case "SlashExecuted": {
      if (!s) throw new Error("HostBond slash journal is incomplete; check HOST_BOND_START_BLOCK.");
      if (e.event === "SlashDisputed") { s.disputeHash = String(a.disputeHash); s.approval = 0; }
      if (e.event === "SlashApproved") s.approval = p.generation;
      if (e.event === "SlashCancelled") s.status = "cancelled";
      if (e.event === "SlashExecuted") { s.status = "executed"; h.bond = (BigInt(h.bond) - BigInt(String(a.amount))).toString(); h.delisted ||= a.delisted === true; put(hostKey, h); }
      s.transactions.push({ event: e.event, hash: e.txHash }); put(slashKey, s); break;
    }
    case "SlashApprovalsRevoked": p.generation++; put("parameters:current", p); break;
    case "MinBondSet": p.minBond = String(a.minBond); put("parameters:current", p); break;
    case "SlasherSet": p.slasher = String(a.slasher); put("parameters:current", p); break;
    case "RefundPoolSet": p.refundPool = String(a.pool); put("parameters:current", p); break;
    case "OwnershipTransferred": p.owner = String(a.newOwner); p.pendingOwner = undefined; put("parameters:current", p); break;
    case "OwnershipTransferStarted": p.pendingOwner = String(a.newOwner); put("parameters:current", p); break;
    default: throw new Error("Unknown HostBond event; ABI must match the configured contract.");
  }
  return [...changes];
}
export function activeBond(h: BondHost) { return BigInt(h.bond) > BigInt(h.unbond) ? BigInt(h.bond) - BigInt(h.unbond) : 0n; }
