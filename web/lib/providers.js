// Providers page: pure helpers (no React), shared by components/Providers.jsx and its tests.
// The list is what the router reports at GET /api/v1/providers. Its `attestation` object is the router's own status,
// computed the way GET /api/v1/attestation/:providerId computes it. A provider is "Attested" here only when the router
// says so; a missing or unreadable field never upgrades a provider, and a router that predates the `attestation` object
// is read conservatively from the older fields.

import { relativeTime, teeLabel, verifyHref } from "./verify.js";

export const PROVIDERS_PATH = "/api/v1/providers";

const VERIFIER_LABELS = {
  dcap: "DCAP: Intel's signature and certificate chain over the quote",
  "intel-ta": "Intel Trust Authority",
  dstack: "dstack: the deployment's compose hash against its event log",
  phala: "Phala's public quote verifier",
};
export const verifierLabel = (id) => VERIFIER_LABELS[id] || String(id);

const REASONS = {
  no_attestation: "The router has never verified this provider.",
  last_attempt_failed: "The router's most recent attempt to verify this provider failed.",
  attestation_stale: "The router's last successful verification is too old to count.",
  simulated_evidence_refused: "The only evidence is simulated (development) evidence, which this router does not accept.",
};

const STATUS_LABEL = { attested: "Attested", simulated: "Simulated", unverified: "Unverified" };
const ORDER = { attested: 0, simulated: 1, unverified: 2 };
const LIFECYCLE = { live: "Live", shadow: "Shadow (being tested)", suspended: "Suspended", delisted: "Delisted" };

const iso = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : "");

/** The router's attestation summary for one listed provider, from the new object or (older routers) the flat fields. */
export function attestationOf(p) {
  const a = p?.attestation;
  if (a && typeof a === "object") {
    const status = a.status === "attested" || a.status === "simulated" ? a.status : "unverified";
    return {
      status,
      reason: status === "unverified" ? (typeof a.reason === "string" ? a.reason : "") : "",
      tee: typeof a.tee === "string" ? a.tee : "",
      verifiers: status === "attested" && Array.isArray(a.verifiers) ? a.verifiers.filter((v) => typeof v === "string") : [],
      lastVerifiedAt: iso(a.last_verified_at),
      lastAttemptAt: iso(a.last_attempt_at),
      lastAttemptOk: typeof a.last_attempt_ok === "boolean" ? a.last_attempt_ok : null,
      verifiersReported: true,
    };
  }
  // Older router: only a freshness flag, the declared kind and a time. Simulated evidence is never shown as attested.
  const kind = typeof p?.tee === "string" ? p.tee : "";
  const fresh = p?.attestation_fresh === true;
  const status = fresh ? (kind === "dev" ? "simulated" : "attested") : "unverified";
  return { status, reason: status === "unverified" ? (p?.attested_at ? "attestation_stale" : "no_attestation") : "", tee: kind, verifiers: [], lastVerifiedAt: iso(p?.attested_at), lastAttemptAt: "", lastAttemptOk: null, verifiersReported: false };
}

function teeText(a) {
  if (a.status === "attested") return teeLabel(a.tee);
  if (a.status === "simulated") return "None: simulated for development";
  return a.tee && a.tee !== "dev" ? `Declared: ${teeLabel(a.tee)}. Not verified.` : "Not established";
}

function lastText(a, now) {
  const when = relativeTime(a.lastVerifiedAt, now);
  if (a.status === "attested" || a.status === "simulated") return when ? `Verified ${when}` : "Verified (time not reported)";
  const attempt = a.lastAttemptOk === false && a.lastAttemptAt ? ` Latest attempt failed ${relativeTime(a.lastAttemptAt, now)}.` : "";
  return (when ? `Last verified ${when}, too long ago to count.` : "Never verified.") + attempt;
}

/** One row per provider for the page, with the honest words already chosen. */
export function describeProviders(list, now = Date.now()) {
  const rows = (Array.isArray(list) ? list : [])
    .filter((p) => p && typeof p.slug === "string" && p.slug)
    .map((p) => {
      const a = attestationOf(p);
      return {
        id: p.slug,
        name: typeof p.name === "string" && p.name ? p.name : p.slug,
        lifecycle: LIFECYCLE[p.status] || String(p.status || ""),
        status: a.status,
        statusLabel: STATUS_LABEL[a.status],
        tee: teeText(a),
        verifiers: a.verifiers.map((id) => ({ id, label: verifierLabel(id) })),
        verifiersNote: a.status === "attested" ? (a.verifiersReported ? (a.verifiers.length ? "" : "The router did not name a verifier.") : "This router does not report which verifiers accepted the quote.") : "No verifier has accepted a quote for this provider.",
        last: lastText(a, now),
        lastAt: a.lastVerifiedAt,
        reason: a.status === "unverified" ? REASONS[a.reason] || "The router has no current verification for this provider." : "",
        models: Number.isInteger(p.models) ? p.models : 0,
        declared: { training: p.data_policy?.training === true, retainsPrompts: p.data_policy?.retains_prompts === true },
        href: verifyHref(p.slug),
      };
    })
    .sort((x, y) => ORDER[x.status] - ORDER[y.status] || x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
  const count = (s) => rows.filter((r) => r.status === s).length;
  return { rows, counts: { total: rows.length, attested: count("attested"), simulated: count("simulated"), unverified: count("unverified") } };
}

/** `status` is "all", "attested" or "unverified" (everything not attested); `query` matches the name or id. */
export function filterProviders(rows, { status = "all", query = "" } = {}) {
  const q = String(query).trim().toLowerCase();
  return rows.filter((r) => (status === "all" || (status === "attested" ? r.status === "attested" : r.status !== "attested")) && (!q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)));
}

export const QUICKSTART = `git clone https://github.com/AnyRouteRH/AnyRoute.git && cd AnyRoute
bun sidecar/src/cli.ts init`;

export const QUICKSTART_FLAGS = `bun sidecar/src/cli.ts init --yes --target phala-gpu \\
  --weights ./my-model --hf-repo <owner/name> --hf-revision <40-hex commit> \\
  --model-image <vllm image>@sha256:<digest> --id my-model

bun sidecar/src/cli.ts doctor --dir anyroute-provider --url https://<your endpoint>
bun sidecar/src/cli.ts apply  --dir anyroute-provider --url https://<your endpoint> --router https://<router> --submit`;
