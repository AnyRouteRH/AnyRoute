import { and, eq, isNotNull } from "drizzle-orm";
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
  const res = await fetch(ctx.cfg.attestation.tdxVerifierUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...(ctx.cfg.attestation.tdxVerifierKey ? { authorization: `Bearer ${ctx.cfg.attestation.tdxVerifierKey}` } : {}) },
    body: JSON.stringify({ quote: quoteHex.replace(/^0x/, "") }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return { ok: false, reason: `verifier HTTP ${res.status}` };
  const j = (await res.json()) as { verified?: boolean; status?: string; tcb_status?: string };
  const status = j.tcb_status ?? j.status;
  const ok = j.verified === true || status === "UpToDate" || status === "SWHardeningNeeded";
  return { ok, reason: ok ? undefined : `quote not verified (${status ?? "unknown"})`, status };
}
