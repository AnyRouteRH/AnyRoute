import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SidecarError } from "../util.ts";
import { UsageError } from "./args.ts";
import { check, endpointOrigin, normalizeOrigin } from "./spec.ts";
import { FILES, type Manifest } from "./state.ts";

// The provider application for POST /api/v1/providers/apply, built from what `init` recorded and the endpoint's public
// address. The router's operator reviews an application before any traffic or attestation check begins; this only
// files it. The router key is part of the body only when asked for (--include-key): by default it goes to the operator
// separately, when the application is approved.

export type Application = {
  id: string;
  name: string;
  base_url: string;
  api_key?: string;
  contact?: string;
  datacenters?: string[];
  data_policy: { training: boolean; retains_prompts: boolean; retention_days?: number; zdr?: boolean };
  tee: { kind: "tdx"; attestation_url: string };
  payout_address?: string;
};

export type ApplyOptions = { url: string; includeKey?: boolean; keyPath?: string };

/** The body, checked against the router's rules for an application (its schema in src/providers/application.ts). */
export function buildApplication(m: Manifest, o: ApplyOptions): Application {
  const origin = endpointOrigin(o.url);
  if (new URL(origin).protocol !== "https:") throw new UsageError("the endpoint URL must be https: the router refuses anything else in production");
  const p = m.provider;
  const problems: string[] = [];
  const bad = (msg: string | null) => msg && problems.push(msg);
  bad(check.providerId(p.id));
  if (p.name.length < 1 || p.name.length > 80) problems.push("name must be 1 to 80 characters");
  if (p.contact && p.contact.length > 200) problems.push("contact is at most 200 characters");
  if (p.payout_address) bad(check.address(p.payout_address));
  if (`${origin}/v1`.length > 2048) problems.push("the endpoint URL is too long");
  if (problems.length) throw new UsageError(`the application is not valid: ${problems.join("; ")}`);
  let apiKey: string | undefined;
  if (o.includeKey) {
    const path = o.keyPath;
    if (!path || !existsSync(path)) throw new UsageError(`--include-key needs the router key file (${path ?? FILES.key}); it was not found`);
    apiKey = readFileSync(path, "utf8").trim();
  }
  return {
    id: p.id,
    name: p.name,
    // The router appends /chat/completions to this, and the sidecar serves /v1/chat/completions.
    base_url: `${origin}/v1`,
    ...(apiKey ? { api_key: apiKey } : {}),
    ...(p.contact ? { contact: p.contact } : {}),
    ...(p.datacenters.length ? { datacenters: p.datacenters } : {}),
    data_policy: p.data_policy,
    // The sidecar attests a TDX quote. Its /attest is the document the router's attestor reads.
    tee: { kind: "tdx", attestation_url: `${origin}/attest` },
    ...(p.payout_address ? { payout_address: p.payout_address } : {}),
  };
}

/** The application with the key hidden, for the terminal. The file on disk and a submission carry the real body. */
export function masked(a: Application): Application {
  return a.api_key ? { ...a, api_key: "<the contents of router-api-key>" } : a;
}

export type SubmitResult = { id: string; status: string; application_token?: string; next?: string[] };

export async function submitApplication(routerUrl: string, application: Application, fetchImpl: typeof fetch = fetch): Promise<SubmitResult> {
  const origin = normalizeOrigin(routerUrl, "the router URL");
  let res: Response;
  try {
    res = await fetchImpl(`${origin}/api/v1/providers/apply`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(application),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
  } catch (e) {
    throw new SidecarError("SUBMIT_FAILED", `could not reach ${origin}: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: { data?: SubmitResult; error?: { message?: string } } = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* handled below */
  }
  if (!res.ok || !body.data) {
    const why = body.error?.message ?? (text.slice(0, 200) || `HTTP ${res.status}`);
    throw new SidecarError("SUBMIT_REFUSED", `the router answered ${res.status}: ${why}`);
  }
  return body.data;
}

export function saveApplication(dir: string, a: Application): string {
  const path = join(dir, FILES.applicationJson);
  // 0600: the file holds the router key when --include-key was used.
  writeFileSync(path, JSON.stringify(a, null, 2) + "\n", { mode: 0o600 });
  return path;
}
