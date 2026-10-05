import { validRouteExplanation } from "./route-explanation.js"; // V84
// Verify page: pure helpers (no React), shared by components/Verify.jsx and its tests.
// Two jobs. Describe what the router's attestation record for a provider does and does not establish, in plain words,
// keeping "unverified" unverified. And check a pasted receipt in the browser against the router's published keys.
// The receipt code follows packages/client/src/receipts.ts; a test in the router's suite runs both on the same input.

export const KEYS_PATH = "/.well-known/anyroute-receipt-keys.json";
export const attestationPath = (providerId) => `/api/v1/attestation/${encodeURIComponent(providerId)}`;

// ---- provider id in the address --------------------------------------------------------------------------------

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The provider id from `?p=` (or `?provider=`), or "" when absent or not a plausible id. */
export function providerIdFromSearch(search) {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const id = (params.get("p") || params.get("provider") || "").trim();
  return PROVIDER_ID.test(id) ? id : "";
}
export const verifyHref = (providerId) => `/verify/?p=${encodeURIComponent(providerId)}`;

// ---- what the router's record says -----------------------------------------------------------------------------

const REASONS = {
  no_attestation: "The router has never verified this provider.",
  last_attempt_failed: "The router's most recent attempt to verify this provider failed.",
  attestation_stale: "The router's last successful verification is too old to rely on.",
  simulated_evidence_refused: "The only evidence is simulated (development) evidence, which this router does not accept.",
};

const VERIFIERS = {
  dcap: "DCAP: Intel's signature and certificate chain over the quote",
  dstack: "dstack: the deployment's compose hash against its event log",
};

const TEE = [
  [/tdx/i, "Intel TDX (confidential virtual machine)"],
  [/snp|sev/i, "AMD SEV-SNP (confidential virtual machine)"],
  [/^dev$/i, "None: simulated for development"],
];
export function teeLabel(kind) {
  if (!kind) return "Not reported";
  for (const [re, label] of TEE) if (re.test(kind)) return label;
  return String(kind);
}

const REGISTRY = {
  registered: { state: "yes", text: "Registered on chain." },
  revoked: { state: "bad", text: "Revoked on chain: this measurement is no longer accepted." },
  submitted_unconfirmed: { state: "partial", text: "Submitted to the chain but not yet confirmed." },
  calldata_ready_not_submitted: { state: "no", text: "Prepared for the chain but not submitted." },
  not_submitted: { state: "no", text: "Not registered on chain." },
  not_recorded: { state: "no", text: "Nothing to register: the router has no measurement for this provider." },
};

/** "4 min ago", "3 h ago", "2 d ago"; "just now" under a minute; "" when the time is unusable. */
export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < -60) return "in the future";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const shortDigest = (d) => (typeof d === "string" && d.length > 22 ? `${d.slice(0, 12)}…${d.slice(-8)}` : d || "");

const yes = (v) => (v ? "yes" : "no");
/** A link target the page will render: https only, no whitespace or markup characters. */
const httpsUrl = (u) => (typeof u === "string" && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : "");

/**
 * A view model for the page from `GET /api/v1/attestation/:providerId` (the `data` object).
 * Every row has a `state`: yes / no (established or not) / partial / bad / unknown. Nothing is upgraded: a missing
 * field reads "unknown", a false check reads "no", and "attested" appears only when the router says status is attested.
 */
