import { bytesToHex, sha256Hex } from "../util.ts";
import type { AttestationProvider, PlatformInfo, QuoteEvidence } from "./types.ts";

/**
 * Simulated evidence for local development. It proves nothing: there is no hardware behind it, and anyone can
 * produce the same bytes. It exists so the rest of the pipeline (keys, certificate, receipts) can be exercised
 * without a confidential VM, and every response and receipt produced under it is marked `dev`.
 */
export class DevAttestationProvider implements AttestationProvider {
  readonly kind = "dev" as const;
  async platformInfo(): Promise<PlatformInfo> {
    return {};
  }
  async quote(reportData: Uint8Array): Promise<QuoteEvidence> {
    const rd = bytesToHex(reportData);
    const body = Buffer.from(`dev-simulated:${rd}`);
    return {
      kind: "dev",
      dev: true,
      format: "dev-simulated",
      quote: body.toString("hex"),
      reportData: rd,
      eventLog: null,
      measurements: { measurement: rd.slice(0, 64), simulated: "true", quote_sha256: sha256Hex(body) },
      generatedAt: new Date().toISOString(),
    };
  }
}
