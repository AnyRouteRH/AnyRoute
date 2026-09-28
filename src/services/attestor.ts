import { and, eq, isNotNull, inArray } from "drizzle-orm";
import { boundedJson, providerFetch } from "../providers/network.ts";
import { randomBytes } from "node:crypto";
import type { Ctx } from "../context.ts";
import { attestations, kv, providers } from "../db/schema.ts";
import { canonicalJson, log, sha256 } from "../lib/util.ts";

// attestor: every 10 minutes, for each provider with a TEE, fetch a fresh attestation bound to our
// nonce and verify it. Fail closed: anything unverifiable leaves the provider un-attested, and the
// private route (`provider.private` / `:private`) only ever selects freshly attested providers.
//
// Report format (NEAR-AI-style, GET <attestation_url>?nonce=<hex32>):
//   { intel_quote?: hex (TDX v4 quote), snp_report?: hex, nvidia_payload?: string, signing_address?: hex,
//     nonce: hex32 } — "dev" providers return { kind: "dev", nonce, measurement } (non-production only).
// Verification:
//   - the nonce must be bound into the TEE report_data (TDX: bytes 568..632 of the quote)
//   - the quote's certificate chain is checked by a DCAP verification service (TDX_VERIFIER_URL)
//   - GPU evidence is checked by NVIDIA NRAS (overall attestation result must be true)
//   - measurements (MRTD / RTMR3) must be in the provider's allowlist when one is configured

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

async function verifyQuote(ctx: Ctx, quoteHex: string) {
  if (!ctx.cfg.attestation.tdxVerifierUrl) return { ok: false, reason: "no DCAP verifier configured (TDX_VERIFIER_URL)" };
  const res = await providerFetch(ctx.cfg.attestation.tdxVerifierUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...(ctx.cfg.attestation.tdxVerifierKey ? { authorization: `Bearer ${ctx.cfg.attestation.tdxVerifierKey}` } : {}) },
    body: JSON.stringify({ quote: quoteHex.replace(/^0x/, "") }),
    signal: AbortSignal.timeout(20_000),
  }, { production: ctx.cfg.production });
  if (!res.ok) return { ok: false, reason: `verifier HTTP ${res.status}` };
  const j = (await res.json()) as { verified?: boolean; status?: string; tcb_status?: string };
  const status = j.tcb_status ?? j.status;
  const ok = j.verified === true || status === "UpToDate" || status === "SWHardeningNeeded";
  return { ok, reason: ok ? undefined : `quote not verified (${status ?? "unknown"})`, status };
}

async function verifyNvidia(ctx: Ctx, payload: string) {
  const res = await providerFetch(ctx.cfg.attestation.nrasUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: payload, signal: AbortSignal.timeout(30_000) }, { production: ctx.cfg.production });
  if (!res.ok) return { ok: false, reason: `NRAS HTTP ${res.status}` };
  const j = (await res.json()) as unknown;
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

export async function attestProvider(ctx: Ctx, p: typeof providers.$inferSelect) {
  if (!["shadow", "live"].includes(p.status)) throw new Error("Provider requires operator approval before attestation.");
  const nonce = randomBytes(32).toString("hex");
  const url = new URL(p.attestationUrl!);
  url.searchParams.set("nonce", nonce);
  let report: Record<string, any>;
  const fail = async (reason: string, extra: Record<string, unknown> = {}) => {
    await ctx.db.insert(attestations).values({ providerId: p.id, ok: false, teeKind: p.teeKind, nonce, detail: { reason, ...extra } });
    await ctx.db.update(providers).set({ attested: false, updatedAt: new Date() }).where(eq(providers.id, p.id));
    return { provider: p.id, ok: false, reason };
  };
  try {
    const res = await providerFetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) }, { production: ctx.cfg.production, allowDevelopmentMockLoopback: !ctx.cfg.production });
    if (!res.ok) return fail(`attestation endpoint HTTP ${res.status}`);
    report = (await boundedJson(res)) as Record<string, any>;
  } catch (e) {
    return fail(`attestation endpoint unreachable: ${(e as Error).message}`);
  }
  const [allow] = await ctx.db.select().from(kv).where(eq(kv.key, `attest-allow:${p.id}`));
  const allowlist = (allow?.value ?? null) as { mrtd?: string[]; rtmr3?: string[]; measurement?: string[] } | null;
  const measurements: Record<string, string> = {};

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
      const q = await verifyQuote(ctx, report.intel_quote);
      if (!q.ok) return fail(q.reason!, measurements);
      if (allowlist?.mrtd?.length && !allowlist.mrtd.includes(f.mrtd)) return fail("MRTD not in allowlist", measurements);
      if (allowlist?.rtmr3?.length && !allowlist.rtmr3.includes(f.rtmr3)) return fail("RTMR3 not in allowlist", measurements);
    } else {
      const q = await verifyQuote(ctx, report.snp_report);
      if (!q.ok) return fail(q.reason!);
    }
    if (p.teeKind === "nvidia-cc" || report.nvidia_payload) {
      if (!report.nvidia_payload) return fail("GPU evidence missing");
      const payload = typeof report.nvidia_payload === "string" ? report.nvidia_payload : JSON.stringify(report.nvidia_payload);
      if (!payload.includes(nonce)) return fail("GPU evidence is not bound to our nonce");
      const g = await verifyNvidia(ctx, payload);
      if (!g.ok) return fail(g.reason!);
    }
  }
  const reportHash = "0x" + sha256(canonicalJson({ report, nonce }));
  await ctx.db.insert(attestations).values({ providerId: p.id, ok: true, teeKind: p.teeKind ?? report.kind ?? null, reportHash, nonce, measurements, detail: { signing_address: report.signing_address ?? null } });
  await ctx.db.update(providers).set({ attested: true, attestationHash: reportHash, attestedAt: new Date(), updatedAt: new Date() }).where(eq(providers.id, p.id));
  return { provider: p.id, ok: true, hash: reportHash };
}

export async function runAttestor(ctx: Ctx) {
  const rows = await ctx.db.select().from(providers).where(and(inArray(providers.status, ["shadow", "live"]), isNotNull(providers.attestationUrl), isNotNull(providers.teeKind)));
  const results = [];
  for (const p of rows) {
    try {
      results.push(await attestProvider(ctx, p));
    } catch (e) {
      log.error("attestation crashed", { provider: p.id, error: (e as Error).message });
    }
  }
  await ctx.catalog.refresh();
  return { results };
}
