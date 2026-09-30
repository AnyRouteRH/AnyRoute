import { sidecarHostPolicyBindings } from "../network/sidecar-bindings.ts";
import { and, eq, isNotNull, inArray, or } from "drizzle-orm";
import { probationDiscovery, probationRegistryFilter } from "../network/offers.ts";
import { renewHostAttestation } from "../network/renew-attestation.ts";
import { boundedJson, peekProviderCertificate, providerFetch } from "../providers/network.ts";
import { clearTlsPin, describePeerCertificate, saveTlsPin, type PeerCertificate } from "../providers/tls-pin.ts";
import { randomBytes } from "node:crypto";
import type { Ctx } from "../context.ts";
import { attestations, kv, providers } from "../db/schema.ts";
import { canonicalJson, log, sha256 } from "../lib/util.ts";
import { createVerifiers, verifyWithAll, type VerifierInput, type VerifyOutcome } from "./attestor-verifiers.ts";
import { bindingsCommittedIn, digestsFromBindings, recordMeasurement, type Digests } from "./measurements.ts";
import { classifierFromReport, policyHashFromReport } from "../router/lane.ts";
import { clearAttestedPolicy, saveAttestedPolicy } from "../providers/attested-policy.ts";
import { pruneAttestationEvents, recordAttestorRun } from "./attestation-events.ts";
import { checkAciReport, clearAciGateway, isAciReport, saveAciGateway } from "../providers/aci.ts";
import { keyPublished } from "../tlog/hooks.ts";
import { attestationBindingEntry } from "../tlog/entries.ts";

// attestor: every 10 minutes, for each provider with a TEE, fetch a fresh attestation bound to our
// nonce and verify it. Fail closed: anything unverifiable leaves the provider un-attested, and the
// private route (`provider.private` / `:private`) only ever selects freshly attested providers.
//
// Report format (NEAR-AI-style, GET <attestation_url>?nonce=<hex32>):
//   { intel_quote?: hex (TDX v4 quote), snp_report?: hex, nvidia_payload?: string, signing_address?: hex,
//     nonce: hex32 } — "dev" providers return { kind: "dev", nonce, measurement } (non-production only).
// Verification:
//   - the nonce must be bound into the TEE report_data (TDX: bytes 568..632 of the quote)
//   - the quote's certificate chain is checked by the verifiers ATTESTATION_VERIFIERS names: the DCAP service
//     (TDX_VERIFIER_URL, the default), Intel Trust Authority and/or a dstack verifier (attestor-verifiers.ts)
//   - GPU evidence is checked by NVIDIA NRAS (overall attestation result must be true)
//   - measurements (MRTD / RTMR3) must be in the provider's allowlist when one is configured
// A sidecar attestation document ({ type: "anyroute.sidecar.attestation", evidence, bindings }) is accepted as
// well: its quote must also commit to sha256(canonical_json(bindings)) in report_data, and with
// MEASUREMENTS_ENABLED the bound image/compose/model digests are recorded (services/measurements.ts).
//
// Quote-pinned TLS (providers/tls-pin.ts). An https endpoint whose certificate names an attestation reference
// (`<32 hex>.<32 hex>.attest.anyroute`, a sidecar's self-signed certificate) is not checked against public CAs.
// The attestor reads that certificate without sending anything, fetches over a connection that accepts only it,
// and accepts it only if: the endpoint serves the quote whose sha256 is the reference, that quote verifies, its
// report_data commits to bindings whose tls_pubkey is this certificate's key, and the fresh nonce-bound quote binds
// the same key. The certificate is then pinned: every later call to the provider accepts only it. Anything else
// with a self-signed certificate is refused as before, and a sidecar that binds a TLS key but is reached through a
// different certificate is refused too.

export type TdxFields = { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string; rtmr3: string; reportData: string };

export function parseTdxQuote(hex: string): TdxFields {
  const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
  if (b.length < 632) throw new Error(`TDX quote too short (${b.length} bytes)`);
  const version = b.readUInt16LE(0);
  if (version !== 4 && version !== 5) throw new Error(`unsupported quote version ${version}`);
  const body = 48;
  const at = (off: number, len: number) => b.subarray(body + off, body + off + len).toString("hex");
  return { mrtd: at(136, 48), rtmr0: at(328, 48), rtmr1: at(376, 48), rtmr2: at(424, 48), rtmr3: at(472, 48), reportData: at(520, 64) };
}

