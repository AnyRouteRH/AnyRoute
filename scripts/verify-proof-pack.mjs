#!/usr/bin/env node
// Verify an Anyroute proof pack offline, with nothing but Node (18 or later) and this file.
//
//   node scripts/verify-proof-pack.mjs anyroute-proof-pack-<from>-to-<to>.json
//
// Checks: every key in the pack has the id its bytes give (first 16 hex of sha256); every call receipt (v1: Ed25519 over
// canonical JSON; v2: COSE_Sign1 with EdDSA), refund receipt, monthly statement and the pack's manifest verifies against
// the keys in the pack; each receipt's anchor leaf is keccak256(keccak256(...)) of what was signed; every Merkle path
// present leads from that leaf to its root (sorted-pair keccak256, as OpenZeppelin MerkleProof); each statement's amounts
// reconcile exactly; and the signed manifest lists exactly the receipts, statements and keys in the file. It makes no
// network request and deliberately shares no code with the router. Whether a root was posted on chain, and whether the
// keys are the router's, are checked against the ReceiptAnchor contract and /.well-known/anyroute-receipt-keys.json.

import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

export const PACK_TYPE = "anyroute.proof-pack.v1";
export const MANIFEST_TYPE = "anyroute.proof-pack.manifest.v1";
export const STATEMENT_TYPE = "anyroute.statement.v1";

// ---- encodings ---------------------------------------------------------------------------------------------------

/** The router's canonical JSON: object keys sorted recursively, undefined dropped. */
export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}
export const canonicalJson = (v) => JSON.stringify(canonical(v));
const hex = (b) => Buffer.from(b).toString("hex");
const sha256 = (b) => createHash("sha256").update(b).digest();
const b64 = (s) => (typeof s === "string" && /^[A-Za-z0-9+/_-]*={0,2}$/.test(s) ? Buffer.from(s, s.includes("-") || s.includes("_") ? "base64url" : "base64") : null);
const fromHex = (s) => (typeof s === "string" && /^(0x)?([0-9a-fA-F]{2})*$/.test(s) ? Buffer.from(s.replace(/^0x/, ""), "hex") : null);

// Keccak-256 with Ethereum's padding (not SHA3-256), on 32-bit lane halves.
const RC = [
  [0x00000001, 0x00000000], [0x00008082, 0x00000000], [0x0000808a, 0x80000000], [0x80008000, 0x80000000], [0x0000808b, 0x00000000], [0x80000001, 0x00000000],
  [0x80008081, 0x80000000], [0x00008009, 0x80000000], [0x0000008a, 0x00000000], [0x00000088, 0x00000000], [0x80008009, 0x00000000], [0x8000000a, 0x00000000],
  [0x8000808b, 0x00000000], [0x0000008b, 0x80000000], [0x00008089, 0x80000000], [0x00008003, 0x80000000], [0x00008002, 0x80000000], [0x00000080, 0x80000000],
  [0x0000800a, 0x00000000], [0x8000000a, 0x80000000], [0x80008081, 0x80000000], [0x00008080, 0x80000000], [0x80000001, 0x00000000], [0x80008008, 0x80000000],
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
function keccakF(lo, hi) {
  const cl = new Uint32Array(5), ch = new Uint32Array(5), bl = new Uint32Array(25), bh = new Uint32Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      cl[x] = lo[x] ^ lo[x + 5] ^ lo[x + 10] ^ lo[x + 15] ^ lo[x + 20];
      ch[x] = hi[x] ^ hi[x + 5] ^ hi[x + 10] ^ hi[x + 15] ^ hi[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const l = cl[(x + 1) % 5], h = ch[(x + 1) % 5];
      const dl = cl[(x + 4) % 5] ^ ((l << 1) | (h >>> 31));
      const dh = ch[(x + 4) % 5] ^ ((h << 1) | (l >>> 31));
      for (let y = 0; y < 25; y += 5) (lo[x + y] ^= dl), (hi[x + y] ^= dh);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y, to = y + 5 * ((2 * x + 3 * y) % 5), r = ROT[i];
        let l = lo[i], h = hi[i];
        if (r >= 32) [l, h] = [h, l];
        const s = r % 32;
        bl[to] = s ? (l << s) | (h >>> (32 - s)) : l;
        bh[to] = s ? (h << s) | (l >>> (32 - s)) : h;
      }
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        lo[x + y] = bl[x + y] ^ (~bl[((x + 1) % 5) + y] & bl[((x + 2) % 5) + y]);
        hi[x + y] = bh[x + y] ^ (~bh[((x + 1) % 5) + y] & bh[((x + 2) % 5) + y]);
      }
    }
    lo[0] ^= RC[round][0];
    hi[0] ^= RC[round][1];
  }
}
export function keccak256(data) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const lo = new Uint32Array(25), hi = new Uint32Array(25);
  const view = new DataView(padded.buffer);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      lo[i] ^= view.getUint32(off + i * 8, true);
      hi[i] ^= view.getUint32(off + i * 8 + 4, true);
    }
    keccakF(lo, hi);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) (out.writeUInt32LE(lo[i], i * 8), out.writeUInt32LE(hi[i], i * 8 + 4));
  return out;
}
const leafOf = (bytes) => "0x" + hex(keccak256(keccak256(bytes)));

