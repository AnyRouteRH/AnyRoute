import type { Hex } from "viem";
import { verifySignedDocument, type SignedDocument } from "../identity/signed.ts";

// Portable track record (v6 I4): a router-signed summary of one agent key's anchored receipts, with a Merkle root over
// those receipts' anchor leaves, that doubles as the payload of an ERC-8004 validation entry. Aggregates only: a count,
// total spend, refund and dispute rates, and the first and last receipt times. No counterparty, and no amount per
// counterparty, is in it.

export const TRACK_RECORD_TTL_MS = 7 * 86_400_000;
export const TRACK_RECORD_TYPE = "anyroute.agent.track-record";
export const TRACK_RECORD_NOTICE = "Signed by AnyRoute's router from its own records of this key. Counts anchored receipts only; names no counterparty and no amount per counterparty; not a zero-knowledge proof.";
export const TRACK_RECORD_TREE = "OpenZeppelin MerkleProof tree (sorted-pair keccak256) over the v1 anchor leaf of each counted receipt, unique, ascending";

export type TrackRecordStats = {
  receipts: number;
  spend_usd: string;
  refunded_receipts: number;
  refund_rate_bps: number;
  agreements: number;
  disputed_agreements: number;
  dispute_rate_bps: number;
  first_receipt_at: string | null;
  last_receipt_at: string | null;
};
export type TrackRecordPayload = {
  version: 1;
  type: typeof TRACK_RECORD_TYPE;
  pseudonym: string;
  agent: { profile: string | null; erc8004: { registry: string; agent_id: string } | null };
  stats: TrackRecordStats;
  merkle: {
    root: Hex | null;
    leaf_count: number;
    tree: typeof TRACK_RECORD_TREE;
    max_anchor_index: number | null;
    anchors: { count: number; confirmed: number; local: number; pending: number };
    receipt_anchor: { chain_id: number; contract: string | null };
  };
  issued_at: string;
  expires_at: string;
  notice: typeof TRACK_RECORD_NOTICE;
};
export type TrackRecordCertificate = SignedDocument<TrackRecordPayload>;

export const rateBps = (part: number, whole: number) => (whole > 0 ? Math.round((part * 10_000) / whole) : 0);

export function isTrackRecord(value: unknown): value is TrackRecordCertificate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as TrackRecordCertificate, p = c.payload;
  if (!p || typeof p !== "object" || p.version !== 1 || p.type !== TRACK_RECORD_TYPE || p.notice !== TRACK_RECORD_NOTICE) return false;
  if (typeof p.pseudonym !== "string" || !/^[0-9a-f]{64}$/.test(p.pseudonym)) return false;
  const s = p.stats, m = p.merkle;
  if (!s || !m || !Number.isSafeInteger(s.receipts) || s.receipts < 0 || m.leaf_count !== s.receipts || m.tree !== TRACK_RECORD_TREE) return false;
  if ((s.receipts === 0) !== (m.root === null) || (m.root !== null && !/^0x[0-9a-f]{64}$/.test(m.root))) return false;
  if (!/^\d+(\.\d+)?$/.test(s.spend_usd) || s.refund_rate_bps !== rateBps(s.refunded_receipts, s.receipts) || s.dispute_rate_bps !== rateBps(s.disputed_agreements, s.agreements)) return false;
  return typeof p.issued_at === "string" && typeof p.expires_at === "string";
}

/** Signature against an independently obtained key set, the seven-day window and the internal consistency of the stats. */
export function verifyTrackRecord(value: unknown, options: { keys: Parameters<typeof verifySignedDocument>[1]; nowMs?: number }): boolean {
  if (!isTrackRecord(value)) return false;
  const issued = Date.parse(value.payload.issued_at), expires = Date.parse(value.payload.expires_at), now = options.nowMs ?? Date.now();
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= now || expires - issued !== TRACK_RECORD_TTL_MS) return false;
  return verifySignedDocument(value, options.keys, value.payload.issued_at);
}
