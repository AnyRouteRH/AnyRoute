import { X509Certificate, randomBytes } from "node:crypto";
import {
  evaluateAttestation,
  fetchRouterAttestation,
  verifySidecarReceipt,
  type AttestDocument,
  type AttestFetcher,
  type BoundIdentity,
  type ReceiptEnvelope,
  type RouterAttestation,
} from "../../../packages/client/src/index.ts";
import { nodeAttestFetcher } from "../../../packages/client/src/node.ts";
import { sha256Hex } from "../util.ts";
import { endpointOrigin } from "./spec.ts";

// `doctor`: checks a running sidecar the way a router or a user's client would, using the client SDK's own checks, and says
// what is wrong in words. It reads the sidecar's evidence and certificate first; the router key is sent only over a
// connection whose certificate that evidence proves belongs to the attested instance, and never otherwise.

export type DoctorStatus = "pass" | "fail" | "warn" | "skip";
export type DoctorCheck = { id: string; status: DoctorStatus; title: string; detail: string };
export type DoctorReport = { ok: boolean; url: string; checks: DoctorCheck[]; bound: BoundIdentity | null; notChecked: string[] };

export type DoctorOptions = {
  url: string;
  /** The raw router key. Without it the authenticated checks are skipped. */
  key?: string;
  expected?: { modelDigest?: string; modelDigestSource?: string; imageDigest?: string; composeHash?: string };
  /** Digests sidecar.yaml lists; the served digest must be one of them. */
  allowlist?: string[];
  /** SHA-256 the sidecar is configured to accept for the router key. */
  keySha256?: string;
  /** The model name to send in the test request. Default: the first model the sidecar lists. */
  model?: string;
  chat?: boolean;
  /** Also read the router's record for this provider. */
  router?: { url: string; providerId: string };
  /** Accept simulated (development) evidence. Only for a sidecar run on purpose in development mode. */
  allowSimulated?: boolean;
  attestFetcher?: AttestFetcher;
  fetchImpl?: typeof fetch;
  nonceHex?: string;
  now?: () => number;
};

const TITLES: Record<string, string> = {
  "provider.simulated": "evidence is from real hardware",
  "provider.bindings": "/attest names its keys and digests",
  "provider.quote": "the quote is an Intel TDX quote",
  "provider.ref_is_quote_hash": "attestation reference is the quote's hash",
  "provider.san_is_ref": "certificate name is derived from the quote",
  "provider.report_data": "the quote commits to the keys and digests",
  "provider.measurements": "measurement registers match the quote",
  "provider.fresh_quote": "a fresh quote for our nonce (the enclave is live)",
  "provider.receipt_key": "receipts are signed by the attested key",
  "provider.tls_san": "certificate carries the attestation name",
  "provider.tls_key": "certificate key is the key in the quote",
  "provider.tls_valid": "certificate is inside its validity period",
  "expected.model": "served weights equal the weights you hashed",
  "expected.image": "image digest is the one you pinned",
  "expected.compose": "compose hash is the one you expect",
  "expected.mrtd": "MRTD is the one you expect",
  "expected.rtmr3": "RTMR3 is the one you expect",
  "quote.signature": "Intel's signature over the quote",
  "router.status": "router: provider is attested",
  "router.quote_verified": "router: verified the quote",
  "router.digests_recorded": "router: recorded the digests",
  "router.fresh": "router: verification is recent",
  "router.matches_provider": "router: its digests match /attest",
};

const TRANSPORT_CHECKS = ["provider.bindings", "provider.report_data", "provider.tls_san", "provider.tls_key", "provider.tls_valid"];

