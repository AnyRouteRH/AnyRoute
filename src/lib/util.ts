import { redactRpcFields } from "../chain/rpc-redaction.ts";
import { createHash, randomBytes, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";

export const now = () => Date.now();
export const sha256 = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
export const randomHex = (bytes = 16) => randomBytes(bytes).toString("hex");
export const uid = (prefix = "") => prefix + randomBytes(12).toString("hex");
export const genId = () => `gen-${Math.floor(Date.now() / 1000)}-${randomBytes(10).toString("base64url")}`;

/** Deterministic JSON: object keys sorted recursively, undefined dropped, bigint as string. */
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

// AES-256-GCM for secrets at rest (upstream provider keys, BYOK keys).
function aesKey(secret: string) {
  return createHash("sha256").update("anyroute:aes:" + secret).digest();
}
export function encrypt(secret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", aesKey(secret), iv);
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}
export function decrypt(secret: string, token: string): string {
  const [v, iv, tag, body] = token.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("Unrecognized ciphertext");
  const d = createDecipheriv("aes-256-gcm", aesKey(secret), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
}
export const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function percentile(sorted: number[], p: number) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: Level = (process.env.LOG_LEVEL as Level) || "info";
export const setLogLevel = (l: Level) => (threshold = l);
function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (order[level] < order[threshold]) return;
  const line = JSON.stringify(redactRpcFields({ t: new Date().toISOString(), level, msg, ...fields }), (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}
export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};
