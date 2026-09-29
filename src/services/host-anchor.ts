import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { keccak256, toBytes, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { ReceiptAnchorAbi } from "../chain/abis.ts";
import { hostAnchorLeaves, hostAnchors, providers } from "../db/schema.ts";
import { boundedJson, providerFetch } from "../providers/network.ts";
import { loadTlsPins, type TlsPin } from "../providers/tls-pin.ts";
import { MerkleTree, receiptLeaf } from "../receipts/merkle.ts";
import { canonicalBytes, verifyWithRawKey } from "../receipts/signer.ts";
import { log, sha256 } from "../lib/util.ts";
import { normalizeSidecarReport, parseTdxQuote } from "./attestor.ts";
import { bindingsCommittedIn } from "./measurements.ts";

// Per-host anchoring of enclave receipts (spec 0004 Section 5.2). Off unless HOST_ANCHOR_ENABLED.
//
// Every interval, for each attested host (a provider whose sidecar the attestor proved and pinned: its certificate
// names the SHA-256 of a boot quote that verified, and that quote binds the certificate's key), the job:
//   1. reads the host's boot /attest document over the pinned connection and takes the receipt key from its bindings,
//      but only if SHA-256 of the quote it serves is the attestation reference the router verified and the quote's
//      report_data commits to those bindings. That key is the receipt key bound in the router-verified attestation;
//   2. pulls the sidecar's queued receipt leaves (GET /anchor/leaves, the host's anchor token) and keeps a leaf only
//      if its receipt verifies under that key, names that attestation reference, is not marked simulated, and its
//      leaf recomputes from the signed bytes. Every other leaf is discarded and counted;
//   3. builds one Merkle tree (the router anchor's tree: sorted-pair keccak256, OpenZeppelin MerkleProof) over the
//      new leaves, in the order the sidecar queued them, and stores the root with the attestation reference and key;
//   4. acknowledges what it pulled (POST /anchor/ack), so the sidecar drops it;
//   5. posts the root with ReceiptAnchor.anchorAttested(keccak256(provider id), root, attestation reference) where a
//      chain and the anchorer key are configured. Otherwise the root is kept off chain with status "local", exactly
//      like the router's own hourly roots, and proofs say anchored: false.
// A root covers the leaves collected from one host, under one attestation, in [from_ts, to_ts): from the previous
// root's end to the moment this one was built. Like any anchor it proves inclusion, not a receipt's time or that it is
// unique, and leaves a host withholds from its feed are not covered.

export const HOST_ANCHOR_PAGE = 1000; // the sidecar's largest page
const MAX_PAGES = 200; // at most 200 000 leaves per host per run; the rest wait for the next run
const RID = /^rcpt_[0-9a-f]{24}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export type SidecarReceipt = { payload: Record<string, unknown>; sig: string; key_id: string; alg: string; leaf: string };
export type QueuedLeaf = { seq: number; leaf: string; id: string; ts: number; receipt: SidecarReceipt };
/** The receipt key bound in a host's router-verified attestation. */
export type HostBinding = { attestationRef: string; receiptPublicKey: string; receiptKeyId: string };

/** A host's sidecar, as the job talks to it. The default goes over the provider's pinned connection. */
export type LeafFeed = {
  /** The boot attestation document (GET /attest, no nonce). */
  attest(): Promise<unknown>;
  pull(afterSeq: number, limit: number): Promise<{ leaves: QueuedLeaf[]; head: number }>;
  ack(throughSeq: number): Promise<void>;
};

/** Where roots are posted. The default calls ReceiptAnchor.anchorAttested with the anchorer key. */
export type AttestedAnchorChain = {
  configured(): boolean;
  anchorAttested(providerId: Hex, root: Hex, attestationRef: Hex): Promise<{ hash: Hex; blockNumber: number | null; index: number | null }>;
};

export type HostAnchorOptions = {
  chain?: AttestedAnchorChain;
  feed?: (provider: typeof providers.$inferSelect, pin: TlsPin, token: string) => LeafFeed;
};

/** The sidecar's key id: the first 16 hex characters of SHA-256 of the raw public key. */
export const sidecarKeyId = (publicKeyHex: string) => sha256(Buffer.from(publicKeyHex, "hex")).slice(0, 16);

/** The on-chain provider id: keccak256 of the provider id's bytes, as the other contracts use it. */
export const providerIdHash = (providerId: string) => keccak256(toBytes(providerId));

/**
 * The receipt key a host's boot document binds, accepted only if the document's quote is the one the router verified
 * (its SHA-256 is the pinned attestation reference) and that quote's report_data commits to the bindings.
 */
export function bindingFromBootDocument(verifiedRef: string, document: unknown): { ok: true; binding: HostBinding } | { ok: false; reason: string } {
  if (!HEX64.test(verifiedRef)) return { ok: false, reason: "the router holds no verified attestation reference for this host" };
  if (!document || typeof document !== "object") return { ok: false, reason: "the attestation document is not an object" };
  const r = normalizeSidecarReport(document as Record<string, any>);
  if (r.type !== "anyroute.sidecar.attestation") return { ok: false, reason: "not a sidecar attestation document" };
  if (r.kind === "dev" || typeof r.intel_quote !== "string") return { ok: false, reason: "the document carries no hardware quote" };
  const quote = r.intel_quote.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(quote) || sha256(Buffer.from(quote, "hex")) !== verifiedRef) return { ok: false, reason: "the quote served is not the one the router verified" };
  let reportData: string;
  try {
    reportData = parseTdxQuote(quote).reportData;
  } catch (e) {
    return { ok: false, reason: `unparseable quote: ${(e as Error).message}` };
  }
  if (!bindingsCommittedIn(reportData, r.sidecar_bindings)) return { ok: false, reason: "the bindings are not committed in the verified quote" };
  const key = String((r.sidecar_bindings as Record<string, unknown>).receipt_pubkey ?? "").toLowerCase();
  if (!HEX64.test(key)) return { ok: false, reason: "the bindings carry no receipt key" };
  return { ok: true, binding: { attestationRef: verifiedRef, receiptPublicKey: key, receiptKeyId: sidecarKeyId(key) } };
}

