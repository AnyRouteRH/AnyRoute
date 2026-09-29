import { createHmac } from "node:crypto";
import type { Hex } from "viem";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { providerFetch } from "../providers/network.ts";
import { canonicalJson } from "../lib/util.ts";
import { encodeFeedUpdate } from "./ipx.ts";
import { OracleSigner, isPrivateKeyHex, type SignedUpdate } from "./ipx-oracle-sign.ts";
import type { OraclePublisher, PublishResult } from "./ipx-oracle.ts";

// The two sinks an oracle update can be handed to.
//
//   OnchainFeedPublisher  builds IPXFeed.update calldata from the update. It submits only when told to (IPX_ORACLE_ONCHAIN_SUBMIT),
//                         through the chain service's "ipx" signing role, once per hourly sample, and never a clamped price
//                         (the feed's answer is the receipt-derived sample).
//   HttpsPushPublisher    a generic HTTPS push. The request (URL, method, headers, JSON body, and how the request is signed) is
//                         described by a config document with {{variable}} placeholders, so the adapter carries no knowledge of
//                         any particular service. See deploy/ipx-perp/push-config.example.json.

// ---- On-chain ---------------------------------------------------------------------------------------------

const USDG_BASE = 1_000_000n;

/** "1234.5" (up to 6 decimals) to base units. */
export function usdgBaseUnits(v: string): bigint {
  const [whole, frac = ""] = v.split(".");
  return BigInt(whole) * USDG_BASE + BigInt(frac.padEnd(6, "0").slice(0, 6));
}

export type FeedChain = { readFeed(feed: Hex): Promise<{ updatedAt: number }>; postIpxFeed(feed: Hex, u: { answer: bigint; receiptRoot: Hex; volumeUsdg: bigint }): Promise<{ hash: Hex }> };

export class OnchainFeedPublisher implements OraclePublisher {
  readonly name = "onchain";
  constructor(private o: { feeds: Record<string, Hex>; submit: boolean; chain: FeedChain }) {}

  async publish(u: SignedUpdate): Promise<PublishResult> {
    const feed = this.o.feeds[u.class];
    if (!feed) return { status: "skipped", detail: "no feed address for this class" };
    if (u.status === "halted" || u.price_e8 === null || !u.source) return { status: "skipped", detail: "halted record" };
    if (u.clamp?.applied) return { status: "skipped", detail: "clamped: the feed carries the receipt-derived sample only" };
    if (!u.source.receipt_root) return { status: "skipped", detail: "no receipt root for this sample" };
    const update = { answer: BigInt(u.price_e8), receiptRoot: u.source.receipt_root, volumeUsdg: usdgBaseUnits(u.volume_usdg_24h ?? "0") };
    if (!this.o.submit) return { status: "calldata", detail: encodeFeedUpdate(update) };
    // One post per hourly sample: skip when the feed already has an update at or after the end of this window.
    const last = await this.o.chain.readFeed(feed).catch(() => null);
    if (last && last.updatedAt >= u.source.window_to) return { status: "skipped", detail: "feed already updated for this hour" };
    const { hash } = await this.o.chain.postIpxFeed(feed, update);
    return { status: "submitted", detail: hash };
  }
}

// ---- Generic HTTPS push -------------------------------------------------------------------------------------

const ENV_NAME = /^IPX_ORACLE_PUSH_[A-Z0-9_]+$/;
const TOKEN = /\{\{\s*([A-Za-z0-9_:.-]+)\s*\}\}/g;
const WHOLE = /^\{\{\s*([A-Za-z0-9_:.-]+)\s*\}\}$/;

