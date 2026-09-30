import { canonicalJson, sha256 } from "../lib/util.ts";

// What the log records. Every entry is the canonical JSON (keys sorted, no whitespace) of
//
//   { "v": 1, "type": "anyroute.tlog.entry", "kind": <kind>, "sha256": <hex>, "key": { ...public material } }
//
// `sha256` is the digest a client computes from the key or configuration it was handed, so a client that holds only
// that key can look it up and check the entry names it:
//
//   receipt_key          SHA-256 of the raw 32-byte Ed25519 public key (the receipt key id is its first 16 hex)
//   ohttp_key_config     SHA-256 of the encoded RFC 9458 key configuration
//   blind_issuer_key     SHA-256 of the RFC 9578 SubjectPublicKeyInfo (the token_key_id)
//   measurement_bundle   SHA-256 of the canonical bundle bytes (the digest logged in Rekor)
//   attestation_binding  SHA-256 of the canonical JSON of a sidecar's bindings (the first half of its report_data)
//   data_inventory       SHA-256 of the canonical JSON of the data inventory published at /keep/inventory.json
//
// Entries carry no log time: the log's order is its only clock.

export const ENTRY_KINDS = ["receipt_key", "ohttp_key_config", "blind_issuer_key", "measurement_bundle", "attestation_binding", "data_inventory"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export const isEntryKind = (v: unknown): v is EntryKind => typeof v === "string" && (ENTRY_KINDS as readonly string[]).includes(v);

export type EntryInput = { kind: EntryKind; sha256: string; subject: string; key: Record<string, unknown> };

export const ENTRY_TYPE = "anyroute.tlog.entry";

export function entryText(e: EntryInput): string {
  return canonicalJson({ v: 1, type: ENTRY_TYPE, kind: e.kind, sha256: e.sha256, key: e.key });
}

const iso = (d: Date) => d.toISOString();
const hex = (s: string) => s.replace(/^0x/i, "").toLowerCase();

export function receiptKeyEntry(k: { id: string; publicKey: string; validFrom: Date }): EntryInput {
  return { kind: "receipt_key", sha256: sha256(Buffer.from(k.publicKey, "hex")), subject: k.id, key: { key_id: k.id, alg: "EdDSA", public_key: k.publicKey.toLowerCase(), valid_from: iso(k.validFrom) } };
}

export function ohttpKeyEntry(k: { epoch: number; keyId: number; kemId: number; config: string; configSha256: string; validFrom: Date; acceptUntil: Date }): EntryInput {
  return {
    kind: "ohttp_key_config",
    sha256: hex(k.configSha256),
    subject: `epoch:${k.epoch}`,
    key: { epoch: k.epoch, key_id: k.keyId, kem_id: k.kemId, config: k.config, valid_from: iso(k.validFrom), accept_until: iso(k.acceptUntil) },
  };
}

export function blindKeyEntry(k: { keyId: string; spki: string; epoch: number; denomination: number; validFrom: Date; issueUntil: Date; redeemUntil: Date }): EntryInput {
  return {
    kind: "blind_issuer_key",
    sha256: hex(k.keyId),
    subject: k.keyId,
    key: { token_key_id: k.keyId, token_key: k.spki, epoch: k.epoch, denomination: k.denomination, valid_from: iso(k.validFrom), issue_until: iso(k.issueUntil), redeem_until: iso(k.redeemUntil) },
  };
}

export function measurementBundleEntry(b: { providerId: string; composeHash: string; bundleDigest: string; signerKeyId: string; rekorUuid: string | null; rekorLogIndex: number | null }): EntryInput {
  return {
    kind: "measurement_bundle",
    sha256: hex(b.bundleDigest),
    subject: `${b.providerId}:${hex(b.bundleDigest)}`,
    key: { provider_id: b.providerId, compose_hash: b.composeHash, bundle_digest: b.bundleDigest, signer_key_id: b.signerKeyId, rekor_uuid: b.rekorUuid, rekor_log_index: b.rekorLogIndex },
  };
}

/** A sidecar's bindings (tls_pubkey, receipt_pubkey, hpke_pubkey, digests) as its verified quote committed to them. */
export function attestationBindingEntry(providerId: string, bindings: Record<string, unknown>, attestationRef: string | null): EntryInput {
  return {
    kind: "attestation_binding",
    sha256: sha256(canonicalJson(bindings)),
    subject: providerId,
    key: { provider_id: providerId, attestation_ref: attestationRef, bindings },
  };
}

/**
 * The data inventory a build publishes at /keep/inventory.json (src/privacy): what tables, columns, Redis keys and log lines the
 * router has. `sha256` is the SHA-256 of that file's exact bytes, so anyone can fetch the file, hash it and look the hash up here.
 * The entry is appended once per distinct inventory, the first time a router that has it starts.
 */
export function dataInventoryEntry(i: { sha256: string; format: string; tables: number; columns: number }): EntryInput {
  const digest = hex(i.sha256);
  return {
    kind: "data_inventory",
    sha256: digest,
    subject: `inventory:${digest.slice(0, 16)}`,
    key: { format: i.format, inventory_sha256: digest, tables: i.tables, columns: i.columns, path: "/keep/inventory.json" },
  };
}