export function describeAttestation(data, now = Date.now()) {
  const d = data || {};
  const status = d.status === "attested" || d.status === "simulated" ? d.status : "unverified";
  const verdict =
    status === "attested"
      ? { tone: "ok", label: "Attested", text: "The router verified this provider's hardware attestation recently and reports it as attested. That is what the router checked, listed below. It does not show what the provider does with your data, and this page did not contact the provider or read its quote." }
      : status === "simulated"
        ? { tone: "warn", label: "Simulated", text: "This provider has only simulated (development) evidence. No hardware backs it, so nothing about it is private or verified." }
        : { tone: "bad", label: "Unverified", text: `${REASONS[d.reason] || "The router has no current verification for this provider."} Treat it as an ordinary provider: nothing here should be read as a privacy guarantee.` };

  const m = d.measurement || null;
  const log = m?.transparency_log || null;
  const reg = m?.registry || null;
  const registry = REGISTRY[reg?.state] || REGISTRY.not_recorded;
  const verifiers = Array.isArray(d.verifiers) ? d.verifiers : [];

  // A signed measurement bundle (the router's record of what the compose hash, image and model digests stand for) or, older,
  // an entry the router found for the image digest. The two are worded apart: only the first says who signed the entry.
  const bundle = log?.subject === "measurement_bundle";
  const what = bundle ? "A signed measurement bundle for this compose hash was found in the log" : "An entry for the image was found";
  const logState = !m
    ? { state: "no", text: "No measurement recorded, so no log lookup was made." }
    : log?.found && log.inclusion_verified && log.checkpoint_signature_verified
      ? { state: "yes", text: `${what}, its inclusion in the log was verified, and so was the log's signature over its checkpoint.${bundle ? " The router checked that it was signed with the measurement key it publishes." : ""}` }
      : log?.found && log.inclusion_verified
        ? { state: "partial", text: `${what} and its inclusion was verified, but the log's signature over the checkpoint was not.` }
        : log?.found
          ? { state: "partial", text: `${what}, but its inclusion in the log has not been verified.` }
          : { state: "no", text: "No transparency-log entry was found for the image." };

  const attestedAt = status === "unverified" ? null : d.attested_at || null;
  return {
    status,
    verdict,
    provider: d.provider || "",
    rows: {
      tee: { label: "Hardware", value: status === "unverified" ? "Not established" : teeLabel(d.tee), state: status === "attested" ? "known" : status === "simulated" ? "simulated" : "unknown" },
      verifiers: {
        label: "Quote checked by",
        value: verifiers.length && status === "attested" ? verifiers.map((v) => VERIFIERS[v] || v) : [],
        empty: "Nobody: no verifier has accepted a quote for this provider.",
        state: status === "attested" && verifiers.length ? "yes" : "no",
      },
      lastVerified: { label: "Last verified by the router", value: attestedAt || "", relative: relativeTime(attestedAt, now), empty: "Never, or not recently enough to count.", state: attestedAt ? "yes" : "no" },
    },
    measurement: m
      ? {
          recorded: true,
          currentlyAttested: status === "attested" && !!m.attested_now,
          status: m.status,
          firstSeen: m.first_attested_at || "",
          lastSeen: m.last_seen_at || "",
          digests: [
            { key: "image", label: "Image digest", value: m.image_digest || "" },
            { key: "compose", label: "Compose hash", value: m.compose_hash || "" },
            { key: "model", label: "Model digest", value: m.model_digest || "" },
          ],
        }
      : { recorded: false, currentlyAttested: false, digests: [] },
    transparencyLog: { ...logState, index: log?.log_index ?? null, uuid: log?.uuid || "", integratedAt: log?.integrated_at || "", checkedAt: log?.checked_at || "", subject: bundle ? "measurement_bundle" : null, entryUrl: httpsUrl(log?.entry_url), bundleDigest: bundle && typeof log.bundle?.digest === "string" ? log.bundle.digest : "" },
    registry: { ...registry, address: reg?.address || "", tx: reg?.tx_hash || "", registeredAt: reg?.registered_at || "" },
    checks: [
      // The first two only count while the router calls the provider attested, whatever the flags say.
      ["quote_verified", "The router verified a hardware quote", yes(status === "attested" && d.checks?.quote_verified)],
      ["digests_bound_to_quote", "The image, compose and model digests are committed inside that quote", yes(status === "attested" && d.checks?.digests_bound_to_quote)],
      ["transparency_log_entry", bundle ? "The measurement bundle has an entry in a transparency log" : "The image has an entry in a transparency log", yes(d.checks?.transparency_log_entry)],
      ["transparency_log_checkpoint_signature", "The log's signature over that entry was verified", yes(d.checks?.transparency_log_checkpoint_signature)],
      ["registered_on_chain", "The measurement is registered on chain", yes(d.checks?.registered_on_chain)],
    ].map(([id, label, state]) => ({ id, label, state })),
    notChecked: [
      ...(Array.isArray(d.not_checked) ? d.not_checked : []),
      "Anything about the provider itself. This page reads the router's record. To check the provider's own /attest document and its TLS certificate before you send, use an SDK (see the docs).",
    ],
  };
}

