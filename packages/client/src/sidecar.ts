import type { BoundIdentity } from "./attestation.js";
import { verifyReceipt, type ReceiptVerification, type VerifyReceiptOptions } from "./receipts.js";
import type { Check, ReceiptEnvelope } from "./types.js";

/**
 * A receipt signed by a provider's sidecar enclave. It verifies under the receipt key the provider's quote commits
 * to (`bound.receiptPubkey`), and must name the same attestation reference and model digest, and not be simulated.
 * Only meaningful when `bound` came from a ProviderVerification that was ok.
 */
export async function verifySidecarReceipt(receipt: ReceiptEnvelope, bound: BoundIdentity, opts: Omit<VerifyReceiptOptions, "keys" | "publicKeyHex"> = {}): Promise<ReceiptVerification> {
  const base = await verifyReceipt(receipt, { ...opts, publicKeyHex: bound.receiptPubkey });
  const p = receipt?.payload ?? {};
  const extra: Check[] = [
    p.type === "anyroute.sidecar.receipt" ? { id: "sidecar.type", status: "pass", detail: "a sidecar receipt" } : { id: "sidecar.type", status: "fail", detail: "The payload is not a sidecar receipt." },
    p.dev === false ? { id: "sidecar.not_dev", status: "pass", detail: "not marked as simulated" } : { id: "sidecar.not_dev", status: "fail", detail: "The receipt is marked as simulated, or does not say." },
    p.attestation_ref === bound.attestationRef ? { id: "sidecar.attestation_ref", status: "pass", detail: "names the attestation this client verified" } : { id: "sidecar.attestation_ref", status: "fail", detail: "The receipt names a different attestation than the one verified." },
    typeof p.model_digest === "string" && p.model_digest.toLowerCase() === bound.modelDigest ? { id: "sidecar.model_digest", status: "pass", detail: "names the model digest the quote commits to" } : { id: "sidecar.model_digest", status: "fail", detail: "The receipt names a different model digest than the quote commits to." },
  ];
  const checks = [...base.checks, ...extra];
  return { ...base, checks, valid: base.valid && extra.every((c) => c.status === "pass") };
}
