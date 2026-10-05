import { and, asc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { Hex } from "viem";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { activityAccess } from "../activity/access.ts";
import { anchors, facilitatorSettlements, generations } from "../db/schema.ts";
import { ApiError, fail } from "../lib/errors.ts";
import { picoToUsdString } from "../lib/money.ts";
import { sha256 } from "../lib/util.ts";
import { MerkleTree } from "../receipts/merkle.ts";
import { COSE_CONTENT_TYPE } from "../receipts/v2.ts";
import { refundReceipt } from "../services/makegood.ts";
import { makegoodRefunds } from "../services/makegood-schema.ts";
import { readStatement } from "../statements/read.ts";
import { summarizeLanes } from "../lane-report/read.ts";

// U100: a proof pack. One JSON file for a date range that anyone can check with no network: the account's calls with
// their signed receipts (the same objects GET /api/v1/receipts/:id serves, with their Merkle paths), the refund receipts
// issued in the range, the signed monthly statements covering it, the router's published receipt keys and a manifest the
// router signs over exactly which receipts it listed, with a lane report of those calls (src/lane-report/read.ts). It reads
// existing records only and keeps nothing. Receipts carry hashes, buckets and amounts, never prompt or answer text, and
// nothing else in the pack is read from a request.

export const PROOF_PACK_TYPE = "anyroute.proof-pack.v1";
export const PROOF_PACK_MANIFEST_TYPE = "anyroute.proof-pack.manifest.v1";
/** Per file: days in the range, calls, distinct anchor trees rebuilt for Merkle paths, refund receipts. Packs per key per minute. */
export const PROOF_PACK_LIMITS = { maxDays: 31, maxCalls: 2000, maxAnchors: 200, maxRefunds: 1000, perMinute: 10 } as const;
const DAY_MS = 86_400_000;

const date = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
const cursorShape = z.strictObject({ at: instant, id: z.string().min(1).max(512), part: z.number().int().min(2).max(100_000), filter: z.string().length(64) });
export type ProofPackCursor = z.infer<typeof cursorShape>;

const day = (v: string | undefined, name: string) => {
  const parsed = v === undefined ? null : date.safeParse(v);
  if (!parsed?.success || new Date(`${parsed.data}T00:00:00.000Z`).toISOString().slice(0, 10) !== parsed.data) fail(400, `Give ${name} as a calendar date in YYYY-MM-DD format (UTC).`, "invalid_request");
  return new Date(`${parsed.data}T00:00:00.000Z`);
};

/** from and to are UTC calendar dates, both included. Over PROOF_PACK_LIMITS.maxDays answers 413. */
export function proofPackQuery(q: Record<string, string | undefined>, now = new Date()) {
  const from = day(q.from, "from");
  const last = day(q.to, "to");
  if (last < from) fail(400, "from must be on or before to.", "invalid_request");
  if (from > now) fail(400, "This range starts in the future.", "invalid_request");
  const days = Math.round((last.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days > PROOF_PACK_LIMITS.maxDays) fail(413, `A proof pack covers at most ${PROOF_PACK_LIMITS.maxDays} days; this range has ${days}. Choose a shorter range.`, "range_too_large", { max_days: PROOF_PACK_LIMITS.maxDays, days });
  let cursor: ProofPackCursor | undefined;
  if (q.cursor !== undefined) try {
    if (q.cursor.length > 1500 || !/^[\w-]+$/.test(q.cursor)) throw new Error();
    cursor = cursorShape.parse(JSON.parse(Buffer.from(q.cursor, "base64url").toString()));
  } catch { fail(400, "Invalid proof pack cursor.", "invalid_request"); }
  return { from, toExclusive: new Date(last.getTime() + DAY_MS), fromDay: q.from!, toDay: q.to!, days, cursor };
}
export type ProofPackQuery = ReturnType<typeof proofPackQuery>;

/** What GET /api/v1/proof-pack/limits answers: the caps, and whether this key reads the account or only itself. */
export async function proofPackLimits(ctx: Ctx, key: KeyRow) {
  const { whole } = await activityAccess(ctx, key);
  return { max_days: PROOF_PACK_LIMITS.maxDays, max_calls: PROOF_PACK_LIMITS.maxCalls, max_anchors: PROOF_PACK_LIMITS.maxAnchors, max_refunds: PROOF_PACK_LIMITS.maxRefunds, per_minute: PROOF_PACK_LIMITS.perMinute, scope: whole ? "account" : "key", type: PROOF_PACK_TYPE };
}

type CallRow = {
  id: string; at: string; key_hash: string | null; model_id: string; provider_id: string; mode: string; cost: string; cancelled: boolean; lane: string | null;
  receipt: Record<string, unknown> | null; receipt_sig: string | null; receipt_key_id: string | null; receipt_leaf: string | null; anchor_index: number | null; leaf_index: number | null;
  receipt_v2: Record<string, unknown> | null; receipt_cose: string | null; receipt_leaf_v2: string | null; leaf_index_v2: number | null;
};
const rowsOf = <T>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? r) as T[];

/**
 * The anchor trees these receipts sit in, each rebuilt once. Mirrors anchorTree in src/api/generation.ts (generation v1 and
 * v2 leaves at their stored positions, then facilitator settlement leaves), which rebuilds the tree on every anchorProof call.
 */
async function anchorTrees(ctx: Ctx, indexes: number[]) {
  const out = new Map<number, { anchor: typeof anchors.$inferSelect; tree: MerkleTree }>();
  if (!indexes.length) return out;
  for (const anchor of await ctx.db.select().from(anchors).where(inArray(anchors.index, indexes))) {
    const rows = await ctx.db
      .select({ leaf: generations.receiptLeaf, leafIndex: generations.leafIndex, leafV2: generations.receiptLeafV2, leafIndexV2: generations.leafIndexV2 })
      .from(generations).where(eq(generations.anchorIndex, anchor.index)).orderBy(asc(generations.leafIndex));
    const leaves: Hex[] = [];
    for (const r of rows) {
      if (r.leafIndex != null) leaves[r.leafIndex] = r.leaf as Hex;
      if (r.leafIndexV2 != null && r.leafV2) leaves[r.leafIndexV2] = r.leafV2 as Hex;
    }
    const settled = await ctx.db.select({ leaf: facilitatorSettlements.receiptLeaf, leafIndex: facilitatorSettlements.leafIndex }).from(facilitatorSettlements).where(eq(facilitatorSettlements.anchorIndex, anchor.index));
    for (const s of settled) if (s.leafIndex != null && s.leaf) leaves[s.leafIndex] = s.leaf as Hex;
    try {
      out.set(anchor.index, { anchor, tree: new MerkleTree(leaves) });
    } catch {
      /* an anchor whose leaves cannot be rebuilt gives no path; its receipts still carry their signatures */
    }
  }
  return out;
}

function monthsOf(from: Date, toExclusive: Date) {
  const months: string[] = [];
  for (const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)); d < toExclusive; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
  return months;
}

