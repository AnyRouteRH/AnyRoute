// Collects read-only release evidence from a live deployment into a JSON bundle:
//   bun scripts/release-evidence.ts <baseUrl> [--expect-commit <sha>] [--out <dir>]
// Only unauthenticated GET requests to public endpoints, and one TLS handshake. It never sends a
// key, never calls a paid endpoint and never writes to the deployment. The bundle and its SHA-256
// are written to ./release-evidence/ (git-ignored). Exits 1 when a high-severity finding is present
// (not live, not ready, wrong commit, bad or expiring certificate).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import tls from "node:tls";
import { readMigrationFiles } from "drizzle-orm/migrator";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Severity = "high" | "medium" | "low" | "info";
type Finding = { severity: Severity; id: string; detail: string };
type Got = { status: number | null; headers: Headers | null; text: string; json: any; error: string | null };

const ROOT = resolve(import.meta.dir, "..");
const PAGES = ["/", "/docs/", "/dashboard/"];
const HSTS_MIN_SECONDS = 15_552_000; // 180 days

function git(args: string[]) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

async function get(fetcher: Fetch, base: string, path: string, accept = "application/json"): Promise<Got> {
  try {
    const res = await fetcher(new URL(path, base).toString(), { method: "GET", redirect: "follow", headers: { accept, "user-agent": "anyroute-release-evidence/1" }, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, text, json, error: null };
  } catch (e) {
    return { status: null, headers: null, text: "", json: null, error: e instanceof Error ? e.name : "error" };
  }
}

/** Public status without usage metrics, signer addresses or RPC endpoints. */
export function statusSummary(d: any) {
  if (!d || typeof d !== "object") return null;
  const contracts = d.chain?.contracts && typeof d.chain.contracts === "object" ? d.chain.contracts : {};
  return {
    env: d.env ?? null,
    router: d.router ?? null,
    release: d.release ?? null,
    database: d.database ?? null,
    redis: d.redis ?? null,
    chain: { chain_id: d.chain?.chain_id ?? null, usdg: d.chain?.usdg ?? null, contracts, configured_contracts: Object.values(contracts).filter(Boolean).length, signer_roles: Object.keys(d.chain?.signers ?? {}) },
    dev_faucet: d.dev_faucet ?? null,
    receipts: d.receipts ? { key_id: d.receipts.key_id, rotation_days: d.receipts.rotation_days, anchor_interval_ms: d.receipts.anchor_interval_ms } : null,
    settlement: d.settlement ?? null,
    fees: d.fees ?? null,
    paywith: d.paywith ? { configured: !!d.paywith.configured, tokens: Array.isArray(d.paywith.tokens) ? d.paywith.tokens.length : 0 } : null,
    per_call: d.per_call ?? null,
    telemetry: d.telemetry ?? null,
    jobs: Array.isArray(d.jobs) ? d.jobs.map((j: any) => ({ name: j.name, every_ms: j.every_ms, runs: j.runs, last_success: j.last_success, failed: !!j.last_error })) : null,
    catalog: d.catalog ?? null,
  };
}

export function escrowSummary(d: any, now: number) {
  if (!d || typeof d !== "object") return null;
  const tokens: any[] = Array.isArray(d.tokens) ? d.tokens : [];
  const updated = tokens.map((t) => Date.parse(t.price_updated_at)).filter(Number.isFinite);
  return {
    enabled: d.enabled ?? null,
    address: d.address ?? null,
    chain_id: d.chain_id ?? null,
    confirmations: d.confirmations ?? null,
    haircut_bps: d.haircut_bps ?? null,
    tokens: tokens.length,
    symbols: tokens.map((t) => t.symbol),
    tokens_without_price: tokens.filter((t) => t.price_usd == null).length,
    oldest_price_age_h: updated.length ? Math.round((now - Math.min(...updated)) / 360_000) / 10 : null,
    newest_price_age_h: updated.length ? Math.round((now - Math.max(...updated)) / 360_000) / 10 : null,
  };
}

export function securityHeaders(path: string, got: Got, findings: Finding[]) {
  const h = got.headers;
  const header = (name: string) => h?.get(name) ?? null;
  const csp = header("content-security-policy");
  const hsts = header("strict-transport-security");
  const maxAge = hsts ? Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? NaN) : null;
  const xfo = header("x-frame-options");
  const scriptSrc = csp ? (/(?:^|;)\s*script-src([^;]*)/i.exec(csp)?.[1] ?? /(?:^|;)\s*default-src([^;]*)/i.exec(csp)?.[1] ?? "") : "";
  const out = {
    path,
    status: got.status,
    content_type: header("content-type"),
    content_security_policy: csp
      ? { present: true, sha256: createHash("sha256").update(csp).digest("hex"), length: csp.length, frame_ancestors_none: /frame-ancestors\s+'none'/i.test(csp), object_src_none: /object-src\s+'none'/i.test(csp), base_uri_restricted: /base-uri\s/i.test(csp), script_src_unsafe_inline: /'unsafe-inline'/i.test(scriptSrc), script_src_unsafe_eval: /'unsafe-eval'/i.test(scriptSrc) }
      : { present: false },
    x_frame_options: xfo,
    x_content_type_options: header("x-content-type-options"),
    referrer_policy: header("referrer-policy"),
    strict_transport_security: hsts ? { value: hsts, max_age: maxAge, include_subdomains: /includesubdomains/i.test(hsts), preload: /preload/i.test(hsts) } : null,
    permissions_policy: header("permissions-policy"),
    cross_origin_opener_policy: header("cross-origin-opener-policy"),
  };
  if (got.status === null) findings.push({ severity: "high", id: `headers${path}.unreachable`, detail: `${path} could not be fetched (${got.error}).` });
  else if (got.status >= 400) findings.push({ severity: "medium", id: `headers${path}.status`, detail: `${path} returned HTTP ${got.status}.` });
  if (got.status !== null) {
    if (!csp) findings.push({ severity: "medium", id: `headers${path}.csp_missing`, detail: `${path} has no Content-Security-Policy.` });
    else if (out.content_security_policy.present && (out.content_security_policy as any).script_src_unsafe_inline) findings.push({ severity: "low", id: `headers${path}.csp_unsafe_inline`, detail: `${path} CSP allows inline scripts.` });
    if (!/^(deny|sameorigin)$/i.test(xfo ?? "") && !(csp && /frame-ancestors/i.test(csp))) findings.push({ severity: "medium", id: `headers${path}.framing`, detail: `${path} does not forbid framing.` });
    if ((out.x_content_type_options ?? "").toLowerCase() !== "nosniff") findings.push({ severity: "medium", id: `headers${path}.nosniff_missing`, detail: `${path} lacks X-Content-Type-Options: nosniff.` });
    if (!out.referrer_policy) findings.push({ severity: "low", id: `headers${path}.referrer_policy_missing`, detail: `${path} has no Referrer-Policy.` });
    if (!hsts) findings.push({ severity: "medium", id: `headers${path}.hsts_missing`, detail: `${path} has no Strict-Transport-Security header.` });
    else if (!(maxAge! >= HSTS_MIN_SECONDS)) findings.push({ severity: "low", id: `headers${path}.hsts_short`, detail: `${path} HSTS max-age is below 180 days.` });
    if (!out.permissions_policy) findings.push({ severity: "info", id: `headers${path}.permissions_policy_missing`, detail: `${path} has no Permissions-Policy.` });
  }
  return out;
}