export function nonceBound(reportData: string, nonce: string, signingAddress?: string) {
  const n = nonce.replace(/^0x/, "").toLowerCase();
  const rd = reportData.toLowerCase();
  if (rd.includes(n)) return true;
  if (signingAddress) {
    const bound = sha256(Buffer.concat([Buffer.from(signingAddress.replace(/^0x/, ""), "hex"), Buffer.from(n, "hex")]));
    if (rd.startsWith(bound)) return true;
  }
  return false;
}

/** Run every configured verifier over the quote. Rejections from any one of them fail the attestation. */
async function verifyQuote(ctx: Ctx, input: VerifierInput): Promise<VerifyOutcome> {
  return verifyWithAll(createVerifiers(ctx.cfg.attestation), input);
}

/** Map a sidecar attestation document onto the report fields this attestor reads. Anything else passes through. */
export function normalizeSidecarReport(report: Record<string, any>): Record<string, any> {
  if (report?.type !== "anyroute.sidecar.attestation") return report;
  const ev = (report.evidence ?? {}) as Record<string, any>;
  const dev = report.dev === true || ev.dev === true;
  return {
    ...report,
    kind: dev ? "dev" : report.kind,
    nonce: ev.nonce ?? report.nonce,
    measurement: ev.measurements?.measurement ?? report.measurement,
    intel_quote: typeof ev.quote === "string" && !dev ? ev.quote : undefined,
    event_log: typeof ev.event_log === "string" ? ev.event_log : undefined,
    sidecar_bindings: report.bindings,
  };
}

async function verifyNvidia(ctx: Ctx, payload: string) {
  const res = await fetch(ctx.cfg.attestation.nrasUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: payload, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return { ok: false, reason: `NRAS HTTP ${res.status}` };
  const j = (await boundedJson(res)) as unknown;
  // NRAS returns [["JWT", "<overall token>"], {...per-GPU tokens}]; read the overall claim.
  const tokens = JSON.stringify(j).match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g) ?? [];
  for (const t of tokens) {
    try {
      const claims = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8"));
      if (claims["x-nvidia-overall-att-result"] === true) return { ok: true };
    } catch {
      /* next */
    }
  }
  return { ok: false, reason: "NRAS overall attestation result was not true" };
}

