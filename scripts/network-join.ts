#!/usr/bin/env node
// Source for the single-file host registration command served at /network/join.mjs.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const WARNING = "Use a dedicated operator wallet, not a wallet holding funds. This command signs authentication messages; it sends no transactions.";
const HELP = `node join.mjs --name NAME --endpoint https://SIDECAR --payout-address 0xADDRESS --models MODEL[,MODEL] [--contact CONTACT]
  --router URL          Router origin (default https://anyroute.tech)
  --key-file PATH       Read the operator private key from a UTF-8 file
  --key-env NAME        Read it from an environment variable (default ANYROUTE_OPERATOR_PRIVATE_KEY)
  --dry-run             Print the exact JSON body without reading a key or sending a request
  --status PROVIDER_ID  Poll host status without reading a key or signing up
  --poll-count N        Status requests (default 5, maximum 100)
  --poll-interval MS    Time between status requests (default 5000, minimum 100)
Never put a private key in command-line arguments. Requires Node 22 or later.`;
class JoinError extends Error {}
const reject = (message: string): never => { throw new JoinError(message); };
// Also protects output from a response that reflects sensitive input. No raw exceptions are printed.
export const safeOutput = (text: string) => text.replace(/(?:0x)?[a-f0-9]{64,}/gi, "[redacted]").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u001b]/g, "");
type Options = Record<string, string | boolean>;
export type HostPayload = { name: string; endpoint: string; payout_address: string; models: string[]; contact?: string };

function options(args: string[]): Options {
  if (args.some((arg) => /(?:0x)?[a-f0-9]{64,}/i.test(arg))) reject("Private keys must come from a file or environment variable, never arguments.");
  const flags = new Set(["--help", "--dry-run"]);
  const values = new Set(["--name", "--endpoint", "--payout-address", "--models", "--contact", "--router", "--key-file", "--key-env", "--status", "--poll-count", "--poll-interval"]);
  const out: Options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key in out) reject("Duplicate command option.");
    if (flags.has(key)) out[key] = true;
    else if (values.has(key) && args[i + 1] && !args[i + 1].startsWith("--")) out[key] = args[++i];
    else reject("Unknown option or missing value. Run with --help.");
  }
  if (out["--key-file"] && out["--key-env"]) reject("Choose one key source: --key-file or --key-env.");
  if (out["--status"] && (out["--dry-run"] || ["--name", "--endpoint", "--payout-address", "--models", "--contact", "--key-file", "--key-env"].some((key) => out[key] !== undefined))) reject("--status cannot be combined with signup or key options.");
  if (!out["--status"] && (out["--poll-count"] || out["--poll-interval"])) reject("Polling options require --status.");
  return out;
}
function url(value: string, loopback = false): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return reject("Provide a valid HTTPS URL."); }
  if (parsed.username || parsed.password || parsed.hash || parsed.search || (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)))) reject("URLs must use HTTPS and contain no credentials, query or fragment.");
  return parsed;
}
export function hostPayload(o: Options): HostPayload {
  const name = String(o["--name"] || "");
  if (!name.trim() || name.length > 60) reject("Provide --name with 1 to 60 characters.");
  const endpoint = String(o["--endpoint"] || ""); url(endpoint);
  const payout_address = String(o["--payout-address"] || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(payout_address)) reject("Provide --payout-address as a 0x-prefixed wallet address.");
  const models = String(o["--models"] || "").split(",").map((id) => id.trim());
  if (models.length < 1 || models.length > 8 || models.some((id) => !id) || new Set(models).size !== models.length) reject("Provide 1 to 8 distinct model ids with --models.");
  const contact = o["--contact"] as string | undefined;
  if (contact !== undefined && contact.length > 120) reject("Contact must be at most 120 characters.");
  return { name, endpoint, payout_address, models, ...(contact === undefined ? {} : { contact }) };
}

