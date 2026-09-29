import type { BoundIdentity } from "./attestation.js";
import { base64ToBytes, bytesToHex, hexToBytes, utf8 } from "./bytes.js";
import type { Ed25519Verifier } from "./ed25519.js";
import { keccak256Hex } from "./hash.js";
import { canonicalBytes, keyIdOf, receiptLeaf, verifyMerkleProof, verifyReceipt } from "./receipts.js";
import { verifySidecarReceipt } from "./sidecar.js";
import type { Check, Fetch, ReceiptEnvelope } from "./types.js";

// Per-host anchors of enclave receipts. The router collects each attested host's sidecar receipt leaves, keeps those
// signed by the receipt key the host's attestation binds, and roots them per host and interval; where it runs with a
// configured chain it posts each root with ReceiptAnchor.anchorAttested(keccak256(provider id), root, attestation
// reference). This checks a sidecar receipt against the proof the router returns for it, in the spec's order: the
// signature, then the Merkle path to the root, then (where the root was posted) the root on chain.

export const HOST_ANCHOR_PROOF_PATH = "/api/v1/host-anchors/proof";

/** The answer of GET /api/v1/host-anchors/proof/{leaf} and POST /api/v1/host-anchors/proof (`data`). */
export type HostAnchorProof = {
  rid?: string;
  leaf: string;
  rooted: boolean;
  /** True only when the root was posted on chain and confirmed. */
  anchored: boolean;
  /** "confirmed" (on chain), "pending" (to be posted) or "local" (kept off chain). */
  status: string;
  provider: string;
  /** keccak256 of the provider id's bytes: the providerId the root is posted under. */
  provider_id_hash: string;
  /** 64 hex: SHA-256 of the boot quote the router verified. */
  attestation_ref: string;
  /** The key the router checked every leaf of this root against: the one the host's quote binds. */
  receipt_key: { key_id: string; public_key: string };
  root_id?: number;
  root: string;
  leaf_index: number;
  proof: string[];
  count?: number;
  window?: { from: string; to: string };
  /** Index in ReceiptAnchor's attested anchors, once posted. */
  anchor_index: number | null;
  tx: string | null;
  block: number | null;
  chain?: number;
  contract?: string | null;
};

/** ReceiptAnchor.attestedAnchors(index), as 0x-prefixed hex. Null for an unknown index. */
export type AttestedAnchor = { providerId: string; root: string; attestationRef: string; anchoredAt: number };
export type AttestedAnchorReader = (index: number) => Promise<AttestedAnchor | null>;

export type VerifyHostAnchorOptions = {
  /**
   * The identity verifyProvider established for the host. With it the receipt is checked against what this client
   * verified itself (signature under the bound key, same attestation, same model digest, not simulated). Without it
   * the signature is checked under the key the proof names, which is the router's statement.
   */
  bound?: BoundIdentity;
  /** Reads ReceiptAnchor.attestedAnchors (readAttestedAnchor does it over JSON-RPC). Checks an anchored root on chain. */
  readAnchor?: AttestedAnchorReader;
  /** Fail unless the root is on chain and matches it. */
  requireOnChain?: boolean;
  /** The provider the client expects the root to name. */
  providerId?: string;
  ed25519?: Ed25519Verifier;
};

export type HostAnchorVerification = {
  /** No check failed, the signature and the inclusion passed and, with requireOnChain, the root is on chain. */
  valid: boolean;
  leaf: string | null;
  /** "match": the on-chain record equals the proof's root, provider and attestation; "off_chain": kept off chain. */
  onChain: "match" | "mismatch" | "off_chain" | "not_checked";
  checks: Check[];
  notChecked: string[];
};

const pass = (id: string, detail: string): Check => ({ id, status: "pass", detail });
const fail = (id: string, detail: string): Check => ({ id, status: "fail", detail });
const skip = (id: string, detail: string): Check => ({ id, status: "not_checked", detail });
const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");
const ZERO32 = "0x" + "00".repeat(32);

