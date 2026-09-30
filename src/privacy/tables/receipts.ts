import type { TableDoc } from "../types.ts";
import { CREATED, JSON_FIELDS, KEPT, KEPT_APPEND, rv } from "./common.ts";

// Receipts and proofs: keys the router signs with, the roots receipts are anchored under and the append-only log of keys and
// configurations. Everything here is public by design or a hash; none of it carries request or answer text.

export const receiptTables: Record<string, TableDoc> = {
  receipt_keys: {
    category: "receipts",
    purpose: "The Ed25519 keys that sign receipts, with the dates each was valid. Public halves are published; the private half is encrypted at rest.",
    request: "no",
    retention: "Keys are rotated (RECEIPT_KEY_ROTATION_DAYS) and retired, never deleted, so old receipts stay verifiable.",
    columns: {
      id: "Key id: 16 hex characters, the first bytes of the public key's digest.",
      public_key: "The raw 32-byte public key, hex. Published at /api/v1/receipts/keys.",
      private_key_enc: "The private key, AES-256-GCM encrypted with the router's APP_SECRET. Null for a key that can no longer sign; the router then makes a new one.",
      valid_from: "When the key started signing.",
      retired_at: "When it stopped signing, once rotated out.",
      onchain_tx: "The transaction that published the public key on chain.",
      created_at: CREATED,
    },
  },

  anchors: {
    category: "receipts",
    purpose: "A Merkle root over the receipts signed in one interval, and the chain transaction that recorded it. Lets anyone check that a receipt existed at that time.",
    request: "aggregate",
    retention: KEPT_APPEND,
    columns: {
      index: "Anchor number, counting up from zero.",
      root: "The Merkle root of the interval's receipt leaves (32 bytes, hex).",
      from_ts: "Start of the interval covered.",
      to_ts: "End of the interval covered.",
      count: "How many receipts the root covers.",
      tx_hash: "The chain transaction that recorded the root.",
      status: "pending, submitted, confirmed or local.",
      created_at: CREATED,
    },
  },

  host_anchors: {
    category: "receipts",
    purpose: "A Merkle root over the receipts one attested host signed in an interval, tied to the attestation its receipt key was bound in.",
    request: "aggregate",
    retention: KEPT,
    columns: {
      id: "Row number, counting up from 1.",
      provider_id: "The attested host.",
      attestation_ref: "SHA-256 of the boot quote the router verified for that host.",
      receipt_key_id: "The host's receipt key id.",
      receipt_public_key: "The host's raw Ed25519 receipt public key, hex, as its verified quote bound it.",
      root: "The Merkle root of the collected leaves.",
      from_ts: "Start of the interval the leaves were collected in.",
      to_ts: "End of that interval.",
      count: "How many leaves the root covers.",
      status: "pending, confirmed or local.",
      tx_hash: "The chain transaction that recorded the root.",
      block_number: "The block of that transaction.",
      chain_index: "The anchor's index in the on-chain receipt anchor contract once posted.",
      created_at: CREATED,
    },
  },

  host_anchor_leaves: {
    category: "receipts",
    purpose: "The receipt leaves collected from attested hosts. A row holds a leaf hash, the receipt id and the time; not the receipt's own hashes or usage.",
    request: "yes",
    retention: KEPT_APPEND,
    columns: {
      provider_id: "The attested host that produced the receipt.",
      leaf: "The receipt's leaf hash.",
      anchor_id: "The host_anchors row that includes it.",
      leaf_index: "Its position in that root's tree.",
      receipt_id: "The receipt's id.",
      receipt_ts: "The time the receipt itself states.",
      collected_at: "When the router collected the leaf.",
    },
  },

  tlog_entries: {
    category: "receipts",
    purpose: "The entries of the public transparency log: receipt keys, Oblivious HTTP key configurations, blind-token issuer keys, measurement bundles, attestation bindings and data inventories (this page's own hash).",
    request: "no",
    retention: "Append-only by design: entries are never updated or deleted, because the log's tree hashes them.",
    columns: {
      idx: "The entry's leaf index in the log.",
      kind: "receipt_key, ohttp_key_config, blind_issuer_key, measurement_bundle, attestation_binding or data_inventory.",
      sha256: "Hex digest of the key or configuration the entry names.",
      subject: "The key id, epoch, provider or inventory the entry is about.",
      entry: "The exact canonical JSON that was hashed into the log: public key material or a digest, never request data.",
      leaf_hash: "The entry's RFC 6962 leaf hash.",
      created_at: CREATED,
    },
  },

  tlog_checkpoints: {
    category: "receipts",
    purpose: "Signed checkpoints of the transparency log: its size and root, signed by the log's key.",
    request: "no",
    retention: KEPT_APPEND,
    columns: {
      size: "The tree size the checkpoint is for.",
      root_hash: "The tree's root hash, hex.",
      checkpoint: "The checkpoint text: origin, size and base64 root hash.",
      signature: "The log's signature line over that text.",
      created_at: CREATED,
    },
  },

  tlog_cosignatures: {
    category: "receipts",
    purpose: "Witness cosignatures on checkpoints: independent parties confirming the log showed them the same tree.",
    request: "no",
    retention: KEPT,
    columns: {
      size: "The checkpoint size the witness signed.",
      witness: "The witness's key name.",
      key_id: "Hex of the 4-byte signed-note key id.",
      timestamp: "The cosignature's own time, in seconds.",
      line: "The signature line as the witness sent it.",
      created_at: CREATED,
      updated_at: "When a newer cosignature from the same witness replaced the row.",
    },
  },

  tlog_rekor_anchors: {
    category: "receipts",
    purpose: "Records of checkpoints the router anchored in a public Rekor log, with the proof that the entry is included.",
    request: "no",
    retention: "A pending row that turns out not to be an entry for its checkpoint is dropped and the checkpoint is submitted again; verified rows are kept.",
    columns: {
      id: "Row number, counting up from 1.",
      size: "The checkpoint's tree size.",
      root_hash: "The checkpoint's root hash, hex.",
      note: {
        purpose: "The signed checkpoint note that was anchored: checkpoint text, a blank line and the log's signature line.",
        review: rv(["name:content"], "no-request-content", "The note is the transparency-log checkpoint text (origin, size, root hash) plus a signature line; nothing else is ever placed in it."),
      },
      artifact_sha256: "The SHA-256 the Rekor entry holds.",
      key_id: "SHA-256 of the anchoring key's public key info, hex.",
      rekor_url: {
        purpose: "The address of the Rekor log the entry was submitted to.",
        review: rv(["name:network"], "public-reference", "The address of a public transparency log server, set by the operator; it is not a caller's address."),
      },
      uuid: "The Rekor entry id.",
      status: "pending or verified. Only verified rows are served.",
      log_index: "The entry's index in Rekor.",
      integrated_time: "When Rekor integrated the entry, in seconds.",
      log_id: "Rekor's log id.",
      entry_base64: "The entry body as Rekor returned it, base64.",
      inclusion_proof: { purpose: "The inclusion proof: log index, tree size, root hash, hashes and Rekor's checkpoint.", review: JSON_FIELDS("Copied from Rekor's inclusion-proof response and typed as { logIndex, treeSize, rootHash, hashes, checkpoint }.") },
      signed_entry_timestamp: "Rekor's signed entry timestamp, base64.",
      checkpoint_verified: "Whether Rekor's checkpoint signature verified against the pinned key.",
      set_verified: "Whether the signed entry timestamp verified against the pinned key.",
      created_at: CREATED,
      verified_at: "When the inclusion proof verified.",
    },
  },
};