// ---- receipts, in the browser ----------------------------------------------------------------------------------

// Canonical JSON: the router's `canonical` + JSON.stringify (src/lib/util.ts). Object key order comes out of the
// JavaScript engine, exactly as it does when the router signs.
function canonical(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) if (value[k] !== undefined) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}
export const canonicalJson = (v) => JSON.stringify(canonical(v));

const utf8 = (s) => new TextEncoder().encode(s);
export const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function hexToBytes(hex) {
  const clean = String(hex).replace(/^0x/i, "");
  if (clean.length % 2 || /[^0-9a-fA-F]/.test(clean)) throw new Error("invalid hex");
  return Uint8Array.from(clean.match(/../g) || [], (h) => parseInt(h, 16));
}
export function base64ToBytes(text) {
  const t = String(text).trim();
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(t)) throw new Error("invalid base64");
  const std = t.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));

// Keccak-256 (Ethereum's padding), for the receipt leaf and merkle nodes.
const MASK = (1n << 64n) - 1n;
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);
export function keccak256(data) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const a = new Array(25).fill(0n);
  const c = new Array(5);
  const b = new Array(25);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
      a[i] ^= lane;
    }
    for (let round = 0; round < 24; round++) {
      for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
      for (let x = 0; x < 5; x++) {
        const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
        for (let y = 0; y < 25; y += 5) a[x + y] ^= d;
      }
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROT[x + 5 * y]);
      for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) a[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK & b[((x + 2) % 5) + y]);
      a[0] ^= RC[round];
    }
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((a[i] >> BigInt(8 * j)) & 0xffn);
  return out;
}

const cmp = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
export function verifyMerkleProof(leaf, proof, root) {
  try {
    let h = hexToBytes(leaf);
    for (const p of proof) {
      const q = hexToBytes(p);
      h = keccak256(cmp(h, q) < 0 ? concat(h, q) : concat(q, h));
    }
    return bytesToHex(h) === bytesToHex(hexToBytes(root));
  } catch {
    return false;
  }
}

/** Ed25519 through WebCrypto; throws {unsupported: true} where the browser cannot. */
export async function ed25519Verify(publicKey, message, signature) {
  let key;
  try {
    key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
  } catch (e) {
    throw Object.assign(new Error("This browser cannot verify Ed25519 signatures."), { unsupported: true, cause: e });
  }
  return crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
}

const pass = (id, detail) => ({ id, status: "pass", detail });
const fail = (id, detail) => ({ id, status: "fail", detail });
const skip = (id, detail) => ({ id, status: "not_checked", detail });

const receiptTime = (payload) => {
  if (typeof payload.ts === "number" && Number.isFinite(payload.ts)) return payload.ts;
  const t = Date.parse(payload.issued || "");
  return Number.isFinite(t) ? t : null;
};

export const RECEIPT_NOT_CHECKED = [
  "That the signing key is the one registered on chain: compare the key id with the ReceiptAnchor contract, or pin the key yourself.",
  "That an anchor root was posted on chain: an inclusion proof shows the receipt sits under a root, not that the root was published.",
];

/**
 * Check a receipt against the router's published key set (`keys`: the JWKS, or its `keys` array) or against a raw
 * Ed25519 public key in hex (`publicKeyHex`). Returns { valid, keyId, checks, anchor, notChecked }. `valid` is true only
 * when the signature verified and nothing failed; a browser that cannot run Ed25519 gets "not_checked" and valid false.
 */