export const providerIdHash = (providerId: string) => keccak256Hex(utf8(providerId));

export async function verifyHostAnchor(receipt: ReceiptEnvelope, proof: HostAnchorProof, opts: VerifyHostAnchorOptions = {}): Promise<HostAnchorVerification> {
  const checks: Check[] = [];
  const notChecked = ["That the host put every receipt it signed in its leaf feed: an anchor covers only the leaves it was given."];
  const payload = (receipt?.payload ?? {}) as Record<string, unknown>;
  const p = (proof ?? {}) as Partial<HostAnchorProof>;

  // 1. Signature: under the key the client verified itself when it has one, else under the key the proof names.
  if (opts.bound) {
    const v = await verifySidecarReceipt(receipt, opts.bound, { ed25519: opts.ed25519 });
    checks.push(...v.checks.filter((c) => c.id !== "anchor_proof"));
    const boundId = await keyIdOf(hexToBytes(opts.bound.receiptPubkey)).catch(() => "");
    checks.push(boundId && boundId === p.receipt_key?.key_id ? pass("host.receipt_key", "the router rooted this leaf under the key your attestation check bound") : fail("host.receipt_key", "The proof names a different receipt key than the attestation you verified binds."));
  } else if (typeof p.receipt_key?.public_key === "string") {
    const v = await verifyReceipt(receipt, { publicKeyHex: p.receipt_key.public_key, ed25519: opts.ed25519 });
    checks.push(...v.checks.filter((c) => c.id !== "anchor_proof"));
    checks.push(p.receipt_key.key_id === receipt?.key_id ? pass("host.receipt_key", `signed by ${receipt.key_id}, the key the proof names`) : fail("host.receipt_key", "The receipt names a different key than the proof."));
    notChecked.push("That the proof's receipt key is the one the host's quote binds: pass `bound` from verifyProvider to check it yourself.");
  } else {
    checks.push(fail("signature", "No key to check the signature: pass `bound`, or a proof that names its receipt key."));
  }

  // 2. The leaf this receipt makes, and that it is the leaf the proof is for.
  let leaf: string | null = null;
  try {
    leaf = receiptLeaf(canonicalBytes(payload), base64ToBytes(String(receipt?.sig ?? "")));
  } catch {
    leaf = null;
  }
  checks.push(leaf && leaf === lower(p.leaf) ? pass("host.leaf", "the proof is for this receipt's leaf") : fail("host.leaf", "The proof is for a different leaf than this receipt makes."));
  checks.push(payload.attestation_ref === p.attestation_ref ? pass("host.attestation_ref", "the root was built under the attestation this receipt names") : fail("host.attestation_ref", "The root was built under a different attestation than the receipt names."));
  const expectedHash = typeof p.provider === "string" ? providerIdHash(opts.providerId ?? p.provider) : "";
  if (opts.providerId && p.provider !== opts.providerId) checks.push(fail("host.provider", `The proof names provider ${String(p.provider)}, not ${opts.providerId}.`));
  else checks.push(expectedHash && expectedHash === lower(p.provider_id_hash) ? pass("host.provider", `rooted for provider ${p.provider}`) : fail("host.provider", "The proof's provider id hash is not keccak256 of its provider id."));

  // 3. The Merkle path from the leaf to the root.
  const included = !!leaf && Array.isArray(p.proof) && typeof p.root === "string" && verifyMerkleProof(leaf, p.proof, p.root);
  checks.push(included ? pass("host.inclusion", `leaf is under root ${String(p.root).slice(0, 10)}…`) : fail("host.inclusion", "The Merkle path does not lead from this receipt's leaf to the root."));

  // 4. The root on chain, where it was posted.
  let onChain: HostAnchorVerification["onChain"] = "not_checked";
  if (!p.anchored) {
    onChain = "off_chain";
    const detail = `The root is kept off chain (status ${String(p.status)}): until it is posted it is only the router's statement.`;
    checks.push(opts.requireOnChain ? fail("host.onchain", detail) : skip("host.onchain", detail));
  } else if (!opts.readAnchor || typeof p.anchor_index !== "number") {
    const detail = opts.readAnchor ? "The proof says anchored but gives no anchor index." : "Pass readAnchor to compare the root with ReceiptAnchor on chain.";
    checks.push(opts.requireOnChain || opts.readAnchor ? fail("host.onchain", detail) : skip("host.onchain", detail));
  } else {
    try {
      const onchain = await opts.readAnchor(p.anchor_index);
      const same = !!onchain && lower(onchain.root) === lower(p.root) && lower(onchain.attestationRef) === "0x" + lower(p.attestation_ref) && lower(onchain.providerId) === lower(p.provider_id_hash);
      onChain = same ? "match" : "mismatch";
      checks.push(same ? pass("host.onchain", `ReceiptAnchor attested anchor ${p.anchor_index} holds this root for this provider and attestation`) : fail("host.onchain", onchain ? "The on-chain anchor holds a different root, provider or attestation." : `ReceiptAnchor has no attested anchor ${p.anchor_index}.`));
    } catch (e) {
      checks.push(fail("host.onchain", `Reading the on-chain anchor failed: ${(e as Error).message}`));
    }
  }

  const status = (id: string) => checks.find((c) => c.id === id)?.status;
  const valid = checks.every((c) => c.status !== "fail") && status("signature") === "pass" && status("host.inclusion") === "pass" && (!opts.requireOnChain || onChain === "match");
  return { valid, leaf, onChain, checks, notChecked };
}