const short = (v: string) => (v.length > 26 ? `${v.slice(0, 18)}…${v.slice(-6)}` : v);
const fromDetail = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runDoctor(o: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (id: string, status: DoctorStatus, title: string, detail: string) => void checks.push({ id, status, title, detail });
  const report = (bound: BoundIdentity | null, notChecked: string[] = []): DoctorReport => ({ ok: !checks.some((c) => c.status === "fail"), url: origin ?? o.url, checks, bound, notChecked });

  let origin: string | undefined;
  try {
    origin = endpointOrigin(o.url);
    if (new URL(origin).protocol !== "https:") throw new Error("a sidecar serves TLS; give an https URL");
    add("endpoint", "pass", "endpoint address", origin);
  } catch (e) {
    add("endpoint", "fail", "endpoint address", fromDetail(e));
    return report(null);
  }

  // 1. /attest, twice: the boot quote, and a fresh one for a nonce we choose. The same connection also hands back the certificate.
  const get = o.attestFetcher ?? nodeAttestFetcher();
  let boot: AttestDocument;
  let fresh: { doc: AttestDocument; nonceHex: string } | null = null;
  let certificate: Uint8Array | null = null;
  try {
    const r = await get(`${origin}/attest`);
    boot = r.json as AttestDocument;
    certificate = r.certificate ?? null;
    const nonceHex = o.nonceHex ?? randomBytes(32).toString("hex");
    const f = await get(`${origin}/attest?nonce=${nonceHex}`);
    fresh = { doc: f.json as AttestDocument, nonceHex };
    if (r.certificate && f.certificate && Buffer.compare(Buffer.from(r.certificate), Buffer.from(f.certificate)) !== 0) throw new Error("the two /attest requests were served with different certificates");
  } catch (e) {
    add("attest.fetch", "fail", "GET /attest", `${fromDetail(e)}. Is the sidecar running, is the port reachable, and does the URL end in the TLS-passthrough name (Phala: <app_id>-8443s.<gateway domain>)?`);
    return report(null);
  }
  add("attest.fetch", "pass", "GET /attest", "boot quote and a fresh quote were served");

  // 2. The router's own record, when asked for.
  let routerRecord: RouterAttestation | null = null;
  if (o.router) {
    try {
      routerRecord = await fetchRouterAttestation(o.router.url, o.router.providerId, o.fetchImpl ?? fetch);
      if (!routerRecord) add("router.record", "warn", "router's record", `the router has no record of "${o.router.providerId}" yet. It appears once your application is approved.`);
    } catch (e) {
      add("router.record", "warn", "router's record", `the router could not be read: ${fromDetail(e)}`);
    }
  } else {
    add("router.record", "skip", "router's record", "no router given (--router and --id); the router verifies your endpoint after your application is approved");
  }

  // 3. The client SDK's evaluation of the evidence: keys, digests, quote binding, certificate.
  const ev = await evaluateAttestation(
    { providerId: o.router?.providerId ?? "(unregistered)", router: routerRecord, boot, fresh, certificate },
    {
      allowSimulated: o.allowSimulated,
      requireCertificate: true,
      now: o.now,
      expected: { modelDigest: o.expected?.modelDigest, imageDigest: o.expected?.imageDigest, composeHash: o.expected?.composeHash },
    },
  );
  for (const c of ev.checks) {
    if (c.id.startsWith("router.") && !routerRecord) continue; // nothing to judge without a record
    if (c.id === "expected.model" && c.status === "pass") {
      add(c.id, "pass", TITLES[c.id], `${short(ev.bound?.modelDigest ?? "")} equals the digest of ${o.expected?.modelDigestSource ?? "the weights you hashed"}`);
      continue;
    }
    if (c.id === "expected.model" && c.status === "fail") {
      add(c.id, "fail", TITLES[c.id], `${c.detail} Served: ${ev.bound?.modelDigest ?? "unknown"}; expected (${o.expected?.modelDigestSource ?? "your weights"}): ${o.expected?.modelDigest}. The weights the sidecar hashed are not the ones you hashed here.`);
      continue;
    }
    const status: DoctorStatus = c.status === "pass" ? "pass" : c.status === "fail" ? "fail" : "skip";
    add(c.id, status, TITLES[c.id] ?? c.id, c.detail);
  }
  const bound = ev.bound;
  if (bound && o.allowlist?.length) {
    const listed = o.allowlist.includes(bound.modelDigest);
    add("digest.allowlist", listed ? "pass" : "fail", "served digest is on sidecar.yaml's allow-list", listed ? short(bound.modelDigest) : `${bound.modelDigest} is not listed in sidecar.yaml. The deployed configuration is not the one init wrote.`);
  }

  // 4. Certificate details that the router does not check but a client might.
  let pem: string | null = null;
  if (certificate) {
    try {
      const x = new X509Certificate(Buffer.from(certificate));
      pem = x.toString();
      const host = new URL(origin).hostname;
      const names = (x.subjectAltName ?? "").split(",").map((s) => s.trim().replace(/^(DNS|IP Address):/, "").toLowerCase());
      add("tls.hostname", names.includes(host.toLowerCase()) ? "pass" : "warn", "certificate names the host you reached", names.includes(host.toLowerCase()) ? host : `${host} is not in the certificate (${names.filter((n) => !n.endsWith(".attest.anyroute")).join(", ") || "no other names"}). The router pins the certificate and does not check names, but a client that does will refuse it: add the name to server.hostnames.`);
      const days = (new Date(x.validTo).getTime() - (o.now?.() ?? Date.now())) / 86_400_000;
      add("tls.expiry", days > 3 ? "pass" : "warn", "certificate is not about to expire", `expires ${new Date(x.validTo).toISOString()}. The sidecar makes a new key and certificate at every start.`);
    } catch (e) {
      add("tls.hostname", "fail", "certificate can be read", fromDetail(e));
    }
  }

  // 5. Everything below talks to the sidecar over the certificate it presented. A request that carries the router key goes
  //    out only when the evidence proves that certificate belongs to the attested instance.
  const transportOk = !!pem && TRANSPORT_CHECKS.every((id) => ev.checks.find((c) => c.id === id)?.status === "pass") && (ev.simulated ? o.allowSimulated === true : true);
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${origin}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000), redirect: "error", tls: { ca: pem!, checkServerIdentity: () => undefined } } as RequestInit);

  if (!pem) {
    add("healthz", "skip", "GET /healthz", "no certificate to talk to the sidecar with");
  } else {
    try {
      const res = await call("/healthz", { headers: { accept: "application/json" } });
      const body = (await res.json().catch(() => ({}))) as { status?: string; upstream?: string; model_digest?: string; dev?: boolean; receipts?: { dropped?: number } };
      if (res.status === 200 && body.status === "ok") add("healthz", "pass", "GET /healthz", `ok; the model server answers${body.receipts?.dropped ? `; ${body.receipts.dropped} receipts were dropped (the queue is full)` : ""}`);
      else add("healthz", "fail", "GET /healthz", `HTTP ${res.status}, status ${body.status ?? "unknown"}, model server ${body.upstream ?? "unknown"}. The sidecar is up but the model server behind it does not answer /v1/models.`);
      if (bound && body.model_digest) {
        const same = body.model_digest === bound.modelDigest;
        add("digest.healthz", same ? "pass" : "fail", "/healthz and /attest report the same weights", same ? short(body.model_digest) : `/healthz says ${body.model_digest}, /attest binds ${bound.modelDigest}`);
      }
      if (body.dev === true && !o.allowSimulated) add("healthz.dev", "fail", "development mode is off", "/healthz reports dev mode: the evidence is simulated");
    } catch (e) {
      add("healthz", "fail", "GET /healthz", fromDetail(e));
    }
  }

  const authed = (extra: HeadersInit = {}) => ({ authorization: `Bearer ${o.key}`, ...(extra as Record<string, string>) });
  if (pem) {
    try {
      const res = await call("/v1/models");
      await res.arrayBuffer().catch(() => {});
      add("auth.required", res.status === 401 ? "pass" : "fail", "requests without a key are refused", res.status === 401 ? "HTTP 401" : `HTTP ${res.status}: the sidecar answers without a key, so anyone who finds this address can use your model`);
    } catch (e) {
      add("auth.required", "fail", "requests without a key are refused", fromDetail(e));
    }
  }

  if (!o.key) {
    add("auth.key", "skip", "the router key is accepted", "no key given (--key-file)");
    add("receipt", "skip", "a response carries a valid signed receipt", "no key given (--key-file)");
    return report(bound, ev.notChecked);
  }
  if (o.keySha256 && sha256Hex(o.key) !== o.keySha256) add("auth.key_hash", "fail", "key matches sidecar.yaml", "the key file's SHA-256 is not the one in sidecar.yaml: this is not the key that deployment was written for");
  else if (o.keySha256) add("auth.key_hash", "pass", "key matches sidecar.yaml", "SHA-256 equal");
  if (!transportOk) {
    add("auth.key", "skip", "the router key is accepted", "not sent: the certificate is not proven to belong to the attested instance (see the failed checks above)");
    add("receipt", "skip", "a response carries a valid signed receipt", "not sent, for the same reason");
    return report(bound, ev.notChecked);
  }

  let model = o.model;
  try {
    const res = await call("/v1/models", { headers: authed({ accept: "application/json" }) });
    const body = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
    if (res.status === 200) {
      add("auth.key", "pass", "the router key is accepted", "GET /v1/models returned 200");
      model ??= body.data?.[0]?.id;
    } else if (res.status === 401) add("auth.key", "fail", "the router key is accepted", "HTTP 401: the sidecar does not recognise this key (its SHA-256 is not in sidecar.yaml's auth.keys)");
    else add("auth.key", "fail", "the router key is accepted", `GET /v1/models returned HTTP ${res.status}; the model server behind the sidecar may be down`);
  } catch (e) {
    add("auth.key", "fail", "the router key is accepted", fromDetail(e));
  }

  const keyRefused = checks.some((c) => c.id === "auth.key" && c.status === "fail");
  if (o.chat === false) add("receipt", "skip", "a response carries a valid signed receipt", "skipped (--no-chat)");
  else if (keyRefused) add("receipt", "skip", "a response carries a valid signed receipt", "not attempted: the router key was refused above");
  else if (!model) add("receipt", "skip", "a response carries a valid signed receipt", "no model name to ask for: pass --model");
  else if (bound) await receiptCheck();
  return report(bound, ev.notChecked);

  async function receiptCheck() {
    const body = JSON.stringify({ model, messages: [{ role: "user", content: "Reply with the single word: ok" }], max_tokens: 8, stream: false });
    try {
      const res = await call("/v1/chat/completions", { method: "POST", headers: authed({ "content-type": "application/json", "accept-encoding": "identity" }), body, signal: AbortSignal.timeout(180_000) });
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (res.status !== 200) {
        const msg = (() => {
          try {
            return (JSON.parse(new TextDecoder().decode(bytes)) as { error?: { message?: string } }).error?.message;
          } catch {
            return undefined;
          }
        })();
        add("receipt", "fail", "a response carries a valid signed receipt", `HTTP ${res.status}${msg ? `: ${msg}` : ""}`);
        return;
      }
      const header = res.headers.get("x-anyroute-receipt");
      if (!header) {
        add("receipt", "fail", "a response carries a valid signed receipt", "the response has no x-anyroute-receipt header");
        return;
      }
      const envelope = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as ReceiptEnvelope;
      const v = await verifySidecarReceipt(envelope, bound!);
      const problems = v.checks.filter((c) => c.status === "fail").map((c) => c.detail);
      if (envelope.payload.req_hash !== `sha256:${sha256Hex(body)}`) problems.push("req_hash is not the SHA-256 of the request we sent");
      if (envelope.payload.resp_hash !== `sha256:${sha256Hex(bytes)}`) problems.push("resp_hash is not the SHA-256 of the response we received");
      if (problems.length || !v.valid) add("receipt", "fail", "a response carries a valid signed receipt", problems.join("; ") || "the signature does not verify");
      else add("receipt", "pass", "a response carries a valid signed receipt", `signed by the attested key ${envelope.key_id}; it names this attestation and model digest, and its request and response hashes match the bytes exchanged`);
    } catch (e) {
      add("receipt", "fail", "a response carries a valid signed receipt", fromDetail(e));
    }
  }
}

const MARK: Record<DoctorStatus, string> = { pass: "PASS", fail: "FAIL", warn: "WARN", skip: "SKIP" };

export function formatReport(r: DoctorReport): string {
  const out = [`doctor ${r.url}`, ""];
  for (const c of r.checks) out.push(`${MARK[c.status]}  ${c.title}${c.detail ? `\n      ${c.detail}` : ""}`);
  const n = (s: DoctorStatus) => r.checks.filter((c) => c.status === s).length;
  out.push("", `${r.ok ? "OK" : "NOT OK"}: ${n("pass")} passed, ${n("fail")} failed, ${n("warn")} warnings, ${n("skip")} skipped.`);
  if (r.notChecked.length) out.push("", "Not checked by this tool:", ...r.notChecked.map((x) => `  - ${x}`));
  return out.join("\n");
}