/** Exactly the personal_sign message verified by src/api/auth.ts walletAuth. */
export async function walletHeader(key: Hex, body: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  try {
    const account = privateKeyToAccount(key);
    const hash = createHash("sha256").update(body, "utf8").digest("hex");
    const signature = await account.signMessage({ message: `anyroute:${timestamp}:${hash}` });
    return `${account.address.toLowerCase()}:${timestamp}:${signature}`;
  } catch { return reject("The operator private key is invalid."); }
}
async function readKey(o: Options, env: NodeJS.ProcessEnv): Promise<Hex> {
  let raw: string;
  if (o["--key-file"]) {
    let bytes: Buffer;
    try { bytes = await readFile(String(o["--key-file"])); } catch { return reject("Could not read the operator key file."); }
    try { raw = bytes.toString("utf8").trim(); } finally { bytes.fill(0); }
  } else raw = (env[String(o["--key-env"] || "ANYROUTE_OPERATOR_PRIVATE_KEY")] || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) reject("Provide a 0x-prefixed private key through --key-file or --key-env.");
  return raw as Hex;
}
type Dependencies = { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch; out?: (line: string) => void; err?: (line: string) => void; sleep?: (ms: number) => Promise<void> };
function integer(value: string | boolean | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value)) || Number(value) < min || Number(value) > max) reject("Polling count or interval is outside its allowed range.");
  return Number(value);
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

export async function runJoin(args: string[], deps: Dependencies = {}): Promise<number> {
  const out = (line: string) => (deps.out || console.log)(safeOutput(line));
  const err = (line: string) => (deps.err || console.error)(safeOutput(line));
  err(WARNING);
  try {
    const o = options(args);
    if (o["--help"]) { out(HELP); return 0; }
    const router = url(String(o["--router"] || "https://anyroute.tech"), true);
    if (router.pathname !== "/") reject("--router must be an origin without a path.");
    const fetcher = deps.fetcher || fetch;
    async function request(route: string, init: RequestInit): Promise<Record<string, unknown>> {
      let response: Response;
      try { response = await fetcher(new URL(route, router), { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) }); }
      catch { return reject("Could not reach the router; no automatic signup retry was made."); }
      let doc: unknown;
      try { doc = await response.json(); } catch { return reject(`Router returned HTTP ${response.status} without valid JSON.`); }
      if (!response.ok) {
        const message = record(doc) && record(doc.error) && typeof doc.error.message === "string" ? doc.error.message : "Request refused.";
        reject(`HTTP ${response.status}: ${message}`);
      }
      if (!record(doc)) return reject("Router returned an invalid host response.");
      return doc;
    }
    function report(doc: Record<string, unknown>, id?: string) {
      if (typeof doc.provider_id !== "string" || !doc.provider_id || typeof doc.status !== "string" || !Array.isArray(doc.reasons) || doc.reasons.some((reason) => typeof reason !== "string") || (id !== undefined && doc.provider_id !== id)) return reject("Router returned an invalid host response.");
      out(`Provider: ${doc.provider_id}\nStatus: ${doc.status}`);
      out(doc.reasons.length ? `Reasons:\n${doc.reasons.map((reason) => `- ${reason}`).join("\n")}` : "Reasons: none");
      if (id !== undefined) out(`Attested: ${doc.attested === true}\nProbation until: ${doc.probation_until ?? "none"}\nWeight: ${doc.weight ?? "unknown"}`);
      // Never accept a server-supplied external URL in a wallet workflow.
      const dashboard = `/hosts/?id=${encodeURIComponent(String(doc.provider_id))}`;
      if (id === undefined && doc.dashboard !== dashboard) reject("Router returned an invalid dashboard URL.");
      out(`Dashboard: ${new URL(dashboard, router).href}`);
    }
    if (o["--status"]) {
      const id = String(o["--status"]);
      const count = integer(o["--poll-count"], 5, 1, 100);
      const interval = integer(o["--poll-interval"], 5000, 100, 60_000);
      for (let i = 0; i < count; i++) {
        if (i) await (deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(interval);
        report(await request(`/api/v1/network/hosts/${encodeURIComponent(id)}/status`, { method: "GET" }), id);
      }
      return 0;
    }
    const body = JSON.stringify(hostPayload(o));
    if (o["--dry-run"]) { out(body); return 0; }
    const key = await readKey(o, deps.env || process.env);
    const header = await walletHeader(key, body);
    const doc = await request("/api/v1/network/hosts", { method: "POST", headers: { "content-type": "application/json", "X-Wallet-Auth": header }, body });
    if (!["probation", "rejected", "pending"].includes(String(doc.status))) reject("Router returned an invalid signup status.");
    report(doc);
    return doc.status === "rejected" ? 2 : 0;
  } catch (error) {
    err(error instanceof JoinError ? error.message : "Host registration failed.");
    return 1;
  }
}

// Works for the TypeScript source in Bun and the bundled ESM file in Node.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runJoin(process.argv.slice(2));