export async function attestProvider(ctx: Ctx, p: typeof providers.$inferSelect, networkAdmission = false) {
  if (!["shadow", "live"].includes(p.status) && !probationDiscovery(ctx.cfg, p)) throw new Error("Provider requires operator approval before attestation.");
  const nonce = randomBytes(32).toString("hex");
  const url = new URL(p.attestationUrl!);
  url.searchParams.set("nonce", nonce);
  let report: Record<string, any>;
  const fail = async (reason: string, extra: Record<string, unknown> = {}) => {
    await ctx.db.insert(attestations).values({ providerId: p.id, ok: false, teeKind: p.teeKind, nonce, detail: { reason, ...extra } });
    await ctx.db.update(providers).set({ attested: false, updatedAt: new Date() }).where(eq(providers.id, p.id));
    await ctx.db.update(providers).set({ classifierEnabled: false }).where(eq(providers.id, p.id)); // unknown is false
    await clearAttestedPolicy(ctx.db, p.id);
    return { provider: p.id, ok: false, reason };
  };
  const policy = { production: ctx.cfg.production, allowDevelopmentMockLoopback: !ctx.cfg.production };
  // A certificate that names an attestation reference is only as trustworthy as the quote it names: every fetch
  // below accepts exactly that certificate, and the checks further down must prove it.
  let peer: PeerCertificate | null = null;
  // The certificate the endpoint presented, whatever it names (an aci/1 gateway's key must be in its keyset).
  let presented: PeerCertificate | null = null;
  if (url.protocol === "https:") {
    try {
      const described = describePeerCertificate(await peekProviderCertificate(url, policy, AbortSignal.timeout(20_000)));
      presented = described;
      if (described.attestationRef) peer = described;
    } catch {
      peer = null; // an ordinary endpoint (or an unreachable one): the fetch below checks it against public CAs
    }
  }
  const tlsPin = peer ? { certPem: peer.certPem, spkiSha256: peer.spkiSha256 } : null;
  const getReport = async (target: URL) => {
    const res = await providerFetch(target, { redirect: "error", signal: AbortSignal.timeout(20_000) }, { ...policy, tlsPin });
    if (!res.ok) throw Object.assign(new Error(`attestation endpoint HTTP ${res.status}`), { http: true });
    return normalizeSidecarReport((await boundedJson(res)) as Record<string, any>);
  };
  try {
    report = await getReport(url);
  } catch (e) {
    return fail((e as { http?: boolean }).http ? (e as Error).message : `attestation endpoint unreachable: ${(e as Error).message}`);
  }
  const [allow] = await ctx.db.select().from(kv).where(eq(kv.key, `attest-allow:${p.id}`));
  const allowlist = (allow?.value ?? null) as { mrtd?: string[]; rtmr3?: string[]; measurement?: string[] } | null;
  const measurements: Record<string, string> = {};
  let verifiedBy: string[] = [];
  let bound: Digests | null = null;
  let quoteHex: string | null = null;
  let bindingsCommitted = false;

  if (isAciReport(report) && p.teeKind !== "dev") {
    if (peer) return fail("an aci/1 gateway is pinned by the key its keyset lists, not by a self-signed attestation certificate");
    return attestAciGateway(ctx, p, { url, nonce, report, presented, allowlist, fail });
  }
  if (peer && (p.teeKind === "dev" || report.kind === "dev" || !report.intel_quote)) return fail("a self-signed endpoint must prove its certificate with a hardware TDX quote");
  if (p.teeKind === "dev" || report.kind === "dev") {
    if (!ctx.cfg.attestation.allowDev) return fail("dev attestation is disabled");
    if (String(report.nonce).replace(/^0x/, "") !== nonce) return fail("nonce mismatch");
    measurements.measurement = String(report.measurement ?? "");
    if (allowlist?.measurement?.length && !allowlist.measurement.includes(measurements.measurement)) return fail("measurement not in allowlist", measurements);
  } else {
    if (!report.intel_quote && !report.snp_report) return fail("report has no TEE quote");
    if (report.intel_quote) {
      let f: TdxFields;
      try {
        f = parseTdxQuote(report.intel_quote);
      } catch (e) {
        return fail(`unparseable TDX quote: ${(e as Error).message}`);
      }
      Object.assign(measurements, { mrtd: f.mrtd, rtmr0: f.rtmr0, rtmr1: f.rtmr1, rtmr2: f.rtmr2, rtmr3: f.rtmr3 });
      if (!nonceBound(f.reportData, nonce, report.signing_address)) return fail("nonce is not bound into report_data", measurements);
      if (report.sidecar_bindings !== undefined) {
        bound = digestsFromBindings(report.sidecar_bindings);
        if (!bound) return fail("sidecar bindings carry no valid image, compose and model digests", measurements);
        if (!bindingsCommittedIn(f.reportData, report.sidecar_bindings)) return fail("sidecar bindings are not committed in report_data", measurements);
        bindingsCommitted = true;
      }
      const q = await verifyQuote(ctx, { kind: "tdx", quoteHex: report.intel_quote, registers: f, eventLog: report.event_log ?? null, vmConfig: typeof report.vm_config === "string" ? report.vm_config : null });
      if (!q.ok) return fail(q.reason!, measurements);
      // A compose hash recovered from evidence a verifier validated must be the one the bindings commit to.
      if (bound && q.composeHash && q.composeHash !== bound.composeHash.slice(2)) return fail("compose hash in the bindings does not match the verified event log", measurements);
      verifiedBy = q.verifiers;
      quoteHex = report.intel_quote;
      if (allowlist?.mrtd?.length && !allowlist.mrtd.includes(f.mrtd)) return fail("MRTD not in allowlist", measurements);
      if (allowlist?.rtmr3?.length && !allowlist.rtmr3.includes(f.rtmr3)) return fail("RTMR3 not in allowlist", measurements);
      const boundKey = String((report.sidecar_bindings as Record<string, unknown> | undefined)?.tls_pubkey ?? "").toLowerCase();
      if (peer) {
        const pinned = await provePinnedCertificate(ctx, p, peer, report, getReport);
        if (pinned) return fail(pinned, measurements);
      } else if (url.protocol === "https:" && boundKey) {
        // The sidecar terminates TLS itself with the key it binds; any other certificate here is someone else's.
        return fail("the endpoint did not present the TLS key its quote binds", measurements);
      }
    } else {
      const q = await verifyQuote(ctx, { kind: "snp", quoteHex: report.snp_report, registers: null });
      if (!q.ok) return fail(q.reason!);
      verifiedBy = q.verifiers;
    }
    if (p.teeKind === "nvidia-cc" || report.nvidia_payload) {
      if (!report.nvidia_payload) return fail("GPU evidence missing");
      const payload = typeof report.nvidia_payload === "string" ? report.nvidia_payload : JSON.stringify(report.nvidia_payload);
      if (!payload.includes(nonce)) return fail("GPU evidence is not bound to our nonce");
      const g = await verifyNvidia(ctx, payload);
      if (!g.ok) return fail(g.reason!);
    }
  }
  // Whether the report says the in-enclave hard-block classifier is on. Trusted only from committed bindings of a
  // verified hardware quote (or, outside production, from a development report); see router/lane.ts.
  const simulated = p.teeKind === "dev" || report.kind === "dev";
  const evidence = { hardwareVerified: verifiedBy.length > 0, bindingsCommitted, simulated, allowDev: ctx.cfg.attestation.allowDev };
  const classifierEnabled = classifierFromReport(report, evidence);
  // The hash of the policy that classifier enforces, under the same rule (reported as X-Anyroute-Policy-Hash).
  const policyHash = policyHashFromReport(report, evidence);
  const reportHash = "0x" + sha256(canonicalJson({ report, nonce }));
  await ctx.db.insert(attestations).values({ providerId: p.id, ok: true, teeKind: p.teeKind ?? report.kind ?? null, reportHash, nonce, measurements, detail: { signing_address: report.signing_address ?? null, verifiers: verifiedBy, simulated: p.teeKind === "dev" || report.kind === "dev", classifier_enabled: classifierEnabled } });
  // Transparency log (a no-op unless TLOG_ENABLED): the keys a hardware-verified quote bound, never simulated evidence.
  if (bindingsCommitted && verifiedBy.length && !simulated) keyPublished(ctx.db, "attestation_binding", attestationBindingEntry(p.id, report.sidecar_bindings, peer?.attestationRef ?? null));
  // A measurement is recorded only from a hardware quote a verifier accepted; never from simulated evidence.
  if (ctx.cfg.measurements.enabled && bound && quoteHex && verifiedBy.length) {
    try {
      await recordMeasurement(ctx, { providerId: p.id, digests: bound, verifiers: verifiedBy, teeKind: p.teeKind ?? report.kind ?? null, quoteHex, reportHash });
    } catch (e) {
      log.error("recording the measurement failed", { provider: p.id, error: (e as Error).message });
    }
  }
  // From now on the provider's connections accept only the certificate this attestation proved; an endpoint that
  // attested through public CAs has no pin.
  if (peer) await saveTlsPin(ctx.db, p.id, { certPem: peer.certPem, spkiSha256: peer.spkiSha256, attestationRef: peer.attestationRef!, pinnedAt: new Date().toISOString() });
  else await clearTlsPin(ctx.db, p.id);
  // Not (or no longer) an aci/1 gateway: its responses carry no gateway receipt to check.
  await clearAciGateway(ctx.db, p.id);
  await ctx.db.update(providers).set({ attested: true, attestationHash: reportHash, attestedAt: new Date(), updatedAt: new Date() }).where(eq(providers.id, p.id));
  await ctx.db.update(providers).set({ classifierEnabled }).where(eq(providers.id, p.id));
  await saveAttestedPolicy(ctx.db, p.id, policyHash, reportHash);
  return { provider: p.id, ok: true, hash: reportHash, ...(networkAdmission && ctx.cfg.networkHosts.enabled ? { networkEvidence: { tee_kind: report.intel_quote ? "tdx" : p.teeKind ?? "unknown", hardware_verified: verifiedBy.length > 0, bindings_committed: bindingsCommitted, simulated, dev: simulated, gpu_cc_verified: !simulated && !!report.nvidia_payload, bindings: report.sidecar_bindings ?? {} } } : {}), host_policy_bindings: sidecarHostPolicyBindings(report.sidecar_bindings, { ...evidence, teeKind: p.teeKind ?? "tdx" }), ...(peer ? { tls_pin: { spki_sha256: peer.spkiSha256, attestation_ref: peer.attestationRef } } : {}) };
}