export async function tlsCertificate(host: string, port = 443): Promise<Record<string, unknown>> {
  return await new Promise((resolveCert) => {
    const socket = tls.connect({ host, port, servername: host, timeout: 15_000 }, () => {
      const x509 = (socket as unknown as { getPeerX509Certificate?: () => any }).getPeerX509Certificate?.();
      const cert = socket.getPeerCertificate(false) as any;
      const validTo = x509?.validTo ?? cert?.valid_to ?? null;
      const expires = validTo ? Date.parse(validTo) : NaN;
      resolveCert({
        host,
        protocol: socket.getProtocol?.() ?? null,
        authorized: socket.authorized,
        authorization_error: socket.authorizationError ? String(socket.authorizationError) : null,
        issuer: x509?.issuer ?? (cert?.issuer ? Object.entries(cert.issuer).map(([k, v]) => `${k}=${v}`).join("\n") : null),
        subject: x509?.subject ?? (cert?.subject ? Object.entries(cert.subject).map(([k, v]) => `${k}=${v}`).join("\n") : null),
        subject_alt_names: x509?.subjectAltName ?? cert?.subjectaltname ?? null,
        valid_from: x509?.validFrom ?? cert?.valid_from ?? null,
        valid_to: validTo,
        days_remaining: Number.isFinite(expires) ? Math.floor((expires - Date.now()) / 86_400_000) : null,
        fingerprint256: x509?.fingerprint256 ?? cert?.fingerprint256 ?? null,
      });
      socket.end();
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolveCert({ host, error: "timeout" });
    });
    socket.on("error", (e) => resolveCert({ host, error: e.name }));
  });
}