/** An OpenZeppelin MerkleProof path: hash sorted pairs from the leaf up; the result must be the root. */
export function merkleVerify(leaf, proof, root) {
  let h = fromHex(leaf);
  const r = fromHex(root);
  if (!h || h.length !== 32 || !r || r.length !== 32 || !Array.isArray(proof)) return false;
  for (const p of proof) {
    const q = fromHex(p);
    if (!q || q.length !== 32) return false;
    h = keccak256(Buffer.compare(h, q) < 0 ? Buffer.concat([h, q]) : Buffer.concat([q, h]));
  }
  return h.equals(r);
}

/** Enough CBOR (RFC 8949) for a COSE_Sign1 receipt: integers, byte and text strings, arrays, maps, tags, simple values. */
export function cborDecode(bytes) {
  let at = 0;
  const need = (n) => {
    if (at + n > bytes.length) throw new Error("truncated CBOR");
  };
  const item = () => {
    need(1);
    const b = bytes[at++], major = b >> 5, info = b & 0x1f;
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
      const s = bytes.subarray(at, at + n);
      at += n;
      return major === 2 ? Buffer.from(s) : Buffer.from(s).toString("utf8");
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
const head = (major, n) => {
  if (n < 24) return Buffer.of((major << 5) | n);
  if (n < 256) return Buffer.of((major << 5) | 24, n);
  if (n < 65536) return Buffer.of((major << 5) | 25, n >> 8, n & 255);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
};
const bstr = (b) => Buffer.concat([head(2, b.length), b]);

/** COSE_Sign1 into its protected header (alg, kid), payload, signature and the Sig_structure that was signed. */
export function decodeCose(bytes) {
  let v = cborDecode(bytes);
  if (v && !Array.isArray(v) && !(v instanceof Map) && typeof v === "object" && "tag" in v) {
    if (v.tag !== 18) throw new Error("not a COSE_Sign1");
    v = v.value;
  }
  if (!Array.isArray(v) || v.length !== 4 || !Buffer.isBuffer(v[0]) || !Buffer.isBuffer(v[2]) || !Buffer.isBuffer(v[3])) throw new Error("not a COSE_Sign1");
  const prot = v[0].length ? cborDecode(v[0]) : new Map();
  if (!(prot instanceof Map)) throw new Error("protected header is not a map");
  const kid = prot.get(4);
  const toBeSigned = Buffer.concat([head(4, 4), head(3, 10), Buffer.from("Signature1"), bstr(v[0]), bstr(Buffer.alloc(0)), bstr(v[2])]);
  return { alg: prot.get(1) ?? null, keyId: Buffer.isBuffer(kid) ? hex(kid) : null, claims: cborJson(cborDecode(v[2])), signature: v[3], toBeSigned };
}

// ---- checks ------------------------------------------------------------------------------------------------------

const pico = (value) => {
  if (typeof value !== "string" || !/^-?\d+(\.\d{1,12})?$/.test(value)) throw new Error("bad amount");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  return (BigInt(whole) * 10n ** 12n + BigInt(fraction.padEnd(12, "0"))) * (value.startsWith("-") ? -1n : 1n);
};
/** Opening + deposits + refunds - usage - fees + other = closing; every usage grouping and the movements add up. */
export function statementReconciles(p) {
  try {
    if (pico(p.opening_balance) + pico(p.deposits) + pico(p.refunds) - pico(p.usage) - pico(p.fees) + pico(p.other_changes) !== pico(p.closing_balance)) return false;
    for (const name of ["usage_by_model", "usage_by_key_agent", "usage_by_lane"]) if (!Array.isArray(p[name]) || p[name].reduce((s, r) => s + pico(r.amount), 0n) !== pico(p.usage)) return false;
    return Array.isArray(p.movements_by_kind) && pico(p.opening_balance) + p.movements_by_kind.reduce((s, r) => s + pico(r.amount), 0n) === pico(p.closing_balance);
  } catch {
    return false;
  }
}

function keyring(jwks, fail) {
  const keys = new Map();
  for (const k of Array.isArray(jwks?.keys) ? jwks.keys : []) {
    const raw = typeof k?.x === "string" ? Buffer.from(k.x, "base64url") : null;
    if (k?.kty !== "OKP" || k?.crv !== "Ed25519" || !raw || raw.length !== 32) {
      fail(`key ${k?.kid ?? "(no id)"}: not a 32-byte Ed25519 key`);
      continue;
    }
    if (hex(sha256(raw)).slice(0, 16) !== k.kid) {
      fail(`key ${k.kid}: its id does not match its bytes`);
      continue;
    }
    keys.set(k.kid, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" }));
  }
  return keys;
}

/** One Ed25519 signature over canonical JSON: { payload, sig, key_id }. */
function signedJson(doc, keys) {
  const key = keys.get(doc?.key_id);
  const sig = b64(doc?.sig);
  if (!doc?.payload || typeof doc.payload !== "object" || !sig) return { ok: false, why: "needs payload, sig and key_id" };
  if (!key) return { ok: false, why: `signed by key ${doc.key_id}, which is not in this pack` };
  const bytes = Buffer.from(canonicalJson(doc.payload));
  let ok = false;
  try {
    ok = verify(null, bytes, key, sig);
  } catch {
    ok = false;
  }
  return ok ? { ok, bytes, sig } : { ok: false, why: "the signature does not verify: the contents were changed or not signed by that key" };
}

/**
 * Check a proof pack (the parsed file, or its { data } envelope). Returns { ok, failures, summary, lines }: ok is true only when
 * nothing failed and the manifest verified.
 */
export function verifyProofPack(input) {
  const pack = input && typeof input === "object" && input.data && !input.type ? input.data : input;
  const failures = [];
  const fail = (m) => failures.push(m);
  const s = { calls: 0, receipts: 0, without_receipt: 0, v1_valid: 0, v2: 0, v2_valid: 0, paths: 0, paths_valid: 0, onchain_roots: new Set(), offchain_roots: new Set(), unrooted: 0, refunds: 0, refunds_valid: 0, statements: 0, statements_valid: 0, keys: 0, manifest: false };
  if (!pack || pack.type !== PACK_TYPE) {
    fail(`not an Anyroute proof pack (type ${pack?.type ?? "missing"}; expected ${PACK_TYPE})`);
    return finish(pack, s, failures);
  }
  const keys = keyring(pack.keys, fail);
  s.keys = keys.size;
  const path = (label, leaf, anchor) => {
    if (!anchor) return;
    s.paths++;
    if (merkleVerify(leaf, anchor.proof, anchor.root)) {
      s.paths_valid++;
      (anchor.status === "confirmed" && anchor.tx ? s.onchain_roots : s.offchain_roots).add(String(anchor.root).toLowerCase());
    } else fail(`${label}: the Merkle path does not lead from the receipt's leaf to root ${anchor.root}`);
  };

  const ids = new Set();
  for (const call of Array.isArray(pack.calls) ? pack.calls : []) {
    s.calls++;
    const label = `call ${call?.id}`;
    if (ids.has(call?.id)) fail(`${label}: listed twice`);
    ids.add(call?.id);
    const r = call?.receipt;
    if (!r) {
      s.without_receipt++;
      continue;
    }
    s.receipts++;
    if (r.id !== call.id) fail(`${label}: the receipt is for ${r.id}`);
    let rooted = false;
    if (r.payload) {
      const v = signedJson(r, keys);
      if (!v.ok) fail(`${label}: v1 ${v.why}`);
      else {
        s.v1_valid++;
        if (r.payload.id !== undefined && r.payload.id !== call.id) fail(`${label}: the signed receipt names call ${r.payload.id}`);
        const leaf = leafOf(Buffer.concat([v.bytes, v.sig]));
        if (r.leaf && leaf !== String(r.leaf).toLowerCase()) fail(`${label}: the v1 anchor leaf does not match the signed receipt`);
        else if (r.leaf) path(`${label} v1`, leaf, r.anchor);
        else if (r.anchor) fail(`${label}: a Merkle path without a leaf`);
        rooted ||= !!r.anchor;
      }
    }
    if (r.v2) {
      s.v2++;
      const bytes = b64(r.v2.cose);
      let d = null;
      try {
        d = bytes ? decodeCose(bytes) : null;
      } catch {
        d = null;
      }
      const key = d && keys.get(d.keyId);
      let ok = false;
      if (!d) fail(`${label}: v2 is not a readable COSE_Sign1`);
      else if (d.alg !== -8) fail(`${label}: v2 uses COSE algorithm ${d.alg}, not EdDSA`);
      else if (!key) fail(`${label}: v2 signed by key ${d.keyId}, which is not in this pack`);
      else {
        try {
          ok = verify(null, d.toBeSigned, key, d.signature);
        } catch {
          ok = false;
        }
        if (!ok) fail(`${label}: the v2 COSE signature does not verify`);
      }
      if (ok) {
        s.v2_valid++;
        if (d.claims?.rid !== call.id) fail(`${label}: the signed v2 claims name call ${d.claims?.rid}`);
        if (r.v2.claims && canonicalJson(r.v2.claims) !== canonicalJson(d.claims)) fail(`${label}: the readable v2 claims differ from the signed claims`);
        const leaf = leafOf(bytes);
        if (r.v2.leaf && leaf !== String(r.v2.leaf).toLowerCase()) fail(`${label}: the v2 anchor leaf does not match the signed receipt`);
        else if (r.v2.leaf) path(`${label} v2`, leaf, r.v2.anchor);
        else if (r.v2.anchor) fail(`${label}: a v2 Merkle path without a leaf`);
        rooted ||= !!r.v2.anchor;
      }
    }
    if (!r.payload && !r.v2) fail(`${label}: the receipt has neither a v1 payload nor a v2 encoding`);
    if (!rooted) s.unrooted++;
  }

  for (const r of Array.isArray(pack.refunds) ? pack.refunds : []) {
    s.refunds++;
    const label = `refund ${r?.id}`;
    const v = signedJson(r, keys);
    if (!v.ok) {
      fail(`${label}: ${v.why}`);
      continue;
    }
    if (r.payload.kind !== "refund" || r.payload.id !== r.id) fail(`${label}: the signed payload is not this refund receipt`);
    else if (r.leaf && leafOf(Buffer.concat([v.bytes, v.sig])) !== String(r.leaf).toLowerCase()) fail(`${label}: the anchor leaf does not match the signed receipt`);
    else {
      s.refunds_valid++;
      if (r.leaf) path(label, r.leaf, r.anchor);
    }
  }

  for (const st of Array.isArray(pack.statements) ? pack.statements : []) {
    s.statements++;
    const label = `statement ${st?.payload?.month}`;
    if (st?.payload?.type !== STATEMENT_TYPE) {
      fail(`${label}: not a monthly statement`);
      continue;
    }
    const v = signedJson(st, keys);
    if (!v.ok) fail(`${label}: ${v.why}`);
    else if (!statementReconciles(st.payload)) fail(`${label}: the amounts do not reconcile`);
    else s.statements_valid++;
  }

  const m = pack.manifest;
  const mv = signedJson(m, keys);
  if (!mv.ok) fail(`manifest: ${mv.why}`);
  else if (m.payload.type !== MANIFEST_TYPE) fail(`manifest: type ${m.payload.type}, expected ${MANIFEST_TYPE}`);
  else {
    const p = m.payload;
    const same = (a, b) => canonicalJson(a) === canonicalJson(b);
    const listed = {
      range: pack.range, scope: pack.scope, key_hash: pack.key_hash ?? null, part: pack.part, truncated: pack.truncated, next_cursor: pack.next_cursor ?? null, generated_at: pack.generated_at, router: pack.router,
      calls: (pack.calls ?? []).map((c) => ({ id: c.id, leaf: c.receipt?.leaf ?? null, leaf_v2: c.receipt?.v2?.leaf ?? null })),
      refunds: (pack.refunds ?? []).map((r) => ({ id: r.id, leaf: r.leaf ?? null })),
      statements: (pack.statements ?? []).map((x) => ({ month: x.payload?.month, key_id: x.key_id, sig: x.sig })),
      key_ids: (pack.keys?.keys ?? []).map((k) => k.kid),
    };
    const differs = Object.keys(listed).filter((k) => !same(p[k] ?? null, listed[k] ?? null));
    if (differs.length) fail(`manifest: the signed manifest does not match this file (${differs.join(", ")})`);
    else s.manifest = true;
  }
  return finish(pack, s, failures);
}

function finish(pack, s, failures) {
  const ok = failures.length === 0 && s.manifest;
  const r = pack?.range;
  const lines = [
    `Anyroute proof pack · ${r?.from ?? "?"} to ${r?.to ?? "?"} (UTC) · scope ${pack?.scope ?? "?"}${pack?.key_hash ? ` ${pack.key_hash}` : ""} · part ${pack?.part ?? 1}${pack?.truncated ? " of several" : ""}`,
    `Keys: ${s.keys} in this pack, each id matching its bytes.`,
    `Calls: ${s.calls} · ${s.receipts} with a signed receipt · ${s.without_receipt} without one.`,
    `Signatures: v1 ${s.v1_valid} valid · v2 ${s.v2_valid} of ${s.v2} valid · refunds ${s.refunds_valid} of ${s.refunds} valid · statements ${s.statements_valid} of ${s.statements} valid and reconciled.`,
    `Merkle paths: ${s.paths_valid} of ${s.paths} valid, under ${s.onchain_roots.size} root(s) posted on chain and ${s.offchain_roots.size} kept off chain · ${s.unrooted} receipt(s) not yet rooted.`,
    `Manifest: ${s.manifest ? "signed, and lists exactly the receipts, statements and keys in this file." : "not verified."}`,
  ];
  for (const u of Array.isArray(pack?.statements_unavailable) ? pack.statements_unavailable : []) lines.push(`No statement for ${u.month}: ${u.reason}`);
  if (pack?.next_cursor) lines.push("More calls in this range are in the next part (next_cursor).");
  if (s.onchain_roots.size) lines.push("To finish, compare each posted root with the ReceiptAnchor contract on chain.");
  for (const f of failures.slice(0, 50)) lines.push(`FAIL ${f}`);
  if (failures.length > 50) lines.push(`... and ${failures.length - 50} more failures.`);
  lines.push(ok ? "Result: every check passed." : `Result: ${failures.length || 1} check(s) failed.`);
  const summary = { ...s, onchain_roots: s.onchain_roots.size, offchain_roots: s.offchain_roots.size };
  return { ok, failures, summary, lines };
}

const isMain = (() => {
  try {
    return import.meta.main ?? (process.argv[1] && new URL(import.meta.url).pathname === (process.argv[1].startsWith("/") ? process.argv[1] : `${process.cwd()}/${process.argv[1]}`));
  } catch {
    return false;
  }
})();

if (isMain) {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: node scripts/verify-proof-pack.mjs <anyroute-proof-pack.json>");
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`Could not read ${file} as JSON: ${e.message}`);
    process.exit(2);
  }
  const result = verifyProofPack(parsed);
  for (const line of result.lines) (line.startsWith("FAIL") ? console.error : console.log)(line);
  process.exit(result.ok ? 0 : 1);
}
