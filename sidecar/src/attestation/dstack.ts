import { existsSync } from "node:fs";
import { bytesToHex, normalizeDigest, SidecarError } from "../util.ts";
import type { AttestationProvider, PlatformInfo, QuoteEvidence } from "./types.ts";
import { readBoundQuote } from "./tdx-quote.ts";

// Client for the dstack guest agent, which a confidential VM exposes to its containers on a unix socket
// (normally /var/run/dstack.sock) or, with a simulator, over HTTP. The calls used are:
//   POST /GetQuote  {"report_data": "<hex, up to 64 bytes>"}  ->  {"quote": "<hex>", "event_log": "<json>", ...}
//   POST /Info      {}                                        ->  {"app_id", "instance_id", "tcb_info": <object or JSON string>, ...}
// Older agents serve the same two operations as /prpc/Tappd.TdxQuote?json and /prpc/Tappd.Info?json on
// /var/run/tappd.sock; those are tried when the newer paths answer 404.

export type DstackOptions = {
  /** "unix:/path/to.sock", an absolute socket path, or an http(s) URL. Default: the first socket that exists. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_SOCKETS = ["/var/run/dstack.sock", "/var/run/tappd.sock"];

type Target = { kind: "unix"; path: string } | { kind: "http"; base: string };

export function resolveDstackTarget(endpoint: string | undefined, exists: (p: string) => boolean = existsSync): Target {
  if (endpoint) {
    if (/^https?:\/\//.test(endpoint)) return { kind: "http", base: endpoint.replace(/\/$/, "") };
    return { kind: "unix", path: endpoint.replace(/^unix:/, "") };
  }
  const found = DEFAULT_SOCKETS.find((p) => exists(p));
  if (!found) throw new SidecarError("DSTACK_UNAVAILABLE", `no dstack guest agent socket found (looked for ${DEFAULT_SOCKETS.join(", ")}); set attestation.dstack.endpoint`);
  return { kind: "unix", path: found };
}

export class DstackAttestationProvider implements AttestationProvider {
  readonly kind = "dstack" as const;
  private target: Target;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;

  constructor(opts: DstackOptions = {}) {
    this.target = resolveDstackTarget(opts.endpoint);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private async call(path: string, body: unknown): Promise<{ status: number; json: Record<string, any> }> {
    const url = this.target.kind === "http" ? `${this.target.base}${path}` : `http://dstack${path}`;
    const init: RequestInit & { unix?: string } = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (this.target.kind === "unix") init.unix = this.target.path;
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (e) {
      throw new SidecarError("DSTACK_UNAVAILABLE", `dstack guest agent unreachable: ${(e as Error).message}`);
    }
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      if (res.ok) throw new SidecarError("DSTACK_BAD_RESPONSE", `dstack ${path} returned non-JSON`);
    }
    return { status: res.status, json };
  }

  async platformInfo(): Promise<PlatformInfo> {
    let r = await this.call("/Info", {});
    if (r.status === 404) r = await this.call("/prpc/Tappd.Info?json", {});
    if (r.status < 200 || r.status >= 300) throw new SidecarError("DSTACK_BAD_RESPONSE", `dstack Info failed with HTTP ${r.status}`);
    let tcb: Record<string, any> = {};
    const raw = r.json.tcb_info;
    if (typeof raw === "string") {
      try {
        tcb = JSON.parse(raw);
      } catch {
        tcb = {};
      }
    } else if (raw && typeof raw === "object") tcb = raw;
    const compose = r.json.compose_hash ?? tcb.compose_hash;
    return {
      composeHash: typeof compose === "string" && compose ? normalizeDigest(compose, "dstack compose_hash") : undefined,
      appId: typeof r.json.app_id === "string" ? r.json.app_id : undefined,
      instanceId: typeof r.json.instance_id === "string" ? r.json.instance_id : undefined,
    };
  }

  async quote(reportData: Uint8Array): Promise<QuoteEvidence> {
    const rd = bytesToHex(reportData);
    let r = await this.call("/GetQuote", { report_data: rd });
    if (r.status === 404) r = await this.call("/prpc/Tappd.TdxQuote?json", { report_data: rd, hash_algorithm: "raw" });
    if (r.status < 200 || r.status >= 300) throw new SidecarError("DSTACK_BAD_RESPONSE", `dstack GetQuote failed with HTTP ${r.status}`);
    const quoteHex = typeof r.json.quote === "string" ? r.json.quote.replace(/^0x/, "").toLowerCase() : "";
    if (!/^(?:[0-9a-f]{2})+$/.test(quoteHex)) throw new SidecarError("DSTACK_BAD_RESPONSE", "dstack GetQuote returned no quote");
    const measurements = readBoundQuote(Buffer.from(quoteHex, "hex"), rd);
    const eventLog = typeof r.json.event_log === "string" ? r.json.event_log : r.json.event_log ? JSON.stringify(r.json.event_log) : null;
    return {
      kind: "dstack",
      dev: false,
      format: "tdx-quote-v4",
      quote: quoteHex,
      reportData: rd,
      eventLog,
      measurements,
      generatedAt: new Date().toISOString(),
    };
  }
}