/** Verify an aci/1 gateway report (see the header comment and providers/aci.ts) and record what it established. */
async function attestAciGateway(
  ctx: Ctx,
  p: typeof providers.$inferSelect,
  o: {
    url: URL;
    nonce: string;
    report: Record<string, any>;
    presented: PeerCertificate | null;
    allowlist: { mrtd?: string[]; rtmr3?: string[] } | null;
    fail: (reason: string, extra?: Record<string, unknown>) => Promise<{ provider: string; ok: boolean; reason: string }>;
  },
) {
  const quoteHex = typeof o.report.attestation?.evidence?.quote === "string" ? o.report.attestation.evidence.quote : "";
  let f: TdxFields;
  try {
    f = parseTdxQuote(quoteHex);
  } catch (e) {
    return o.fail(`unparseable TDX quote: ${(e as Error).message}`);
  }
  const measurements = { mrtd: f.mrtd, rtmr0: f.rtmr0, rtmr1: f.rtmr1, rtmr2: f.rtmr2, rtmr3: f.rtmr3 };
  const checked = checkAciReport(o.report, { nonce: o.nonce, nowS: Math.floor(Date.now() / 1000), host: o.url.hostname, quoteReportData: f.reportData, quoteRtmr3: f.rtmr3 });
  if (!checked.ok) return o.fail(checked.reason, measurements);
  const q = await verifyQuote(ctx, { kind: "tdx", quoteHex: checked.quoteHex, registers: f, eventLog: checked.eventLog, vmConfig: checked.vmConfig });
  if (!q.ok) return o.fail(q.reason!, measurements);
  const g = checked.gateway;
  if (q.composeHash && g.composeHash && q.composeHash !== g.composeHash) return o.fail("the compose hash the verifiers report is not the one the event log measured", measurements);
  if (o.allowlist?.mrtd?.length && !o.allowlist.mrtd.includes(f.mrtd)) return o.fail("MRTD not in allowlist", measurements);
  if (o.allowlist?.rtmr3?.length && !o.allowlist.rtmr3.includes(f.rtmr3)) return o.fail("RTMR3 not in allowlist", measurements);
  const https = o.url.protocol === "https:";
  if (https) {
    if (!o.presented) return o.fail("the endpoint's TLS certificate could not be read", measurements);
    if (!g.tlsSpki.includes(o.presented.spkiSha256)) return o.fail("the endpoint's TLS key is not one its attested keyset lists for this host", measurements);
  } else if (ctx.cfg.production) return o.fail("an attested gateway must be reached over https", measurements);

  const reportHash = "0x" + sha256(canonicalJson({ report: o.report, nonce: o.nonce }));
  await ctx.db.insert(attestations).values({
    providerId: p.id,
    ok: true,
    teeKind: p.teeKind ?? "tdx",
    reportHash,
    nonce: o.nonce,
    // The gateway's compose hash with the registers, so the attestation history shows each gateway release.
    measurements: { ...measurements, ...(g.composeHash ? { compose_hash: g.composeHash } : {}) },
    detail: {
      signing_address: null,
      verifiers: q.verifiers,
      simulated: false,
      classifier_enabled: false,
      aci: {
        keyset_digest: g.keysetDigest,
        workload_id: g.workloadId,
        receipt_keys: g.receiptKeys.map((k) => k.key_id),
        tls_spki_sha256: https ? o.presented!.spkiSha256 : null,
        compose_hash: g.composeHash,
        os_image_hash: g.osImageHash,
        app_id: g.appId,
        source_provenance: g.sourceProvenance,
        not_after: g.notAfter,
        stale_after: g.staleAfter,
        serving: g.serving,
        keyset_endorsement: g.keysetEndorsement,
      },
    },
  });
  await saveAciGateway(ctx.db, p.id, g);
  const pin = https ? { certPem: "", spkiSha256: o.presented!.spkiSha256, attestationRef: g.keysetDigest.slice("sha256:".length), pinnedAt: new Date().toISOString(), spkiOnly: true } : null;
  if (pin) await saveTlsPin(ctx.db, p.id, pin);
  else await clearTlsPin(ctx.db, p.id);
  // No in-enclave classifier is bound here, so restricted variants never route to a gateway (router/lane.ts).
  await ctx.db.update(providers).set({ attested: true, attestationHash: reportHash, attestedAt: new Date(), classifierEnabled: false, updatedAt: new Date() }).where(eq(providers.id, p.id));
  await clearAttestedPolicy(ctx.db, p.id);
  return { provider: p.id, ok: true, hash: reportHash, aci: { keyset_digest: g.keysetDigest }, ...(pin ? { tls_pin: { spki_sha256: pin.spkiSha256, attestation_ref: pin.attestationRef } } : {}) };
}