export const pushConfigSchema = z.object({
  url: z.string().min(1).max(2000),
  method: z.enum(["POST", "PUT", "PATCH"]).default("POST"),
  timeout_ms: z.number().int().min(1_000).max(30_000).default(10_000),
  headers: z.record(z.string().min(1).max(100), z.string().max(2000)).default({}),
  /** Optional class -> market symbol, available to templates as {{market}}. */
  markets: z.record(z.string(), z.string().min(1).max(100)).default({}),
  /** Any JSON value; strings inside may hold {{variables}}. */
  body: z.unknown(),
  signing: z
    .object({
      algorithm: z.enum(["ed25519", "secp256k1-eip191", "hmac-sha256"]),
      /** Name of an IPX_ORACLE_PUSH_* variable holding the key (32-byte hex) or, for hmac, the shared secret. Default for the asymmetric schemes: the oracle key. */
      key_env: z.string().regex(ENV_NAME).optional(),
      /** The exact string that is signed; may use {{body}}, {{method}}, {{path}}, {{host}}, {{timestamp_ms}} and every update variable. */
      message: z.string().min(1).max(4000),
      encoding: z.enum(["hex", "0xhex", "base64", "base64url"]).default("hex"),
      /** Header that receives the signature; leave out to use {{request_signature}} inside `headers` instead. */
      header: z.string().min(1).max(100).optional(),
    })
    .optional(),
  /** Response statuses that count as success; default: any 2xx. */
  success_status: z.array(z.number().int().min(100).max(599)).max(20).optional(),
});
export type PushConfig = z.infer<typeof pushConfigSchema>;

/** `source` is a path to a JSON file or the JSON itself. Errors never echo the document. */
export function parsePushConfig(source: string, opts: { production: boolean }): PushConfig {
  const text = source.trim().startsWith("{") ? source : (() => {
    try {
      return readFileSync(resolve(source), "utf8");
    } catch {
      throw new Error("IPX_ORACLE_PUSH_CONFIG: cannot read the file.");
    }
  })();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("IPX_ORACLE_PUSH_CONFIG is not valid JSON.");
  }
  const parsed = pushConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`IPX_ORACLE_PUSH_CONFIG: ${parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ").slice(0, 400)}`);
  const cfg = parsed.data;
  if (!/^https:\/\//i.test(cfg.url) && !(!opts.production && /^http:\/\//i.test(cfg.url))) throw new Error("IPX_ORACLE_PUSH_CONFIG: url must be https" + (opts.production ? "" : " (http only outside production)") + ".");
  return cfg;
}

type Vars = Record<string, unknown>;

function lookup(name: string, vars: Vars, env: Record<string, string | undefined>): unknown {
  if (name.startsWith("env:")) {
    const key = name.slice(4);
    if (!ENV_NAME.test(key)) throw new Error("A template may only read IPX_ORACLE_PUSH_* environment variables.");
    const v = env[key];
    if (v === undefined || v === "") throw new Error(`Environment variable ${key} is not set.`);
    return v;
  }
  if (!(name in vars)) throw new Error(`Unknown template variable ${name.slice(0, 40)}.`);
  return vars[name];
}

const asText = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? canonicalJson(v) : String(v));

/** A string that is exactly one {{variable}} keeps that variable's type; otherwise placeholders are spliced in as text. */
export function renderTemplate(t: unknown, vars: Vars, env: Record<string, string | undefined>): unknown {
  if (typeof t === "string") {
    const whole = WHOLE.exec(t);
    if (whole) return lookup(whole[1], vars, env);
    return t.replace(TOKEN, (_m, name: string) => asText(lookup(name, vars, env)));
  }
  if (Array.isArray(t)) return t.map((x) => renderTemplate(x, vars, env));
  if (t && typeof t === "object") return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, renderTemplate(v, vars, env)]));
  return t;
}

/** The variables a template can use. `update` is the whole signed update as an object. */
export function updateVars(u: SignedUpdate, market: string): Vars {
  return {
    index: u.index,
    class: u.class,
    market,
    status: u.status,
    price: u.price,
    price_e8: u.price_e8,
    price_number: u.price === null ? null : Number(u.price),
    decimals: u.decimals,
    unit: u.unit,
    timestamp: u.timestamp,
    timestamp_ms: u.timestamp * 1000,
    valid_until: u.valid_until,
    valid_until_ms: u.valid_until * 1000,
    stale_after_s: u.stale_after_s,
    sequence: u.sequence,
    thin: u.thin,
    reduce_only: u.reduce_only,
    halted: u.halted,
    volume_usdg_24h: u.volume_usdg_24h,
    receipt_root: u.source?.receipt_root ?? null,
    receipts_in_root: u.source?.receipts_in_root ?? null,
    window_from: u.source?.window_from ?? null,
    window_to: u.source?.window_to ?? null,
    clamped: u.clamp?.applied ?? false,
    signer: u.signature.signer,
    signature_algorithm: u.signature.algorithm,
    signature: u.signature.value,
    digest: u.signature.digest,
    update: u,
  };
}