/** Why a queued leaf is discarded, or null when it verifies under the host's bound receipt key. */
export function checkLeaf(item: unknown, b: HostBinding): string | null {
  const q = item as Partial<QueuedLeaf> | null;
  const env = q?.receipt as Partial<SidecarReceipt> | undefined;
  if (!env || typeof env !== "object" || typeof env.sig !== "string" || !env.payload || typeof env.payload !== "object") return "malformed";
  const p = env.payload;
  if (p.type !== "anyroute.sidecar.receipt" || typeof p.id !== "string" || !RID.test(p.id) || typeof p.ts !== "number" || !(p.ts > 0 && p.ts < 8.64e15)) return "malformed";
  if (env.alg !== "Ed25519" || env.key_id !== b.receiptKeyId) return "unbound_key";
  if (!verifyWithRawKey(p, env.sig, b.receiptPublicKey)) return "bad_signature";
  const leaf = receiptLeaf(canonicalBytes(p), Buffer.from(env.sig, "base64")).toLowerCase();
  if (leaf !== String(env.leaf ?? "").toLowerCase() || leaf !== String(q?.leaf ?? "").toLowerCase()) return "leaf_mismatch";
  if (p.attestation_ref !== b.attestationRef) return "other_attestation";
  if (p.dev !== false) return "simulated";
  return null;
}

/** The sidecar endpoint next to its /attest path (so a path prefix in front of the sidecar is kept). */
function sidecarUrl(attestationUrl: string, path: string) {
  const u = new URL(attestationUrl);
  u.search = "";
  u.pathname = u.pathname.endsWith("/attest") ? u.pathname.slice(0, -"/attest".length) + path : path;
  return u;
}