const LIMITS = [
  "Calls are listed by call time in UTC and refunds by issue time. Statements cover each whole calendar month the range touches.",
  "Receipts carry hashes, token-count buckets and amounts. This pack holds no prompt or answer text.",
  "A Merkle path is present once the receipt's hour has been rooted. A path shows inclusion under a root; whether that root was posted on chain is checked against the ReceiptAnchor contract, not by this file.",
  "The manifest signature is the router's statement of which receipts it listed for this range and scope. It is not an independent audit of the router's records.",
  "Keys are the router's published receipt keys at download time. Pin them independently against /.well-known/anyroute-receipt-keys.json or the ReceiptAnchor contract.",
  "The lane report counts the calls in this file by the lane each receipt records. The attested and unlinkable lanes ran on proven hardware; each provider row links to that provider's attestation record.",
];
const VERIFY = {
  script: "scripts/verify-proof-pack.mjs",
  command: "node verify-proof-pack.mjs anyroute-proof-pack.json",
  steps: [
    "Save this file and the verifier script scripts/verify-proof-pack.mjs from the Anyroute source. It needs Node 18 or later and no packages or network.",
    "Run: node verify-proof-pack.mjs <this file>. It exits 0 only when every check passes.",
    "It checks that each key id matches its key bytes, every receipt, refund receipt, statement and manifest signature against the keys in this file, every receipt's anchor leaf, every Merkle path present, each statement's arithmetic, that the lane report adds up and matches the calls (and each call's lane, provider and model match its signed receipt), and that the signed manifest lists exactly the receipts in this file.",
    "One receipt at a time can also be checked in a browser at /verify/.",
  ],
};