function encode(bytes: Uint8Array, how: "hex" | "0xhex" | "base64" | "base64url") {
  const b = Buffer.from(bytes);
  return how === "hex" ? b.toString("hex") : how === "0xhex" ? "0x" + b.toString("hex") : b.toString(how);
}

export type PushOptions = {
  config: PushConfig;
  /** The oracle's own signer: the default key for the asymmetric request-signing schemes. */
  oracleSigner: OracleSigner;
  env: Record<string, string | undefined>;
  production: boolean;
  /** Test hook. The default resolves the host, refuses non-public addresses and follows no redirects. */
  fetch?: typeof fetch;
};

export class HttpsPushPublisher implements OraclePublisher {
  readonly name = "https";
  private signer: OracleSigner | null = null;

  constructor(private o: PushOptions) {
    const s = o.config.signing;
    if (s && s.algorithm !== "hmac-sha256") {
      if (s.key_env) {
        const key = o.env[s.key_env];
        if (!isPrivateKeyHex(key)) throw new Error(`Environment variable ${s.key_env} must hold a 0x-prefixed 32-byte key.`);
        this.signer = new OracleSigner(s.algorithm, key);
      } else if (o.oracleSigner.algorithm === s.algorithm) this.signer = o.oracleSigner;
      else throw new Error("signing.algorithm differs from the oracle key's algorithm; name a key with signing.key_env.");
    }
    if (s?.algorithm === "hmac-sha256" && !(s.key_env && o.env[s.key_env])) throw new Error("signing.hmac-sha256 needs signing.key_env naming a set IPX_ORACLE_PUSH_* variable.");
  }

  /** Build the request for an update without sending it (also how the config is checked). */
  async build(u: SignedUpdate): Promise<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> {
    const { config, env } = this.o;
    const vars = updateVars(u, config.markets[u.class] ?? u.class);
    const urlText = String(renderTemplate(config.url, vars, env));
    if (!/^https:\/\//i.test(urlText) && !(!this.o.production && /^http:\/\//i.test(urlText))) throw new Error("The push URL must be https.");
    const url = new URL(urlText);
    if (url.username || url.password || url.hash) throw new Error("The push URL must not carry credentials or a fragment.");
    const body = JSON.stringify(renderTemplate(config.body ?? null, vars, env));
    const reqVars: Vars = { ...vars, body, method: config.method, path: url.pathname + url.search, host: url.host, request_signature: "" };
    let signatureHeader: [string, string] | null = null;
    const s = config.signing;
    if (s) {
      const message = new TextEncoder().encode(String(renderTemplate(s.message, reqVars, env)));
      const raw = s.algorithm === "hmac-sha256" ? createHmac("sha256", env[s.key_env!]!).update(message).digest() : await this.signer!.signBytes(message);
      reqVars.request_signature = encode(raw, s.encoding);
      if (s.header) signatureHeader = [s.header, String(reqVars.request_signature)];
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(config.headers)) {
      const value = String(renderTemplate(v, reqVars, env));
      if (/[\r\n]/.test(value)) throw new Error("A rendered header contains a line break.");
      headers[k.toLowerCase()] = value;
    }
    if (signatureHeader) headers[signatureHeader[0].toLowerCase()] = signatureHeader[1];
    if (!Object.keys(headers).some((k) => k === "content-type")) headers["content-type"] = "application/json";
    return { url: url.toString(), init: { method: config.method, headers, body } };
  }

  async publish(u: SignedUpdate): Promise<PublishResult> {
    if (u.status === "halted" || u.price_e8 === null) return { status: "skipped", detail: "halted record" };
    const { url, init } = await this.build(u);
    const fetchImpl = this.o.fetch ?? ((input: string, i: RequestInit) => providerFetch(input, i, { production: this.o.production, allowDevelopmentMockLoopback: !this.o.production }));
    try {
      const res = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(this.o.config.timeout_ms) });
      await res.body?.cancel().catch(() => undefined);
      const ok = this.o.config.success_status ? this.o.config.success_status.includes(res.status) : res.status >= 200 && res.status < 300;
      // Only the status is kept: the request carries a signature and the response is not ours to log.
      return { status: ok ? "sent" : "failed", detail: `HTTP ${res.status}` };
    } catch (e) {
      return { status: "failed", detail: `request failed (${(e as Error).name || "error"})` };
    }
  }
}