export function lastMigration(folder = resolve(ROOT, "drizzle")) {
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  const journal = JSON.parse(readFileSync(resolve(folder, "meta/_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
  const last = migrations.at(-1);
  const entry = journal.entries.at(-1);
  return {
    count: migrations.length,
    tag: entry?.tag ?? null,
    folder_millis: last?.folderMillis ?? null,
    // drizzle's hash: sha256 of the migration SQL. The production API refuses to start unless the
    // database's latest applied migration has this hash, so a ready API running the same commit as
    // this checkout implies this migration is applied.
    hash: last?.hash ?? null,
  };
}

export async function collectEvidence(baseUrl: string, opts: { expectCommit?: string; fetch?: Fetch; tls?: boolean; now?: Date } = {}) {
  const base = new URL(baseUrl);
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(base.hostname);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) throw new Error("baseUrl must be https (http only for a loopback address).");
  if (base.username || base.password || base.search || base.hash) throw new Error("baseUrl must not carry credentials, a query or a fragment.");
  const origin = base.origin + "/";
  const fetcher: Fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? new Date();
  const findings: Finding[] = [];
  const notes: string[] = [];

  const [health, ready, metrics, status, escrow, models, providers, ...pages] = await Promise.all([
    get(fetcher, origin, "/health"),
    get(fetcher, origin, "/ready"),
    get(fetcher, origin, "/ready/metrics", "text/plain"),
    get(fetcher, origin, "/api/v1/status"),
    get(fetcher, origin, "/api/v1/escrow"),
    get(fetcher, origin, "/api/v1/models"),
    get(fetcher, origin, "/api/v1/providers"),
    ...PAGES.map((p) => get(fetcher, origin, p, "text/html")),
  ]);

  if (health.status !== 200 || health.json?.ok !== true) findings.push({ severity: "high", id: "health", detail: `/health returned ${health.status ?? health.error}.` });
  const checks: Record<string, boolean> = ready.json?.checks && typeof ready.json.checks === "object" ? ready.json.checks : {};
  const failing = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k).sort();
  if (ready.status !== 200 || ready.json?.ok !== true) findings.push({ severity: "high", id: "ready", detail: `/ready returned ${ready.status ?? ready.error}${failing.length ? `; failing: ${failing.join(", ")}` : ""}.` });

  const metricChecks: Record<string, number> = {};
  let anyrouteReady: number | null = null;
  if (metrics.status === 200) {
    for (const line of metrics.text.split("\n")) {
      const c = /^anyroute_readiness_check\{check="([a-z_-]+)"\}\s+(\d+)$/.exec(line.trim());
      if (c) metricChecks[c[1]] = Number(c[2]);
      const r = /^anyroute_ready\s+(\d+)$/.exec(line.trim());
      if (r) anyrouteReady = Number(r[1]);
    }
    if (anyrouteReady !== null) findings.push({ severity: "info", id: "ready_metrics.public", detail: "/ready/metrics is reachable without credentials (readiness booleans only); restrict it at the edge if it should stay private." });
  }

  const statusData = status.json?.data;
  const summary = statusSummary(statusData);
  if (!summary) findings.push({ severity: "medium", id: "status", detail: `/api/v1/status returned ${status.status ?? status.error}.` });
  const liveCommit: string | null = typeof statusData?.release?.commit === "string" ? statusData.release.commit.toLowerCase() : null;
  const repoCommit = git(["rev-parse", "HEAD"]);
  const repoDirty = git(["status", "--porcelain", "--untracked-files=no"]);
  const expected = opts.expectCommit?.toLowerCase() ?? null;
  const prefixMatch = (a: string | null, b: string | null) => (a && b ? a.startsWith(b) || b.startsWith(a) : null);
  const liveMatchesExpected = prefixMatch(liveCommit, expected);
  if (!statusData?.release) findings.push({ severity: "medium", id: "release.not_exposed", detail: "The deployment does not report its release; it predates the release field." });
  else if (!liveCommit) findings.push({ severity: "medium", id: "release.commit_unset", detail: "The deployment does not report its commit; set RELEASE_COMMIT." });
  if (expected && liveMatchesExpected !== true) findings.push({ severity: "high", id: "release.commit_mismatch", detail: `Expected commit ${expected}, live reports ${liveCommit ?? "none"}.` });
  if (summary?.env && summary.env !== "production") findings.push({ severity: "high", id: "status.env", detail: `The deployment reports env ${summary.env}.` });
  if (summary?.dev_faucet) findings.push({ severity: "high", id: "status.dev_faucet", detail: "The development faucet is enabled." });

  const contracts = summary?.chain.configured_contracts ?? 0;
  const deployment = statusData?.release?.deployment?.status ?? (contracts ? "unknown" : "none");
  if (contracts && deployment !== "verified") findings.push({ severity: "high", id: "contracts.unverified", detail: `Contracts are configured but the deployment status is ${deployment}.` });
  if (!contracts) notes.push("No Anyroute contract addresses are configured (escrow/no-contract mode): protocol deployment and governance evidence (H-02) does not apply to this release.");

  const securityHeadersEvidence = PAGES.map((p, i) => securityHeaders(p, pages[i], findings));
  let tlsEvidence: Record<string, unknown> | null = null;
  if (base.protocol === "https:" && opts.tls !== false) {
    tlsEvidence = await tlsCertificate(base.hostname, Number(base.port || 443));
    if (tlsEvidence.error || tlsEvidence.authorized !== true) findings.push({ severity: "high", id: "tls.untrusted", detail: `TLS certificate is not trusted (${tlsEvidence.error ?? tlsEvidence.authorization_error}).` });
    else if (typeof tlsEvidence.days_remaining === "number" && tlsEvidence.days_remaining < 14) findings.push({ severity: tlsEvidence.days_remaining < 0 ? "high" : "medium", id: "tls.expiry", detail: `TLS certificate expires in ${tlsEvidence.days_remaining} days.` });
  }

  const migrations = lastMigration();
  if (liveCommit && repoCommit && prefixMatch(liveCommit, repoCommit)) notes.push(`The live commit matches this checkout, so the production database is at migration ${migrations.tag} (the API refuses to start otherwise).`);
  else notes.push("The live commit is unknown or differs from this checkout, so the applied migration is not established by this bundle.");
  notes.push("Collected with unauthenticated GET requests only; no key, paid call or write was made.");

  const severityOrder: Severity[] = ["high", "medium", "low", "info"];
  findings.sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity) || a.id.localeCompare(b.id));
  return {
    schema: "anyroute.release-evidence/v1",
    collected_at: now.toISOString(),
    target: { base_url: base.origin, host: base.hostname },
    collector: { tool: "scripts/release-evidence.ts", repo_commit: repoCommit, repo_dirty: repoDirty === null ? null : repoDirty.length > 0, bun: typeof Bun !== "undefined" ? Bun.version : null },
    release: { live_commit: liveCommit, expected_commit: expected, repo_commit: repoCommit, live_matches_expected: liveMatchesExpected, live_matches_repo: prefixMatch(liveCommit, repoCommit), contracts_deployment: deployment },
    health: { status: health.status, body: health.json, error: health.error },
    readiness: { status: ready.status, ok: ready.json?.ok ?? null, checks, failing, error: ready.error },
    readiness_metrics: { status: metrics.status, reachable: metrics.status === 200 && anyrouteReady !== null, anyroute_ready: anyrouteReady, checks: metricChecks },
    status: summary,
    escrow: escrowSummary(escrow.json?.data, now.getTime()),
    catalog: {
      models: Array.isArray(models.json?.data) ? models.json.data.length : null,
      providers: Array.isArray(providers.json?.data) ? providers.json.data.length : null,
      status_models: summary?.catalog?.models ?? null,
      status_providers: summary?.catalog?.providers ?? null,
    },
    security_headers: securityHeadersEvidence,
    tls: tlsEvidence,
    migrations,
    findings,
    notes,
  };
}