export async function verifyReceipt(receipt, opts = {}) {
  // A receipt with a v2 encoding gets both checked; v1 alone is checked exactly as before.
  const cose = typeof receipt?.cose === "string" ? receipt.cose : typeof receipt?.v2?.cose === "string" ? receipt.v2.cose : null;
  const v2opts = { keys: opts.keys, publicKeyHex: opts.publicKeyHex, ed25519: opts.ed25519 || ed25519Verify, chunks: opts.chunks };
  if (cose && !receipt.payload) {
    const v2 = await verifyReceiptV2(cose, { ...v2opts, proof: receipt.anchor });
    return { valid: v2.valid, keyId: v2.keyId, checks: v2.checks, anchor: anchorState(v2.checks), notChecked: RECEIPT_NOT_CHECKED, claims: v2.claims };
  }
  const v1 = await verifyReceiptV1(receipt, opts);
  if (!cose) return v1;
  const v2 = await verifyReceiptV2(cose, { ...v2opts, proof: receipt.v2?.anchor });
  // B: both encodings are signed by the router from the same call, so they carry the same decision tag or none.
  const t1 = receipt.payload?.decision_tag ?? null, t2 = v2.claims?.decision_tag ?? null;
  const tags = t1 === t2 ? [] : [fail("decision_tag", "The v1 and v2 receipts carry different decision tags, so they are not from the same call.")];
  return { ...v1, valid: v1.valid && v2.valid && !tags.length, checks: [...v1.checks, ...v2.checks, ...tags], claims: v2.claims };
}
const anchorState = (checks) => {
  const c = checks.find((x) => x.id === "v2_anchor_proof");
  return c?.status === "pass" ? "proof_valid" : c?.status === "fail" ? "proof_invalid" : "no_proof";
};

async function verifyReceiptV1(receipt, { keys, publicKeyHex, ed25519 = ed25519Verify, skewMs = 300_000 } = {}) {
  const checks = [];
  const keyId = typeof receipt?.key_id === "string" ? receipt.key_id : "";
  const done = (anchor) => ({ valid: checks.every((c) => c.status !== "fail") && checks.some((c) => c.id === "signature" && c.status === "pass"), keyId, checks, anchor, notChecked: RECEIPT_NOT_CHECKED });
  if (!receipt || typeof receipt !== "object" || !receipt.payload || typeof receipt.payload !== "object" || typeof receipt.sig !== "string" || !keyId) {
    checks.push(fail("shape", "A receipt needs payload, sig and key_id."));
    return done("no_proof");
  }
  if (receipt.payload.route !== undefined) checks.push(validRouteExplanation(receipt.payload.route, receipt.payload.provider) ? pass("route", "Route explanation v1 is a router-signed summary, not independent proof of selection.") : fail("route", "Invalid route explanation.")); // V84
  checks.push(receipt.alg === undefined || receipt.alg === "Ed25519" ? pass("alg", "Ed25519") : fail("alg", `Unsupported algorithm ${String(receipt.alg)}.`));

  let raw = null;
  let window = null;
  const idOf = async (bytes) => bytesToHex(await sha256(bytes)).slice(0, 16);
  if (publicKeyHex) {
    try {
      raw = hexToBytes(publicKeyHex.trim());
      if (raw.length !== 32) throw new Error("length");
    } catch {
      raw = null;
      checks.push(fail("key", "The key you entered is not 32 bytes of hex."));
    }
    if (raw) {
      const derived = await idOf(raw);
      checks.push(derived === keyId ? pass("key", `Key id ${keyId} matches the key you entered.`) : fail("key", `The receipt names key ${keyId}, but the key you entered has id ${derived}.`));
    }
  } else {
    const list = Array.isArray(keys) ? keys : keys?.keys || [];
    const jwk = list.find((k) => k.kid === keyId);
    if (!jwk) checks.push(fail("key", `Key ${keyId} is not in the router's published key list.`));
    else if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") checks.push(fail("key", "The published key is not an Ed25519 key."));
    else {
      try {
        raw = base64ToBytes(jwk.x);
        if (raw.length !== 32) throw new Error("length");
        const derived = await idOf(raw);
        checks.push(derived === keyId ? pass("key", `Key ${keyId} is in the router's published list and its id matches its bytes.`) : fail("key", `The published entry's id does not match its key bytes (${derived}).`));
        window = { from: jwk.valid_from ? Date.parse(jwk.valid_from) : null, to: jwk.retired_at ? Date.parse(jwk.retired_at) : null };
      } catch {
        raw = null;
        checks.push(fail("key", "The published key is malformed."));
      }
    }
  }

  let sig = null;
  try {
    sig = base64ToBytes(receipt.sig);
  } catch {
    checks.push(fail("signature", "The signature is not valid base64."));
  }
  const bytes = utf8(canonicalJson(receipt.payload));
  if (raw && sig && !checks.some((c) => c.id === "key" && c.status === "fail")) {
    try {
      checks.push((await ed25519(raw, bytes, sig)) ? pass("signature", "The signature over the receipt's contents verifies with that key.") : fail("signature", "The signature does not verify: the receipt was changed or was not signed by that key."));
    } catch (e) {
      checks.push(e?.unsupported ? skip("signature", `${e.message} Use one of the SDKs to check it.`) : fail("signature", String(e?.message || e)));
    }
  } else if (!checks.some((c) => c.id === "signature")) {
    checks.push(fail("signature", "Not verified: there is no usable key or signature."));
  }

  const t = receiptTime(receipt.payload);
  if (window && t !== null && (window.from !== null || window.to !== null)) {
    const early = window.from !== null && t < window.from - skewMs;
    const late = window.to !== null && t > window.to + skewMs;
    checks.push(early || late ? fail("key_window", "The receipt is dated outside its signing key's validity window.") : pass("key_window", "The receipt's date is inside its key's validity window."));
  } else checks.push(skip("key_window", "No key window or receipt date to compare."));

  if (receipt.leaf && sig) {
    const leaf = "0x" + bytesToHex(keccak256(keccak256(concat(bytes, sig))));
    checks.push(leaf === String(receipt.leaf).toLowerCase() ? pass("leaf", "The receipt's anchor leaf matches its contents and signature.") : fail("leaf", "The anchor leaf does not match the receipt's contents and signature."));
  } else checks.push(skip("leaf", "The receipt carries no anchor leaf."));

  let anchor = "no_proof";
  const proof = receipt.anchor;
  if (proof && Array.isArray(proof.proof) && typeof proof.root === "string" && receipt.leaf) {
    const ok = verifyMerkleProof(receipt.leaf, proof.proof, proof.root);
    anchor = ok ? "proof_valid" : "proof_invalid";
    checks.push(ok ? pass("anchor_proof", `The receipt is included under root ${proof.root.slice(0, 10)}…${proof.tx ? "" : " (a root kept off chain, not posted)"}`) : fail("anchor_proof", "The inclusion proof does not lead from the receipt to the stated root."));
  } else checks.push(skip("anchor_proof", "No inclusion proof yet. The router adds receipts to a Merkle root on a schedule, so fetch it again later. A root is posted on chain only when its proof names a transaction."));
  return done(anchor);
}

