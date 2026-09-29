import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256Hex = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
export const sha256Bytes = (v: string | Uint8Array) => new Uint8Array(createHash("sha256").update(v).digest());
export const randomHex = (bytes = 16) => randomBytes(bytes).toString("hex");

/** Deterministic JSON: object keys sorted recursively, undefined dropped, bigint as string. Same rules as the router. */
export function canonical(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canonical(v);
    }
    return out;
  }
  return value;
}
export const canonicalJson = (v: unknown) => JSON.stringify(canonical(v));
export const canonicalBytes = (v: unknown) => Buffer.from(canonicalJson(v));

export const bytesToHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const hexToBytes = (hex: string) => {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error("invalid hex");
  return new Uint8Array(Buffer.from(clean, "hex"));
};

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** A failure that must stop the sidecar from starting (or from serving). The code is stable for tests and logs. */
export class SidecarError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SidecarError";
  }
}

const DIGEST_RE = /^(?:sha256:)?(?:0x)?([0-9a-fA-F]{64})$/;

/** Normalise "sha256:<hex>", "0x<hex>" or bare hex to "sha256:<lowercase hex>". */
export function normalizeDigest(value: string, what = "digest"): string {
  const m = DIGEST_RE.exec(value.trim());
  if (!m) throw new SidecarError("BAD_DIGEST", `${what} must be a sha256 digest (sha256:<64 hex characters>)`);
  return `sha256:${m[1].toLowerCase()}`;
}

export const digestHex = (digest: string) => digest.replace(/^sha256:/, "");

export type Logger = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

/** JSON-lines logger on stderr. Never pass request content, API keys or client addresses here. */
export const stderrLogger: Logger = (level, msg, fields = {}) => {
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }) + "\n");
};
export const silentLogger: Logger = () => {};