/** The proof for a sidecar receipt (or its leaf) from a router. */
export async function fetchHostAnchorProof(baseUrl: string, receiptOrLeaf: ReceiptEnvelope | string, fetchImpl: Fetch = fetch, signal?: AbortSignal): Promise<HostAnchorProof | null> {
  const base = baseUrl.replace(/\/$/, "");
  const res =
    typeof receiptOrLeaf === "string"
      ? await fetchImpl(`${base}${HOST_ANCHOR_PROOF_PATH}/${receiptOrLeaf}`, { signal, headers: { accept: "application/json" } })
      : await fetchImpl(`${base}${HOST_ANCHOR_PROOF_PATH}`, { method: "POST", signal, headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ receipt: receiptOrLeaf }) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${HOST_ANCHOR_PROOF_PATH} failed with ${res.status}`);
  return ((await res.json()) as { data: HostAnchorProof }).data;
}

/**
 * A reader for ReceiptAnchor.attestedAnchors(index) over Ethereum JSON-RPC (eth_call), with no library: point it at
 * any RPC endpoint you trust for the chain the proof names.
 */
export function readAttestedAnchor(rpcUrl: string, contract: string, fetchImpl: Fetch = fetch): AttestedAnchorReader {
  const selector = keccak256Hex(utf8("attestedAnchors(uint256)")).slice(0, 10);
  return async (index) => {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("anchor index must be a non-negative integer");
    const data = selector + index.toString(16).padStart(64, "0");
    const res = await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: contract, data }, "latest"] }) });
    if (!res.ok) throw new Error(`eth_call failed with ${res.status}`);
    const j = (await res.json()) as { result?: string; error?: { message?: string } };
    if (j.error || typeof j.result !== "string") throw new Error(`eth_call failed: ${j.error?.message ?? "no result"}`);
    const out = bytesToHex(hexToBytes(j.result));
    if (out.length !== 256) throw new Error("unexpected attestedAnchors return data");
    const word = (i: number) => "0x" + out.slice(i * 64, (i + 1) * 64);
    if (word(1) === ZERO32) return null;
    return { providerId: word(0), root: word(1), attestationRef: word(2), anchoredAt: Number(BigInt(word(3))) };
  };
}
