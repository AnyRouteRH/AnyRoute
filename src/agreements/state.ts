import { encodeAbiParameters, keccak256 } from "viem";
import type { Config } from "../config.ts";
export type Agreement = { id: string; agreementId: string; milestone: string; creation: string; payer: string; payee: string; oracle: string; amount: string; termsHash: string; deadline: string; deliverables: string[]; reviewDeadline?: string; state: "funded" | "submitted" | "disputed" | "released" | "resolved"; dispute?: string; disputedAt?: number; disputeEvidenceHash?: string; resolvedAt?: number; payeeAmount?: string; payerAmount?: string; ruling?: { payeeBps: number; evidenceRoot?: string; tallyBitmap?: string; participationBitmap?: string; tallyHash?: string; juryVersion?: string; path?: string; verdict?: number } };
export type AgreementState = Map<string, Agreement>;
export const agreementScope = (cfg: Config) => `${cfg.chain.id}:${cfg.agreements.escrow}:${cfg.agreements.oracle}`;
export const rulingKey = (escrow: `0x${string}`, id: string, milestone: string) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [escrow, BigInt(id), BigInt(milestone)]));
export function applyAgreementEvent(state: AgreementState, e: { event: string; args: Record<string, unknown>; txHash: string; logIndex: number }): string[] {
  const a = e.args, id = String(a.id), key = `agreement:${id}.${a.milestone}`;
  if (e.event === "MilestoneFunded") {
    state.set(key, { id: `${id}.${a.milestone}`, agreementId: id, milestone: String(a.milestone), amount: String(a.amount), state: "funded", creation: "", payer: "", payee: "", oracle: "", termsHash: "", deadline: "", deliverables: [] });
    return [key];
  }
  if (e.event === "AgreementCreated") {
    if (!/^\d+$/.test(id) || !/^0x[0-9a-f]{40}$/i.test(String(a.payer)) || !/^0x[0-9a-f]{40}$/i.test(String(a.payee))) throw new Error("Invalid agreement event.");
    const changed: string[] = [];
    for (const [k, row] of state) if (row.agreementId === id) {
      Object.assign(row, { creation: `${e.txHash}:${e.logIndex}`, payer: String(a.payer).toLowerCase(), payee: String(a.payee).toLowerCase(), oracle: String(a.disputeOracle).toLowerCase(), termsHash: String(a.termsHash), deadline: String(a.deadline) }); changed.push(k);
    }
    if (!changed.length) throw new Error("Missing milestone funding history.");
    return changed;
  }
  const oracleEvent = ["TallyRecorded", "PanelRequired", "RulingPosted"].includes(e.event);
  if (e.event === "RulingPosted" && String(a.escrow).toLowerCase() !== String(a.indexedEscrow).toLowerCase()) return [];
  const found = oracleEvent ? [...state].find(([, row]) => a.key === rulingKey(String(a.escrow ?? a.indexedEscrow) as `0x${string}`, row.agreementId, row.milestone)) : undefined;
  const row = oracleEvent ? found?.[1] : state.get(key), changedKey = oracleEvent ? found?.[0] : key;
  // A configured oracle may also adjudicate other escrows, which this index does not track.
  if (oracleEvent && (!row || String(a.indexedOracle).toLowerCase() !== row.oracle)) return [];
  if (!row || !changedKey || !row.creation) throw new Error("Agreement history missing; check AGREEMENT_START_BLOCK and ABI.");
  switch (e.event) {
    case "DeliverySubmitted": row.deliverables.push(String(a.deliverableHash)); row.reviewDeadline = String(a.reviewUntil); row.state = "submitted"; break;
    case "DisputeOpened": row.dispute = `${e.txHash}:${e.logIndex}`; row.disputedAt = Number(a.indexedAt); row.disputeEvidenceHash = String(a.evidenceHash); row.state = "disputed"; break;
    case "Released": row.state = "released"; break;
    case "DeadlineRefunded": row.state = "resolved"; row.ruling = { payeeBps: 0, path: "deadline" }; break;
    case "Ruled": row.ruling = { ...row.ruling, payeeBps: Number(a.payeeBps) }; break;
    case "StaleDisputeResolved": row.ruling = { ...row.ruling, payeeBps: 5000, path: "stale" }; break;
    case "Settled": row.state = row.state === "released" ? "released" : "resolved"; row.resolvedAt = Number(a.indexedAt); row.payeeAmount = String(a.payeeAmount); row.payerAmount = String(a.payerAmount); break;
    case "TallyRecorded": row.ruling = { payeeBps: 0, evidenceRoot: String(a.evidenceRoot), tallyBitmap: String(a.consensusBitmap), participationBitmap: String(a.participationBitmap), juryVersion: String(a.version), tallyHash: String(a.tallyHash) }; break;
    case "PanelRequired": row.ruling = { ...row.ruling!, path: "panel_pending" }; break;
    case "RulingPosted": row.ruling = { ...row.ruling, payeeBps: Number(a.payeeBps), verdict: Number(a.verdict), path: Number(a.path) === 3 ? "panel" : "jury" }; break;
    default: throw new Error("Unknown agreement event.");
  }
  return [changedKey];
}
