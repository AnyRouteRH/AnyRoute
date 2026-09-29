import { SidecarError } from "../util.ts";
import { DevAttestationProvider } from "./dev.ts";
import { DstackAttestationProvider } from "./dstack.ts";
import { TdxConfigfsProvider } from "./tdx.ts";
import type { AttestationKind, AttestationProvider } from "./types.ts";

export type { AttestationKind, AttestationProvider, PlatformInfo, QuoteEvidence } from "./types.ts";

export type ProviderSettings = {
  provider: AttestationKind;
  dstackEndpoint?: string;
  tdxTsmPath?: string;
};

/**
 * Build the configured provider. The simulated provider is refused unless SIDECAR_DEV_ATTESTATION=true, so a
 * production deployment cannot end up on simulated evidence by a configuration slip.
 */
export function createAttestationProvider(s: ProviderSettings, env: Record<string, string | undefined>): AttestationProvider {
  switch (s.provider) {
    case "dev":
      if (env.SIDECAR_DEV_ATTESTATION !== "true") {
        throw new SidecarError("DEV_ATTESTATION_DISABLED", "the dev attestation provider is refused unless SIDECAR_DEV_ATTESTATION=true; it produces simulated evidence and must never be used in production");
      }
      return new DevAttestationProvider();
    case "dstack":
      return new DstackAttestationProvider({ endpoint: s.dstackEndpoint });
    case "tdx":
      return new TdxConfigfsProvider(s.tdxTsmPath);
    default:
      throw new SidecarError("BAD_CONFIG", `unknown attestation provider "${String(s.provider)}"`);
  }
}
