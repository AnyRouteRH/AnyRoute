import { constants, createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { canonicalJson, sha256 } from "../src/lib/util.ts";

// Test support for the attestor verifiers and the measurement service: quote bytes, a signing JWKS, and an
// independently written RFC 6962 Merkle tree (recursive definition) to test the iterative inclusion check.

export const hex = (fill: string, bytes: number) => fill.repeat(bytes).slice(0, bytes * 2);
export const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

export type TdxRegisters = { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string; rtmr3: string };
export const REGS: TdxRegisters = { mrtd: "aa".repeat(48), rtmr0: "b0".repeat(48), rtmr1: "b1".repeat(48), rtmr2: "b2".repeat(48), rtmr3: "b3".repeat(48) };

/** A v4 TDX quote body with the given registers and report_data (hex, 64 bytes). The signature part is absent. */
export function tdxQuote(reportDataHex: string, regs: TdxRegisters = REGS): string {
  const q = Buffer.alloc(700);
  q.writeUInt16LE(4, 0);
  const put = (off: number, h: string) => Buffer.from(h, "hex").copy(q, 48 + off);
  put(136, regs.mrtd);
  put(328, regs.rtmr0);
  put(376, regs.rtmr1);
  put(424, regs.rtmr2);
  put(472, regs.rtmr3);
  put(520, reportDataHex.padEnd(128, "0"));
  return q.toString("hex");
}

export const DIGESTS = { image: "sha256:" + "11".repeat(32), compose: "sha256:" + "22".repeat(32), model: "sha256:" + "33".repeat(32) };

export function bindingsFor(d = DIGESTS) {
  return { tls_pubkey: "04" + "ab".repeat(32), receipt_pubkey: "cd".repeat(32), image_digest: d.image, compose_hash: d.compose, model_digest: d.model };
}

/** A sidecar attestation document whose quote commits to sha256(canonical_json(bindings)) || nonce. */
export function sidecarDocument(nonce: string, opts: { digests?: typeof DIGESTS; dev?: boolean; eventLog?: string | null; bindings?: Record<string, unknown>; tamperReportData?: boolean } = {}) {
  const bindings = opts.bindings ?? bindingsFor(opts.digests);
  const reportData = (opts.tamperReportData ? "00".repeat(32) : sha256(canonicalJson(bindings))) + nonce.replace(/^0x/, "");
  return {
    v: 1,
    type: "anyroute.sidecar.attestation",
    dev: opts.dev ?? false,
    evidence: { kind: "dstack", dev: opts.dev ?? false, format: "tdx-quote-v4", quote: tdxQuote(reportData), report_data: reportData, event_log: opts.eventLog ?? null, measurements: { mrtd: REGS.mrtd }, nonce },
    bindings,
  };
}

// ---- JWT / JWKS ----------------------------------------------------------------------------------------

export function rsaKey(kid = "test-key") {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "PS384", use: "sig" };
  return { privateKey, jwks: { keys: [jwk] }, kid };
}

export function signJwt(privateKey: KeyObject, claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "PS384", kid: "test-key" }) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = `${enc(header)}.${enc(claims)}`;
  const alg = String(header.alg);
  const hash = alg.endsWith("256") ? "sha256" : alg.endsWith("512") ? "sha512" : "sha384";
  const key = alg.startsWith("PS") ? { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : privateKey;
  return `${data}.${cryptoSign(hash, Buffer.from(data), key as never).toString("base64url")}`;
}

// ---- Merkle tree (RFC 6962, written from the recursive definition) ----------------------------------

const leafHash = (d: Buffer) => sha(Buffer.concat([Buffer.from([0]), d]));
const nodeHash = (l: Buffer, r: Buffer) => sha(Buffer.concat([Buffer.from([1]), l, r]));
const split = (n: number) => {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
};
export function mth(data: Buffer[]): Buffer {
  if (data.length === 1) return leafHash(data[0]);
  const k = split(data.length);
  return nodeHash(mth(data.slice(0, k)), mth(data.slice(k)));
}
export function auditPath(m: number, data: Buffer[]): Buffer[] {
  if (data.length === 1) return [];
  const k = split(data.length);
  return m < k ? [...auditPath(m, data.slice(0, k)), mth(data.slice(k))] : [...auditPath(m - k, data.slice(k)), mth(data.slice(0, k))];
}

/** A log of `size` entries in which `index` holds `body`; returns the entry as Rekor's v1 API shapes it. */
export function rekorEntryFor(opts: { uuid: string; body: object | string; size: number; index: number; integratedTime?: number; checkpointKey?: KeyObject; origin?: string; tamper?: "proof" | "root" }) {
  const bodyBytes = Buffer.from(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
  const data = Array.from({ length: opts.size }, (_, i) => (i === opts.index ? bodyBytes : Buffer.from(`other-entry-${i}`)));
  const root = mth(data);
  const hashes = auditPath(opts.index, data).map((h) => h.toString("hex"));
  if (opts.tamper === "proof" && hashes.length) hashes[0] = "00".repeat(32);
  const rootHash = opts.tamper === "root" ? "11".repeat(32) : root.toString("hex");
  let checkpoint: string | undefined;
  if (opts.checkpointKey) {
    const origin = opts.origin ?? "rekor.test - 1234";
    const note = `${origin}\n${opts.size}\n${root.toString("base64")}\n`;
    const sig = cryptoSign("sha256", Buffer.from(note), opts.checkpointKey);
    checkpoint = `${note}\n— rekor.test ${Buffer.concat([Buffer.from("01020304", "hex"), sig]).toString("base64")}\n`;
  }
  return {
    [opts.uuid]: {
      body: bodyBytes.toString("base64"),
      integratedTime: opts.integratedTime ?? 1_790_000_000,
      logID: "aa".repeat(32),
      logIndex: opts.index + 1000,
      verification: { inclusionProof: { logIndex: opts.index, rootHash, treeSize: opts.size, hashes, ...(checkpoint ? { checkpoint } : {}) } },
    },
  };
}