// ---- receipt v2 (COSE_Sign1, EdDSA), the same checks as packages/client/src/receipts-v2.ts ----------------------

function decodeCbor(bytes) {
  let at = 0;
  const need = (n) => {
    if (at + n > bytes.length) throw new Error("truncated CBOR");
  };
  const item = () => {
    need(1);
    const b = bytes[at++];
    const major = b >> 5;
    const info = b & 0x1f;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new Error("unsupported CBOR value");
    }
    let n = info;
    if (info >= 24) {
      const len = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
      if (!len) throw new Error("indefinite CBOR lengths are not allowed");
      need(len);
      n = 0;
      for (let i = 0; i < len; i++) n = n * 256 + bytes[at++];
    }
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2 || major === 3) {
      need(n);
      const s = bytes.slice(at, at + n);
      at += n;
      return major === 2 ? s : new TextDecoder().decode(s);
    }
    if (major === 4) return Array.from({ length: n }, item);
    if (major === 5) {
      const m = new Map();
      for (let i = 0; i < n; i++) m.set(item(), item());
      return m;
    }
    return { tag: n, value: item() };
  };
  const v = item();
  if (at !== bytes.length) throw new Error("trailing CBOR bytes");
  return v;
}
const cborJson = (v) => (v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [String(k), cborJson(x)])) : Array.isArray(v) ? v.map(cborJson) : v);
const cborHead = (major, n) => (n < 24 ? Uint8Array.of((major << 5) | n) : n < 256 ? Uint8Array.of((major << 5) | 24, n) : n < 65536 ? Uint8Array.of((major << 5) | 25, n >> 8, n & 255) : Uint8Array.of((major << 5) | 26, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255));
const cborBstr = (b) => concat(cborHead(2, b.length), b);
const sigStructure = (prot, payload) => concat(cborHead(4, 4), cborHead(3, 10), utf8("Signature1"), cborBstr(prot), cborBstr(new Uint8Array()), cborBstr(payload));

