import { normalizeDigest, SidecarError } from "./util.ts";

// Optional cross-check of the served model digest against the router's record for this provider:
//   GET <router>/api/v1/attestation/<providerId>
// The record is read tolerantly: any of the fields below that hold digests are collected, and the served digest
// must be among them. A record that names no model digest at all cannot confirm anything and refuses the start.

export type RouterCheckConfig = { url: string; providerId: string; apiKey?: string; failClosed: boolean };

const SINGLE_FIELDS = ["model_digest", "modelDigest"];
const LIST_FIELDS = ["allowed_model_digests", "model_digests", "modelDigests"];
const NESTED = ["measurements", "measurement", "registered", "record", "attestation"];

function collectDigests(node: unknown, out: Set<string>, depth = 0) {
  if (!node || typeof node !== "object" || depth > 3) return;
  const o = node as Record<string, unknown>;
  const add = (v: unknown) => {
    if (typeof v !== "string") return;
    try {
      out.add(normalizeDigest(v));
    } catch {
      /* not a digest */
    }
  };
  for (const f of SINGLE_FIELDS) add(o[f]);
  for (const f of LIST_FIELDS) if (Array.isArray(o[f])) (o[f] as unknown[]).forEach(add);
  for (const n of NESTED) collectDigests(o[n], out, depth + 1);
}

export function assertSafeRouterUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SidecarError("BAD_CONFIG", "router.url is not a valid URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new SidecarError("BAD_CONFIG", "router.url must be https (http is accepted only for loopback)");
  return u;
}

export async function verifyAgainstRouter(cfg: RouterCheckConfig, served: { modelDigest: string }, fetchImpl: typeof fetch = fetch): Promise<{ checked: boolean; registeredDigests: string[] }> {
  const base = assertSafeRouterUrl(cfg.url);
  const url = new URL(`api/v1/attestation/${encodeURIComponent(cfg.providerId)}`, base.href.endsWith("/") ? base.href : base.href + "/");
  let record: unknown;
  try {
    const res = await fetchImpl(url, {
      redirect: "error",
      headers: { accept: "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 1_048_576) throw new Error("response too large");
    record = JSON.parse(text);
  } catch (e) {
    if (cfg.failClosed) throw new SidecarError("ROUTER_UNREACHABLE", `cannot read the router's attestation record: ${(e as Error).message}`);
    return { checked: false, registeredDigests: [] };
  }
  const digests = new Set<string>();
  collectDigests(record, digests);
  if (!digests.size) throw new SidecarError("ROUTER_RECORD_UNRECOGNISED", "the router's record for this provider names no model digest, so the served weights cannot be confirmed");
  if (!digests.has(served.modelDigest)) {
    throw new SidecarError("ROUTER_DIGEST_MISMATCH", `served model digest ${served.modelDigest} does not match the router's record for this provider; refusing to start`);
  }
  return { checked: true, registeredDigests: [...digests] };
}