export function writeEvidence(bundle: { collected_at: string; target: { host: string } }, outDir = resolve(process.cwd(), "release-evidence")) {
  mkdirSync(outDir, { recursive: true });
  const name = `${bundle.target.host}-${bundle.collected_at.replace(/[:.]/g, "-")}.json`;
  const path = resolve(outDir, name);
  const text = JSON.stringify(bundle, null, 2) + "\n";
  const sha256 = createHash("sha256").update(text).digest("hex");
  writeFileSync(path, text, { flag: "wx" });
  writeFileSync(`${path}.sha256`, `${sha256}  ${basename(path)}\n`, { flag: "wx" });
  return { path, sha256 };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const baseUrl = args.find((a, i) => !a.startsWith("--") && !["--expect-commit", "--out"].includes(args[i - 1] ?? ""));
  const expectCommit = option("--expect-commit");
  if (!baseUrl || (expectCommit !== undefined && !/^[0-9a-f]{7,40}$/i.test(expectCommit))) {
    console.error("Usage: bun scripts/release-evidence.ts <baseUrl> [--expect-commit <sha>] [--out <dir>]");
    process.exit(2);
  }
  const bundle = await collectEvidence(baseUrl, { expectCommit });
  const out = option("--out");
  const { path, sha256 } = writeEvidence(bundle, out ? resolve(out) : undefined);
  const counts = bundle.findings.reduce<Record<string, number>>((a, f) => ({ ...a, [f.severity]: (a[f.severity] ?? 0) + 1 }), {});
  console.log(JSON.stringify({ path, sha256, ready: bundle.readiness.ok, live_commit: bundle.release.live_commit, findings: counts }, null, 2));
  if (bundle.findings.some((f) => f.severity === "high")) process.exitCode = 1;
}