/** COSE_Sign1 bytes into { alg, keyId, claims, prot, payload, signature }. Throws on anything malformed. */
export function decodeReceiptV2(bytes) {
  let v = decodeCbor(bytes);
  if (v && v.tag !== undefined && !(v instanceof Map) && !Array.isArray(v)) {
    if (v.tag !== 18) throw new Error("not a COSE_Sign1");
    v = v.value;
  }
  if (!Array.isArray(v) || v.length !== 4 || !(v[0] instanceof Uint8Array) || !(v[2] instanceof Uint8Array) || !(v[3] instanceof Uint8Array)) throw new Error("not a COSE_Sign1");
  const hdr = decodeCbor(v[0]);
  const kid = hdr instanceof Map ? hdr.get(4) : null;
  return { alg: hdr instanceof Map ? hdr.get(1) : null, keyId: kid instanceof Uint8Array ? bytesToHex(kid) : "", claims: cborJson(decodeCbor(v[2])), prot: v[0], payload: v[2], signature: v[3] };
}

/** The chunk hash chain head over streamed event data: c_0 = SHA-256(rid), c_i = SHA-256(c_{i-1} || chunk_i). */
export async function chunkChainHead(rid, chunks) {
  let c = await sha256(utf8(rid));
  for (const d of chunks) c = await sha256(concat(c, utf8(d)));
  return "sha256:" + bytesToHex(c);
}

/** Checks a v2 receipt in order: signature, chain head (when events are given), anchor proof. Ids are prefixed v2_. */
export async function verifyReceiptV2(coseB64, { keys, publicKeyHex, ed25519 = ed25519Verify, chunks, proof } = {}) {
  const checks = [];
  let bytes, d;
  try {
    bytes = base64ToBytes(coseB64);
    d = decodeReceiptV2(bytes);
  } catch (e) {
    return { valid: false, keyId: "", claims: null, checks: [fail("v2_shape", `The v2 receipt is not a readable COSE_Sign1 (${e.message}).`)] };
  }
  if (d.claims.route !== undefined) checks.push(validRouteExplanation(d.claims.route, d.claims.node?.provider) ? pass("v2_route", "Route explanation v1 is covered by the COSE signature; routing itself is not independently checked.") : fail("v2_route", "Invalid route explanation.")); // V84
  checks.push(d.alg === -8 ? pass("v2_alg", "v2: COSE_Sign1 with EdDSA.") : fail("v2_alg", `v2: unsupported COSE algorithm ${String(d.alg)}.`));
  let raw = null;
  try {
    if (publicKeyHex) raw = hexToBytes(publicKeyHex.trim());
    else {
      const jwk = (Array.isArray(keys) ? keys : keys?.keys || []).find((k) => k.kid === d.keyId);
      if (jwk && jwk.kty === "OKP" && jwk.crv === "Ed25519") raw = base64ToBytes(jwk.x);
    }
  } catch {
    raw = null;
  }
  if (!raw || raw.length !== 32) checks.push(fail("v2_signature", `v2: key ${d.keyId || "(none)"} is not available to check against.`));
  else if (bytesToHex(await sha256(raw)).slice(0, 16) !== d.keyId) checks.push(fail("v2_signature", `v2: the receipt names key ${d.keyId}, which is not this key.`));
  else {
    try {
      checks.push((await ed25519(raw, sigStructure(d.prot, d.payload), d.signature)) ? pass("v2_signature", "v2: the COSE signature over the claims verifies.") : fail("v2_signature", "v2: the COSE signature does not verify: the claims were changed or not signed by that key."));
    } catch (e) {
      checks.push(e?.unsupported ? skip("v2_signature", `${e.message} Use one of the SDKs to check it.`) : fail("v2_signature", String(e?.message || e)));
    }
  }
  if (Array.isArray(chunks)) {
    const head = await chunkChainHead(d.claims.rid, chunks);
    checks.push(head === d.claims.resp?.chain ? pass("v2_chain", `v2: the chain head over ${chunks.length} streamed events matches.`) : fail("v2_chain", "v2: the chain head does not match the streamed events: the stream was cut or changed."));
  } else checks.push(skip("v2_chain", d.claims.resp?.chain ? `v2: signed chain head ${shortDigest(d.claims.resp.chain)}. Paste the streamed events to check it.` : "v2: not a streamed response, so there is no chain."));
  const leaf = "0x" + bytesToHex(keccak256(keccak256(bytes)));
  if (proof && Array.isArray(proof.proof) && typeof proof.root === "string") {
    const ok = verifyMerkleProof(leaf, proof.proof, proof.root);
    checks.push(ok ? pass("v2_anchor_proof", `v2: included under root ${proof.root.slice(0, 10)}…${proof.anchored || proof.tx ? "" : " (a root kept off chain, not posted)"}`) : fail("v2_anchor_proof", "v2: the Merkle path does not lead from this receipt to the root."));
  } else checks.push(skip("v2_anchor_proof", "v2: no Merkle path yet. Fetch the receipt again later; a root is posted on chain only when its proof names a transaction."));
  return { valid: checks.every((c) => c.status !== "fail") && checks.some((c) => c.id === "v2_signature" && c.status === "pass"), keyId: d.keyId, claims: d.claims, leaf, checks };
}