/** The provider's sidecar over the connection its attested certificate is pinned to. */
export function pinnedLeafFeed(ctx: Ctx, p: typeof providers.$inferSelect, pin: TlsPin, token: string): LeafFeed {
  const policy = { production: ctx.cfg.production, allowDevelopmentMockLoopback: !ctx.cfg.production, tlsPin: { certPem: pin.certPem, spkiSha256: pin.spkiSha256 } };
  const auth = { authorization: `Bearer ${token}`, accept: "application/json" };
  const call = async (url: URL, init: RequestInit = {}, maxBytes?: number) => {
    const res = await providerFetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000), ...init }, policy);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`${url.pathname} answered HTTP ${res.status}`);
    }
    return boundedJson(res, maxBytes);
  };
  return {
    attest: () => {
      const boot = new URL(p.attestationUrl!);
      boot.searchParams.delete("nonce");
      return call(boot, { headers: { accept: "application/json" } });
    },
    pull: async (after, limit) => {
      const url = sidecarUrl(p.attestationUrl!, "/anchor/leaves");
      url.searchParams.set("after", String(after));
      url.searchParams.set("limit", String(limit));
      const page = (await call(url, { headers: auth }, 16 * 1024 * 1024)) as { leaves?: unknown; head?: unknown };
      if (!Array.isArray(page?.leaves) || typeof page.head !== "number") throw new Error("the leaf feed answered with an unexpected shape");
      return { leaves: page.leaves as QueuedLeaf[], head: page.head };
    },
    ack: async (through) => {
      await call(sidecarUrl(p.attestationUrl!, "/anchor/ack"), { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ through_seq: through }) });
    },
  };
}