/** Build one file of a proof pack. A range with more calls than one file holds is split; next_cursor asks for the next part. */
export async function readProofPack(ctx: Ctx, key: KeyRow, q: ProofPackQuery, now = new Date()) {
  const { whole } = await activityAccess(ctx, key); // the Activity and statement scope rule, unchanged
  const scope = whole ? "account" : "key";
  const filter = sha256(JSON.stringify({ account: key.accountId, key: whole ? null : key.keyHash, from: q.fromDay, to: q.toDay }));
  if (q.cursor && q.cursor.filter !== filter) fail(400, "Cursor does not match this range or this key's access.", "invalid_request");
  const part = q.cursor?.part ?? 1;
  const from = q.from.toISOString(), to = q.toExclusive.toISOString();

  // Calls: the same rows Activity lists as calls (src/activity/read.ts), oldest first, one more than fits to see truncation.
  const after = q.cursor ? sql`and (g.ts, g.id collate "C") > (${q.cursor.at}::timestamptz, ${q.cursor.id}::text collate "C")` : sql``;
  const raw = rowsOf<CallRow>(await ctx.db.execute(sql`
    select g.id, to_char(g.ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at, g.key_hash, g.model_id, g.provider_id, g.mode, g.cost::text cost, g.cancelled,
      coalesce(g.receipt->>'lane', g.receipt_v2->>'lane') lane, g.receipt, g.receipt_sig, g.receipt_key_id, g.receipt_leaf, g.anchor_index, g.leaf_index,
      g.receipt_v2, g.receipt_cose, g.receipt_leaf_v2, g.leaf_index_v2
    from generations g left join keys k on k.key_hash = g.key_hash
    where ((k.account_id = ${key.accountId} and (${whole} or k.key_hash = ${key.keyHash})) or (${whole} and g.account_id = ${key.accountId}))
      and (g.account_id is null or g.account_id = ${key.accountId})
      and g.ts >= ${from}::timestamptz and g.ts < ${to}::timestamptz ${after}
    order by g.ts, g.id collate "C" limit ${PROOF_PACK_LIMITS.maxCalls + 1}`));
  let truncated = raw.length > PROOF_PACK_LIMITS.maxCalls;
  const rows = raw.slice(0, PROOF_PACK_LIMITS.maxCalls);
  // Each anchor's tree is rebuilt from all of its leaves, so a file rebuilds at most maxAnchors of them.
  const seen = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i].anchor_index;
    if (a == null || seen.has(a)) continue;
    if (seen.size >= PROOF_PACK_LIMITS.maxAnchors) { rows.length = i; truncated = true; break; }
    seen.add(a);
  }
  const trees = await anchorTrees(ctx, [...seen]);
  // The same shape as anchorProof in src/api/generation.ts.
  const proofOf = (index: number | null, leafIndex: number | null) => {
    const t = index == null || leafIndex == null ? undefined : trees.get(index);
    if (!t || leafIndex == null) return null;
    const a = t.anchor;
    let proof: Hex[];
    try {
      proof = t.tree.proof(leafIndex);
    } catch {
      return null; // a stored position outside its tree gives no path rather than failing the whole file
    }
    return { root: a.root, index: a.index, leaf_index: leafIndex, proof, from: a.fromTs.toISOString(), to: a.toTs.toISOString(), tx: a.txHash, status: a.status, chain: ctx.cfg.chain.id, contract: ctx.cfg.chain.receiptAnchor ?? null };
  };
  // Each receipt is the object GET /api/v1/receipts/:id serves, without its derived privacy label.
  const calls = rows.map((r) => ({
    id: r.id, at: r.at, key_hash: r.key_hash, model: r.model_id, provider: r.provider_id, mode: r.mode, lane: r.lane, cost: picoToUsdString(BigInt(r.cost)), currency: "USDG", cancelled: r.cancelled,
    receipt: r.receipt_sig || r.receipt_cose ? {
      id: r.id, version: r.receipt_cose ? 2 : 1, payload: r.receipt, sig: r.receipt_sig, key_id: r.receipt_key_id, leaf: r.receipt_leaf, anchor: proofOf(r.anchor_index, r.leaf_index),
      v2: r.receipt_cose ? { alg: "EdDSA", kid: r.receipt_key_id, content_type: COSE_CONTENT_TYPE, cose: r.receipt_cose, claims: r.receipt_v2, leaf: r.receipt_leaf_v2, anchor: proofOf(r.anchor_index, r.leaf_index_v2) } : null,
    } : null,
  }));
  // The lane report of exactly these calls; the verifier recomputes it from the list.
  const laneReport = { covers: "calls_in_this_file", ...summarizeLanes(rows.map((r) => ({ lane: r.lane, provider: r.provider_id, model: r.model_id, calls: 1, pico: BigInt(r.cost) }))) };
  const last = rows.at(-1);
  const nextCursor = truncated && last ? Buffer.from(JSON.stringify({ at: last.at, id: last.id, part: part + 1, filter })).toString("base64url") : null;

  // Refund receipts issued in the range, with the /api/v1/refunds scope rule; each in the shape GET /api/v1/receipts/:id serves.
  const refundScope = whole ? eq(makegoodRefunds.accountId, key.accountId) : and(eq(makegoodRefunds.accountId, key.accountId), eq(makegoodRefunds.keyHash, key.keyHash));
  const refundIds = await ctx.db.select({ id: makegoodRefunds.id }).from(makegoodRefunds)
    .where(and(refundScope, eq(makegoodRefunds.status, "issued"), isNotNull(makegoodRefunds.receiptSig), gte(makegoodRefunds.issuedAt, q.from), lt(makegoodRefunds.issuedAt, q.toExclusive)))
    .orderBy(asc(makegoodRefunds.issuedAt), asc(makegoodRefunds.id)).limit(PROOF_PACK_LIMITS.maxRefunds + 1);
  if (refundIds.length > PROOF_PACK_LIMITS.maxRefunds) fail(413, `This range holds more than ${PROOF_PACK_LIMITS.maxRefunds} refund receipts. Choose a shorter range.`, "too_many_items", { max_refunds: PROOF_PACK_LIMITS.maxRefunds });
  const refunds: NonNullable<Awaited<ReturnType<typeof refundReceipt>>>[] = [];
  for (const { id } of refundIds) {
    const receipt = await refundReceipt(ctx, id);
    if (receipt) refunds.push(receipt);
  }

  // The signed monthly statements covering the range (readStatement applies its own scope and existence rules).
  const statements: Awaited<ReturnType<typeof readStatement>>[] = [];
  const unavailable: { month: string; status: number; reason: string }[] = [];
  for (const month of monthsOf(q.from, q.toExclusive)) {
    try {
      statements.push(await readStatement(ctx, key, month, now));
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      unavailable.push({ month, status: e.status, reason: e.message });
    }
  }

  const keys = await ctx.signer.jwks();
  const range = { from: q.fromDay, to: q.toDay, from_ts: from, to_exclusive: to, days: q.days, so_far: q.toExclusive > now, time_zone: "UTC" };
  const manifest = {
    type: PROOF_PACK_MANIFEST_TYPE, router: ctx.cfg.publicUrl, generated_at: now.toISOString(), range, scope, key_hash: whole ? null : key.keyHash,
    part, after: q.cursor ? { at: q.cursor.at, id: q.cursor.id } : null, truncated, next_cursor: nextCursor,
    calls: calls.map((c) => ({ id: c.id, leaf: c.receipt?.leaf ?? null, leaf_v2: c.receipt?.v2?.leaf ?? null })),
    refunds: refunds.map((r) => ({ id: r.id, leaf: r.leaf ?? null })),
    statements: statements.map((s) => ({ month: s.payload.month, key_id: s.key_id, sig: s.sig })),
    key_ids: keys.keys.map((k) => k.kid),
    lane_report: laneReport,
  };
  const signed = ctx.signer.sign(manifest);
  const receipts = calls.filter((c) => c.receipt);
  return {
    type: PROOF_PACK_TYPE, version: 1, generated_at: manifest.generated_at, router: manifest.router, range, scope, key_hash: manifest.key_hash,
    part, truncated, next_cursor: nextCursor,
    counts: {
      calls: calls.length, receipts: receipts.length, without_receipt: calls.length - receipts.length, v2_receipts: receipts.filter((c) => c.receipt!.v2).length,
      merkle_paths: receipts.reduce((n, c) => n + (c.receipt!.anchor ? 1 : 0) + (c.receipt!.v2?.anchor ? 1 : 0), 0), refunds: refunds.length, statements: statements.length,
    },
    calls, lane_report: laneReport, refunds, statements, statements_unavailable: unavailable, keys,
    manifest: { payload: manifest, alg: "Ed25519", key_id: signed.keyId, sig: signed.sig },
    limits: LIMITS, verify: VERIFY,
  };
}