// ---- decision tags (B) ---------------------------------------------------------------------------------------------
// A caller may send X-Anyroute-Decision-Tag with a model call: the SHA-256 of the order its agent is about to place. The
// router signs it into that call's v1 receipt (payload.decision_tag) and v2 claims (claims.decision_tag). The page shows it
// and hashes an order pasted here the way the helpers and SDKs do; only the two hashes are compared, nothing is sent.

const TAG = /^sha256:[0-9a-f]{64}$/;

/**
 * The decision tag a receipt carries, from its v1 payload or its v2 claims (pass the decoded, signed claims when the
 * receipt was checked), or null. `agree` is false when the two encodings name different tags.
 */
export function receiptDecisionTag(receipt, claims) {
  const v1 = typeof receipt?.payload?.decision_tag === "string" ? receipt.payload.decision_tag : null;
  const c = claims ?? receipt?.v2?.claims ?? (typeof receipt?.claims === "object" ? receipt.claims : null);
  const v2 = typeof c?.decision_tag === "string" ? c.decision_tag : null;
  const tag = v1 ?? v2;
  return tag ? { tag, v1, v2, agree: !v1 || !v2 || v1 === v2, wellFormed: TAG.test(tag) } : null;
}

/**
 * `sha256:<hex>` of an order's canonical JSON (keys sorted, no spaces), the same bytes the decision-receipt helpers and
 * the SDKs hash, or a pasted `sha256:` digest as it is. Returns { tag } or { error }. Runs in this browser only.
 */
export async function orderDecisionTag(text) {
  const s = String(text || "").trim();
  if (!s) return { error: "Paste the order first." };
  if (/^(?:sha256:)?[0-9a-fA-F]{64}$/.test(s)) return { tag: "sha256:" + s.replace(/^sha256:/, "").toLowerCase(), digest: true };
  let value;
  try {
    value = JSON.parse(s);
  } catch {
    return { error: "That is not valid JSON. Paste the order exactly as your agent hashed it." };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "An order is a JSON object, for example {\"symbol\":\"STOCK_A\",\"side\":\"buy\",\"quantity\":\"2\"}." };
  return { tag: "sha256:" + bytesToHex(await sha256(utf8(canonicalJson(value)))) };
}

/**
 * Turn whatever was pasted into a receipt envelope. Accepts the receipt itself, a chat response holding `receipt`, or a
 * receipt lookup response ({ data: ... }). A v2-only receipt ({ cose }) works too. Returns { receipt } or { error }.
 */
export function parseReceiptInput(text) {
  const s = String(text || "").trim();
  if (!s) return { error: "Paste a receipt first." };
  let json;
  try {
    json = JSON.parse(s);
  } catch {
    return { error: "That is not valid JSON. Paste the whole receipt object." };
  }
  const candidates = [json, json?.receipt, json?.data, json?.data?.receipt];
  const receipt =
    candidates.find((c) => c && typeof c === "object" && c.payload && typeof c.sig === "string" && typeof c.key_id === "string") ||
    candidates.find((c) => c && typeof c === "object" && typeof c.cose === "string");
  if (!receipt) return { error: "No receipt found. It needs payload, sig and key_id, or a v2 cose field (a chat response's receipt field, or GET /api/v1/receipts/:id, works)." };
  return { receipt };
}

/** A receipt the sidecar signed with its enclave key: the router's key list will not contain that key. */
export const isEnclaveReceipt = (receipt) => receipt?.payload?.type === "anyroute.sidecar.receipt";