/**
 * The checks that let a self-signed certificate stand in for a CA: returns a failure reason, or null when the
 * certificate is proven. The fresh, nonce-bound report has already passed every ordinary check.
 */
async function provePinnedCertificate(ctx: Ctx, p: typeof providers.$inferSelect, peer: PeerCertificate, fresh: Record<string, any>, getReport: (u: URL) => Promise<Record<string, any>>): Promise<string | null> {
  const bindsPeerKey = (bindings: unknown) => !!bindings && typeof bindings === "object" && String((bindings as Record<string, unknown>).tls_pubkey ?? "").toLowerCase() === peer.spkiHex;
  if (fresh.sidecar_bindings === undefined) return "a self-signed endpoint must serve a sidecar attestation document";
  if (!bindsPeerKey(fresh.sidecar_bindings)) return "the certificate's key is not the TLS key the quote binds";
  // The certificate names its boot quote by hash: fetch that quote (no nonce) over the same pinned connection.
  const bootUrl = new URL(p.attestationUrl!);
  bootUrl.searchParams.delete("nonce");
  let boot: Record<string, any>;
  try {
    boot = await getReport(bootUrl);
  } catch (e) {
    return `boot attestation unreachable: ${(e as Error).message}`;
  }
  const bootQuote = typeof boot.intel_quote === "string" ? boot.intel_quote.replace(/^0x/, "").toLowerCase() : "";
  if (!bootQuote || sha256(Buffer.from(bootQuote, "hex")) !== peer.attestationRef) return "the certificate's attestation reference is not the hash of the quote the endpoint serves";
  let f: TdxFields;
  try {
    f = parseTdxQuote(bootQuote);
  } catch (e) {
    return `unparseable boot quote: ${(e as Error).message}`;
  }
  if (!bindsPeerKey(boot.sidecar_bindings) || !bindingsCommittedIn(f.reportData, boot.sidecar_bindings)) return "the quote the certificate names does not bind the certificate's key";
  // One process, one set of bindings: the boot quote and the fresh one must commit to the same values.
  if (canonicalJson(boot.sidecar_bindings) !== canonicalJson(fresh.sidecar_bindings)) return "the boot and fresh quotes bind different values";
  const q = await verifyQuote(ctx, { kind: "tdx", quoteHex: bootQuote, registers: f, eventLog: boot.event_log ?? null, vmConfig: typeof boot.vm_config === "string" ? boot.vm_config : null });
  if (!q.ok) return `the quote the certificate names did not verify: ${q.reason}`;
  const bootDigests = digestsFromBindings(boot.sidecar_bindings);
  if (q.composeHash && bootDigests && q.composeHash !== bootDigests.composeHash.slice(2)) return "compose hash in the boot bindings does not match the verified evidence";
  return null;
}

export async function runAttestor(ctx: Ctx) {
  const rows = await ctx.db.select().from(providers).where(and(or(inArray(providers.status, ["shadow", "live"]), probationRegistryFilter(ctx.cfg)), isNotNull(providers.attestationUrl), isNotNull(providers.teeKind)));
  const results = [];
  for (const p of rows) {
    try {
      const startedAt = new Date();
      const result = await renewHostAttestation(ctx, p, await attestProvider(ctx, p));
      results.push(result);
      await recordAttestorRun(ctx, p, result, startedAt); // the public proof-time record; never throws
    } catch (e) {
      log.error("attestation crashed", { provider: p.id, error: (e as Error).message });
    }
  }
  await pruneAttestationEvents(ctx).catch((e) => log.warn("pruning the attestation history failed", { error: (e as Error).message }));
  await ctx.catalog.refresh();
  return { results };
}
