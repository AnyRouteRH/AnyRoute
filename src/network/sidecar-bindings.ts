import { sidecarBindingsV2 } from "./sidecar-binding-version.ts";
import type { HostPolicyBindings } from "./policy.ts";

/** Call only with the outcome of the attestor's fresh quote verification, never host-provided flags. */
export function sidecarHostPolicyBindings(bindings: Record<string, unknown> | undefined, evidence: {
  teeKind: string; hardwareVerified: boolean; bindingsCommitted: boolean; simulated: boolean;
}): HostPolicyBindings {
  const trusted = evidence.hardwareVerified && evidence.bindingsCommitted && !evidence.simulated;
  const b = trusted ? bindings ?? {} : {};
  const v2 = sidecarBindingsV2(b);
  return {
    tee_kind: evidence.teeKind, hardware_verified: evidence.hardwareVerified,
    bindings_committed: evidence.bindingsCommitted, simulated: evidence.simulated,
    // /attest binds no GPU CC evidence. NRAS's overall result alone does not establish CC mode.
    gpu_cc_verified: false,
    bindings: {
      image_digest: typeof b.image_digest === "string" ? b.image_digest : undefined,
      compose_hash: typeof b.compose_hash === "string" ? b.compose_hash : undefined,
      model_digest: typeof b.model_digest === "string" ? b.model_digest : undefined,
      ...(v2 ? { source_hash: v2.source_hash, model_id: v2.model.id, engines: [{ ...v2.engine }] } : {}),
    },
  };
}