/** ReceiptAnchor.anchorAttested with the anchorer key, through ChainService's public surface. */
export function receiptAnchorChain(ctx: Ctx): AttestedAnchorChain {
  return {
    configured: () => !!(ctx.chain.address("receiptAnchor") && ctx.chain.roleAddress("anchorer")),
    async anchorAttested(providerId, root, attestationRef) {
      const address = ctx.chain.require("receiptAnchor");
      const w = ctx.chain.wallet("anchorer");
      const { request } = await ctx.chain.client.simulateContract({ account: w.account, address, abi: ReceiptAnchorAbi, functionName: "anchorAttested", args: [providerId, root, attestationRef] } as never);
      const hash = await w.writeContract(request as never);
      const receipt = await ctx.chain.client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted.`);
      let index: number | null = null;
      for (const l of receipt.logs) {
        const d = l.address.toLowerCase() === address.toLowerCase() ? ctx.chain.decode("receiptAnchor", l as never) : null;
        if (d?.event === "AttestedAnchored") index = Number(d.args.index as bigint);
      }
      return { hash, blockNumber: receipt.blockNumber == null ? null : Number(receipt.blockNumber), index };
    },
  };
}

async function post(ctx: Ctx, chain: AttestedAnchorChain, a: { id: number; providerId: string; root: string; attestationRef: string }) {
  try {
    const r = await chain.anchorAttested(providerIdHash(a.providerId), a.root as Hex, `0x${a.attestationRef}` as Hex);
    await ctx.db.update(hostAnchors).set({ status: "confirmed", txHash: r.hash, blockNumber: r.blockNumber, chainIndex: r.index }).where(eq(hostAnchors.id, a.id));
    return { status: "confirmed" as const, tx: r.hash, block: r.blockNumber, anchor_index: r.index };
  } catch (e) {
    log.error("host anchor submission failed; will retry", { root: a.id, provider: a.providerId, error: (e as Error).message });
    return { status: "pending" as const, tx: null, block: null, anchor_index: null };
  }
}

/** Collect, verify, root and (where configured) post one host's leaves. */
export async function anchorHost(ctx: Ctx, p: typeof providers.$inferSelect, pin: TlsPin, feed: LeafFeed, chain: AttestedAnchorChain) {
  let document: unknown;
  try {
    document = await feed.attest();
  } catch (e) {
    return { skipped: `attestation document unreachable: ${(e as Error).message}` };
  }
  const bound = bindingFromBootDocument(pin.attestationRef, document);
  if (!bound.ok) return { skipped: bound.reason };
  const b = bound.binding;

  const collectedFrom = new Date();
  const kept: { leaf: string; id: string; ts: number }[] = [];
  const discarded: Record<string, number> = {};
  const seen = new Set<string>();
  let after = 0;
  let pulled = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await feed.pull(after, HOST_ANCHOR_PAGE);
    let advanced = false;
    for (const item of r.leaves) {
      const seq = Number((item as Partial<QueuedLeaf>)?.seq);
      if (!Number.isSafeInteger(seq) || seq <= after) continue; // never move the cursor backwards
      after = seq;
      advanced = true;
      pulled++;
      const reason = checkLeaf(item, b);
      if (reason) {
        discarded[reason] = (discarded[reason] ?? 0) + 1;
        continue;
      }
      const leaf = item.leaf.toLowerCase();
      if (seen.has(leaf)) continue;
      seen.add(leaf);
      kept.push({ leaf, id: item.receipt.payload.id as string, ts: item.receipt.payload.ts as number });
    }
    if (!advanced || r.leaves.length < HOST_ANCHOR_PAGE || after >= r.head) break;
  }
  if (Object.keys(discarded).length) log.warn("host anchor discarded leaves", { provider: p.id, discarded });

  // A leaf already rooted (an earlier acknowledgement did not reach the sidecar) is not rooted twice.
  const known = new Set<string>();
  for (let i = 0; i < kept.length; i += 1000) {
    const rows = await ctx.db
      .select({ leaf: hostAnchorLeaves.leaf })
      .from(hostAnchorLeaves)
      .where(and(eq(hostAnchorLeaves.providerId, p.id), inArray(hostAnchorLeaves.leaf, kept.slice(i, i + 1000).map((k) => k.leaf))));
    for (const r of rows) known.add(r.leaf);
  }
  const fresh = kept.filter((k) => !known.has(k.leaf));

  let root: { id: number; root: string; count: number; window: { from: string; to: string } } | null = null;
  if (fresh.length) {
    const tree = new MerkleTree(fresh.map((k) => k.leaf as Hex));
    const [last] = await ctx.db.select({ toTs: hostAnchors.toTs }).from(hostAnchors).where(eq(hostAnchors.providerId, p.id)).orderBy(desc(hostAnchors.toTs)).limit(1);
    // Half-open and non-overlapping: this root starts where the host's last one ended, and every leaf in it was
    // collected at or after that and before its end.
    const fromTs = last?.toTs ?? collectedFrom;
    const collectedAt = new Date(Math.max(collectedFrom.getTime(), fromTs.getTime()));
    const toTs = new Date(Math.max(Date.now(), collectedAt.getTime() + 1));
    const id = await ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(hostAnchors)
        .values({ providerId: p.id, attestationRef: b.attestationRef, receiptKeyId: b.receiptKeyId, receiptPublicKey: b.receiptPublicKey, root: tree.root, fromTs, toTs, count: fresh.length, status: chain.configured() ? "pending" : "local" })
        .returning({ id: hostAnchors.id });
      for (let i = 0; i < fresh.length; i += 1000)
        await tx.insert(hostAnchorLeaves).values(fresh.slice(i, i + 1000).map((k, j) => ({ providerId: p.id, leaf: k.leaf, anchorId: row.id, leafIndex: i + j, receiptId: k.id, receiptTs: new Date(k.ts), collectedAt })));
      return row.id;
    });
    root = { id, root: tree.root, count: fresh.length, window: { from: fromTs.toISOString(), to: toTs.toISOString() } };
  }

  // Everything pulled is now either rooted or discarded, so the sidecar may drop it.
  let acked = false;
  if (pulled) {
    try {
      await feed.ack(after);
      acked = true;
    } catch (e) {
      log.warn("host anchor acknowledgement failed; the leaves are pulled again next time", { provider: p.id, error: (e as Error).message });
    }
  }

  const base = { attestation_ref: b.attestationRef, receipt_key_id: b.receiptKeyId, pulled, rooted: fresh.length, discarded, acked };
  if (!root) return { ...base, root: null };
  const onchain = chain.configured() ? await post(ctx, chain, { id: root.id, providerId: p.id, root: root.root, attestationRef: b.attestationRef }) : null;
  return { ...base, root: { ...root, ...(onchain ?? { status: "local", tx: null, block: null, anchor_index: null }) } };
}

/** Roots built while the chain was unreachable. Attested anchors have no ordering rule, so each is retried alone. */
export async function retryHostAnchors(ctx: Ctx, chain: AttestedAnchorChain = receiptAnchorChain(ctx)) {
  if (!chain.configured()) return { retried: 0 };
  const rows = await ctx.db.select().from(hostAnchors).where(eq(hostAnchors.status, "pending")).orderBy(hostAnchors.id).limit(100);
  let retried = 0;
  for (const a of rows) if ((await post(ctx, chain, a)).status === "confirmed") retried++;
  return { retried };
}

/** The `host-anchor` job: every attested host with a pinned certificate and an anchor token, then retries. */
export async function runHostAnchor(ctx: Ctx, opts: HostAnchorOptions = {}) {
  const chain = opts.chain ?? receiptAnchorChain(ctx);
  const makeFeed = opts.feed ?? ((p, pin, token) => pinnedLeafFeed(ctx, p, pin, token));
  const retry = await retryHostAnchors(ctx, chain);
  const pins = await loadTlsPins(ctx.db);
  const rows = await ctx.db.select().from(providers).where(and(inArray(providers.status, ["shadow", "live"]), isNotNull(providers.attestationUrl))).orderBy(providers.id);
  const hosts: Record<string, unknown> = {};
  for (const p of rows) {
    const pin = pins.get(p.id);
    // Only a sidecar the attestor proved has a certificate pin (an attested gateway's key-only pin is not one).
    if (!pin || !pin.certPem || pin.spkiOnly) continue;
    const token = ctx.cfg.hostAnchor.tokens[p.id];
    if (!p.attested) hosts[p.id] = { skipped: "not attested now" };
    // The pin only binds an https connection; the anchor token never goes anywhere else.
    else if (!p.attestationUrl!.startsWith("https://")) hosts[p.id] = { skipped: "the attestation endpoint is not https" };
    else if (!token) hosts[p.id] = { skipped: "no anchor token configured for this host" };
    else {
      try {
        hosts[p.id] = await anchorHost(ctx, p, pin, makeFeed(p, pin, token), chain);
      } catch (e) {
        log.error("host anchor failed", { provider: p.id, error: (e as Error).message });
        hosts[p.id] = { error: (e as Error).message };
      }
    }
  }
  return { hosts, ...retry };
}

// ---- Proofs ------------------------------------------------------------------------------------------------

const trees = new Map<string, MerkleTree>();

async function hostTree(ctx: Ctx, anchor: { id: number; root: string }) {
  const key = `${anchor.id}:${anchor.root}`;
  const hit = trees.get(key);
  if (hit) return hit;
  const rows = await ctx.db.select({ leaf: hostAnchorLeaves.leaf, leafIndex: hostAnchorLeaves.leafIndex }).from(hostAnchorLeaves).where(eq(hostAnchorLeaves.anchorId, anchor.id)).orderBy(hostAnchorLeaves.leafIndex);
  const tree = new MerkleTree(rows.map((r) => r.leaf as Hex));
  if (tree.root.toLowerCase() !== anchor.root.toLowerCase()) throw new Error(`host anchor ${anchor.id} does not rebuild to its stored root`);
  trees.set(key, tree);
  if (trees.size > 32) trees.delete(trees.keys().next().value as string);
  return tree;
}

/** The leaf of a sidecar receipt envelope, or null when the envelope is malformed. */
export function leafOfReceipt(receipt: unknown): string | null {
  const r = receipt as Partial<SidecarReceipt> | null;
  if (!r || typeof r !== "object" || !r.payload || typeof r.payload !== "object" || typeof r.sig !== "string") return null;
  return receiptLeaf(canonicalBytes(r.payload), Buffer.from(r.sig, "base64")).toLowerCase();
}

/** Everything a verifier needs for one collected leaf, or null when no host root holds it. */
export async function hostAnchorProof(ctx: Ctx, leaf: string) {
  const [l] = await ctx.db.select().from(hostAnchorLeaves).where(eq(hostAnchorLeaves.leaf, leaf.toLowerCase())).limit(1);
  if (!l) return null;
  const [a] = await ctx.db.select().from(hostAnchors).where(eq(hostAnchors.id, l.anchorId));
  if (!a) return null;
  const tree = await hostTree(ctx, a);
  return {
    rid: l.receiptId,
    leaf: l.leaf,
    rooted: true,
    anchored: a.status === "confirmed" && !!a.txHash,
    status: a.status,
    provider: a.providerId,
    provider_id_hash: providerIdHash(a.providerId),
    attestation_ref: a.attestationRef,
    receipt_key: { key_id: a.receiptKeyId, public_key: a.receiptPublicKey },
    root_id: a.id,
    root: a.root,
    leaf_index: l.leafIndex,
    proof: tree.proof(l.leafIndex),
    count: a.count,
    window: { from: a.fromTs.toISOString(), to: a.toTs.toISOString() },
    anchor_index: a.chainIndex,
    tx: a.txHash,
    block: a.blockNumber,
    chain: ctx.cfg.chain.id,
    contract: ctx.cfg.chain.receiptAnchor ?? null,
  };
}
