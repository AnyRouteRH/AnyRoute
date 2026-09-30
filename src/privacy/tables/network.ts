import type { TableDoc } from "../types.ts";
import { CREATED, KEPT_APPEND } from "./common.ts";

export const networkTables: Record<string, TableDoc> = {
  network_waitlist: {
    category: "operations",
    purpose: "Network interest sign-ups, not host admission or attestation. Stores exactly the submitted role, hardware, readiness, continent, optional contact and payout preference, plus an id, deletion digest and time. Free text is private to the owner export; public statistics contain only counts.",
    request: "no",
    retention: "Until the participant deletes it with their code, or the owner deletes the list when the program launches or is cancelled. Program-wide removal is an owner operation; no automatic launch or cancellation signal exists.",
    notes: ["Hardware, readiness and contact are user-supplied text. Do not paste prompts or other sensitive information. The owner can read these fields through the ADMIN_TOKEN-protected read-only export. No network address or user agent is stored in this table. The delete code itself is returned once and never stored."],
    columns: {
      id: "Random UUID identifying this sign-up, not an account or machine identity.",
      role: "Selected role: host_gpu, host_cpu, relay, witness or developer.",
      hardware: "Hardware description typed by the participant, at most 200 characters; unverified free text, not a prompt sent to a model.",
      readiness: "Optional pasted readiness hints, at most 300 characters; unverified free text, not attestation or a prompt sent to a model.",
      region: "Selected continent only; not inferred from a network address.",
      contact: { purpose: "Optional contact typed by the participant, at most 120 characters; may identify them. Null when omitted or blank.", review: { covers: ["name:network"], verdict: "config", why: "Voluntarily supplied contact for the owner to respond to interest, not a connection address read from the request. May contain an email, handle or any contact the participant chooses; kept privately until deletion." } },
      paid_in: "Payout preference only: usdg, anyr or any. Payouts are planned, not available.",
      delete_code_hash: "SHA-256 of a random 32-byte deletion code. The raw code is returned once to its holder.",
      created_at: "Server timestamp when the sign-up was saved.",
    },
  },
  host_policies: {
    category: "operations",
    purpose: "Public versions of the network host admission policy, signed with the transparency log's Ed25519 key. Publication alone does not admit providers; wallet-authenticated network admission verifies this policy before probation.",
    request: "no",
    retention: KEPT_APPEND,
    columns: {
      version: "Consecutive policy version, beginning at 1.",
      issued_at: "The policy's issue time supplied by the operator.",
      canonical: "Canonical JSON of the operator's policy: version, issue time, TEE kinds, approved sidecar image and source hashes, engine names and image digests, model IDs and digests, GPU CC requirements and optional model offer terms: catalogue slug, display name, Hugging Face ID, context and completion limits, quantization and positive USD-per-token prompt/completion prices. Offer terms are public operator-provided metadata, not inference content. A strict bounded schema accepts no prompt fields; names are operator-written identifiers with a restricted alphabet, so the router cannot know what meaning the operator assigns them. Public through the policy API.",
      sha256: "SHA-256 of the exact canonical policy bytes.",
      signature: "Base64 Ed25519 signature over the canonical policy bytes.",
      verifier_key: "The public signed-note verifier key identifying the log key that signed this version.",
      created_at: CREATED,
    },
  },
};
