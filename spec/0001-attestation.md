# SEAL 0001: Attestation

| | |
| :--- | :--- |
| Status | Draft |
| Version | 0.1.0 |
| Updated | 2026-09-29 |
| License | Apache-2.0 |
| Related | [0002](0002-transport.md), [0004](0004-receipts.md), [0005](0005-policy.md) |

## Status of this document

This is a working draft of the SEAL protocol. It is not an IETF document. Sections marked **(implemented)** describe formats that exist in this repository and are frozen under their version string. Sections marked **(planned)** describe the target design and may change before 1.0.0.

## Abstract

A SEAL enclave is a confidential VM, and optionally a confidential GPU, running the Anyroute sidecar in front of an OpenAI-compatible model server. At boot the enclave measures what it will serve, generates its keys in memory, and obtains a hardware quote whose report data commits to those keys and measurements. This document defines what the enclave commits to, how the commitment is encoded in the quote, how measurements are published, and how a client decides that an endpoint is the enclave it claims to be.

## 1. Conventions and terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

* **Enclave (E)**: the confidential VM (Intel TDX) running the sidecar and the model server, with its confidential GPU when present.
* **Quote**: a hardware-signed attestation report. For TDX, a version 4 quote containing MRTD, RTMR0 to RTMR3 and a 64-byte `report_data` field.
* **Bindings**: the JSON object whose digest the enclave places in `report_data`.
* **Attestation reference**: the lowercase hex SHA-256 of the boot quote's bytes.
* **Model digest**: the digest of the weight files the model server loads (Section 4.1).
* **Manifest**: the published list of measurements a verifier accepts for a given build.
* **Verifier**: any party that checks evidence: the client SDK, the router's attestor, or a third party.
* **Canonical JSON**: JSON with object keys sorted by UTF-16 code units, no insignificant whitespace, and ECMAScript number and string serialization. For JSON values this is the JSON Canonicalization Scheme [RFC8785] (JCS).
* `||` is byte concatenation. `SHA-256` and `SHA-512` are from [FIPS180-4].

## 2. Overview

```
boot:   measure weights -> check allow-lists -> generate keys in memory -> quote(report_data = commit(bindings, nonce))
serve:  GET /attest[?nonce=]  ->  { evidence, bindings, attestation_ref, ... }
client: verify quote -> recompute report_data -> compare digests -> pin TLS key -> encrypt to bound HPKE key -> verify receipts
```

The enclave never writes a private key to disk. A verifier trusts a key only because a quote it verified commits to it.

## 3. Evidence document (implemented)

The sidecar serves its evidence at `GET /attest` without authentication. With `?nonce=<64 hex>` it returns a fresh quote whose report data ends in that nonce; the endpoint MUST be rate limited. The document is:

```json
{
  "v": 1,
  "type": "anyroute.sidecar.attestation",
  "dev": false,
  "attestation_ref": "<64 hex>",
  "attestation_san": "<32 hex>.<32 hex>.attest.anyroute",
  "evidence": { "kind": "dstack | tdx | dev", "format": "...", "quote": "<hex>", "report_data": "<128 hex>",
                "event_log": [], "measurements": {}, "nonce": "<64 hex> | null", "boot": true },
  "bindings": { "tls_pubkey": "...", "receipt_pubkey": "...", "image_digest": "sha256:...",
                "compose_hash": "sha256:...", "model_digest": "sha256:..." },
  "report_data": { "derivation": "...", "bindings_digest": "<64 hex>" }
}
```

A discovery document at `GET /.well-known/anyroute-sidecar.json` lists the endpoints, the receipt key and format, the digests and the `dev` flag.

### 3.1 Bindings, version 1 (implemented)

| Member | Value |
| :--- | :--- |
| `tls_pubkey` | Hex DER SubjectPublicKeyInfo of the enclave's P-256 TLS key |
| `receipt_pubkey` | Hex raw 32-byte Ed25519 receipt-signing key |
| `image_digest` | `sha256:<hex>` of the sidecar image, declared by the operator |
| `compose_hash` | `sha256:<hex>` of the deployment's compose file |
| `model_digest` | `sha256:<hex>` model digest (Section 4.1) |
| `classifier_enabled`, `classifier_digest`, `classifier_policy` | Present only when the in-enclave classifier runs ([0005](0005-policy.md)) |
| `hpke_pubkey` | Hex raw 32-byte X25519 key, present only when encrypted transport is on ([0002](0002-transport.md)) |

```
report_data = SHA-256(canonical_json(bindings)) || nonce          (32 + 32 bytes)
```

`nonce` is 32 bytes: all zero for the boot quote, the verifier's value for a fresh quote. Optional members are absent, not null, when their feature is off, so enabling nothing leaves `report_data` unchanged.

### 3.2 Attestation reference and certificate

The enclave issues a self-signed certificate for its TLS key with a DNS SAN `<first 32 hex>.<last 32 hex>.attest.anyroute`, where the 64 hex characters are the attestation reference. A verifier MUST NOT validate this certificate against public CAs. It MUST instead check that the certificate's public key equals `bindings.tls_pubkey`, that SHA-256 of the served quote equals the reference in the SAN, and then pin the certificate for the rest of the session.

### 3.3 Simulated evidence

A development sidecar can fabricate evidence. Such evidence carries `dev: true`, `format: "dev-simulated"`, the response header `x-anyroute-attestation: dev-simulated` and a certificate name `dev-simulated.attest.anyroute`. A verifier MUST reject any of these outside development.

### 3.4 Bindings, version 2 (planned)

Version 2 binds keys by SubjectPublicKeyInfo and adds the GPU evidence:

```
report_data = SHA-512("anyroute-seal-v1" || nonce || SPKI(tls) || SPKI(hpke) || SPKI(receipt) || SHA-256(gpu_evidence))
```

All 64 bytes of the output fill `report_data`. The served document moves to `GET /.well-known/anyroute-attestation?nonce=<hex>` and adds `rtmr3_events`, the boot-time and optional live GPU evidence bundles, `keys` (`tls_spki`, `hpke_keyconfig`, `receipt_kid`), `manifest_ref` (log entry and registry transaction), `policy_hash`, `exec_profile_id` and the KMS signature chain. `POST /v1/attest/gpu` returns fresh GPU evidence for a client nonce. Enclave keys are valid for at most 24 hours and are regenerated on rotation.

## 4. Boot measurement

### 4.1 Model digest (implemented)

```
model_digest = "sha256:" || hex(SHA-256("anyroute-model-digest-v1\n" || JSON([[path, hex(SHA-256(file))], ...])))
```

The list covers every regular file under the model directory (symlinks followed to files; `.git`, `.cache`, `.DS_Store` and configured exclusions skipped), with paths relative to the root using `/`, sorted by bytes, serialized as compact JSON. The digest is independent of timestamps and walk order. The enclave MUST refuse to start when the digest is not on its allow-list, and MUST NOT start with an empty allow-list.

### 4.2 Boot order (implemented)

1. Refuse simulated evidence unless explicitly enabled for development.
2. Require a non-empty model allow-list (and classifier allow-list when the classifier is on).
3. Hash the weights (and classifier weights) and check the allow-lists.
4. Collect the compose hash from the platform and configuration; all sources MUST agree.
5. Optionally confirm the router's record names the served model digest.
6. Generate the Ed25519 receipt key, the P-256 TLS key and, when enabled, the X25519 HPKE key, in memory.
7. Obtain the boot quote (Section 3.1) and issue the certificate (Section 3.2).

Any failure MUST stop the process before it listens.

### 4.3 Runtime measurement events (planned)

On TDX the enclave extends RTMR3 with named events, in this order:

```
system-preparing, app-id, compose-hash, init-script-hash, gpu-policy-hash,
policy-hash        = SHA-256(JCS(policy.json))
exec-profile-hash  = SHA-256(JCS(exec_profile.json))
instance-id, boot-mr-done, os-image-hash, gpu-attestation, key-provider, system-ready
```

Before `system-ready` the init script MUST verify the launch token, attest the GPU with a fresh nonce and gate on `measres == "success"`, `secboot == true`, `dbgstat == "disabled"`, `cc_mode == "on"` and `devtools == false`, then extend `gpu-attestation` with the SHA-256 of the evidence. It MUST verify the weights against `exec_profile.model.weights` before loading them.

## 5. Measurements and manifests

### 5.1 Measurement registry (implemented)

`MeasurementRegistry` records, per provider, the image, compose and model digests an attested endpoint runs, the identifier of the transparency-log entry that published them, and the keccak-256 of the quote proof. A single attestor registers entries after verifying the quote off chain; the attestor or the owner can revoke. `isAttested(providerId, imageDigest, modelDigest)` answers whether a combination is registered and not revoked. The registry does not verify quotes: trusting it means trusting the attestor, which anyone can audit by re-checking the quote proof against the stored hash.

### 5.2 Measurement bundles (implemented)

An operator publishes a signed bundle (canonical JSON, ECDSA P-256) describing a deployment's pinned images, source commit, weights and the quote-measured values, as a `hashedrekord` entry in a public Sigstore Rekor log. The router verifies the entry's inclusion proof and, when configured with the log key, its checkpoint.

### 5.3 Manifests (planned)

A manifest is an in-toto Statement v1 in a DSSE envelope, logged both in Rekor and in the Anyroute log (Section 6.2). Its predicate lists `os_image_hash`, `mrtd`, `rtmr0` to `rtmr2`, `compose_hash`, the expected RTMR3 events, the GPU policy (confidential mode on, devtools off, allowed driver and VBIOS versions), the allowed policy hashes and execution profiles, the KMS root key and an `attestation_policy_version`. A `PolicyRegistry` contract versions the accepted TCB statuses, advisory grace windows, GPU reference-measurement allow-lists and minimum drivers; clients pin a minimum version.

## 6. Transparency of keys and configurations

### 6.1 Today (implemented)

* The router's Oblivious HTTP key history is published as a document signed with the router's receipt key, with a SHA-256 hash chain over every key ever used ([0002](0002-transport.md) Section 4.3).
* Receipt-signing public keys are registered on chain in `ReceiptAnchor` and never overwritten.
* Blind-token issuer keys are committed per epoch in `BlindIssuer` ([0003](0003-credits.md)).

### 6.2 Witnessed log (implemented, off by default)

Anyroute runs an append-only log in the C2SP tlog-tiles format [TLOG-TILES] (RFC 6962 hashing [RFC9162], tile height 8) with at least two external witnesses cosigning checkpoints. Every manifest, Oblivious HTTP key configuration, credit keyset and enclave HPKE key is logged. A client MUST refuse a key or configuration without an inclusion proof under a checkpoint carrying the required witness cosignatures (or, where the log uses public-log anchoring instead, a verified Rekor anchor; see below), and SHOULD fetch the checkpoint over a second path to detect a split view. This closes key substitution and user partitioning (guarantee G8).

Entries. Each entry is the canonical JSON `{"v": 1, "type": "anyroute.tlog.entry", "kind", "sha256", "key"}`, and its leaf hash is `SHA-256(0x00 || entry)`. `sha256` is the digest a client computes from the material it holds; `key` carries the public material and its validity window. Entries are appended when a key is created or rotated, deduplicated by (`kind`, `sha256`), and carry no log time.

| `kind` | `sha256` over |
| :--- | :--- |
| `receipt_key` | the raw 32-byte Ed25519 receipt key |
| `ohttp_key_config` | one encoded Oblivious HTTP key configuration ([0002](0002-transport.md) Section 4) |
| `blind_issuer_key` | the issuer's SubjectPublicKeyInfo, which is its `token_key_id` ([0003](0003-credits.md)) |
| `measurement_bundle` | the canonical bundle bytes (Section 5.2), once its Rekor entry verifies |
| `attestation_binding` | `canonical_json(bindings)` of a sidecar whose hardware quote a configured verifier accepted (Section 3.1); this covers the enclave HPKE key when `hpke_pubkey` is bound |

Manifests (Section 5.3) and e-cash keysets ([0003](0003-credits.md)) are logged the same way once they exist.

Checkpoints and witnesses. The log serves `/tlog/checkpoint` as a signed note [SIGNED-NOTE] whose text is the C2SP checkpoint `<origin>\n<size>\n<base64 root>\n` with no extension lines, signed with the log's Ed25519 key (signature type 0x01, key name = origin), followed by the cosignatures collected so far. A witness cosigns with a cosignature/v1 key (type 0x04) over `"cosignature/v1\ntime <t>\n" || checkpoint` [TLOG-COSIGNATURE], and MUST do so only after verifying a consistency proof from the last checkpoint it cosigned for that origin; it MUST refuse a different root at the same size. Witnesses hand their cosignature back with `POST /api/v1/tlog/cosignatures`; the log accepts only witnesses it is configured with and keeps the newest valid cosignature per witness and tree size. `GET /api/v1/tlog/proof` returns an entry with its inclusion proof and, on request, a consistency proof from a size the client names.

Client. A client pins the log's verifier key and the witness keys out of band, never from the log. It accepts a key only when the entry names that kind and digest, the inclusion proof leads to the root of a checkpoint the log signed and at least the configured quorum of witnesses cosigned, and that checkpoint is consistent with the newest one the client remembers (the same root at the same size, or a verified consistency proof). Two checkpoints of one size with different roots, or a failed consistency proof, is a split view: the client refuses and keeps both notes as evidence. Checkpoints fetched from mirrors (a second path) are held to the same rule.

Public-log anchoring (Rekor) (implemented, off by default). As an alternative to cosigning witnesses, the log records its checkpoints in Sigstore's public Rekor log [REKOR], which Anyroute does not operate. When the newest checkpoint is not anchored yet, and at most once per configured interval (ten minutes by default), the log submits a Rekor `hashedrekord` entry whose artifact is the checkpoint as the log signed it: the checkpoint text, a blank line and the log's own signature line, without cosignatures. The entry holds `SHA-256(artifact)` and an ECDSA P-256 / SHA-256 signature over the artifact by a dedicated anchoring key (the type and key algorithm measurement bundles use; Rekor accepts Ed25519 only prehashed). Before serving an entry the log verifies it: its uuid names its body, the body is that artifact signed with the anchoring key, the inclusion proof leads to the root of the checkpoint Rekor returned and, with Rekor's key configured, Rekor's signature on that checkpoint and the signed entry timestamp. It keeps the entry's uuid, log index, integrated time, inclusion proof and signed entry timestamp and serves them with the checkpoint (`checkpoint.rekor`), at `GET /api/v1/tlog/rekor` (the newest anchor and every earlier one) and `GET /api/v1/tlog/rekor/{size}`; the anchoring key is at `GET /api/v1/tlog/rekor/key`. A client that uses anchoring pins the anchoring key and Rekor's key out of band and accepts a checkpoint only with such an entry for exactly that checkpoint, in place of the witness quorum (or in addition to it, when it also pins witnesses); consistency with the checkpoint it remembers is still required. In production the router starts the log only with the witness quorum or with anchoring configured.

Limits of anchoring. It makes a split view detectable after the fact; it does not prevent one. A cosigning witness refuses a second root at a size it has cosigned before any client sees it. Rekor records whatever the anchoring key signs, so the log could anchor two checkpoints of one size with different roots and show each to a different set of clients. Both entries are then public, permanent and timestamped under the anchoring key, and every entry is expected to match a checkpoint the log lists: an entry the log's list does not explain, or two anchored roots for one size, is evidence of a split view that anyone can audit. That evidence is found only if clients or monitors check Rekor: a client that never saw the other history accepts the one it is shown, and detection relies on someone following the anchoring key's entries in Rekor and comparing them with the log's list. Rekor is trusted to be append-only and to show everyone the same tree; its own signed checkpoints cover that. A newly logged key reaches clients that require an anchor only after the next anchor, up to one interval later.

## 7. Key management (planned)

Enclave application keys come from a KMS that itself runs in enclaves, forked from dstack-kms [DSTACK]. The root key is generated inside a KMS enclave and split with FROST distributed key generation across at least three KMS enclaves on at least two providers; no operator holds a share in plaintext. Application keys are derived per application with HKDF; a signature chain from the KMS root through the application root to each purpose key is verifiable against the root registered on chain. Sealing keys are epoch-scoped, and nodes on a revoked image cannot obtain the next epoch's key.

## 8. TCB status

A verifier MUST accept a DCAP TCB status of `UpToDate` or `SWHardeningNeeded`, MAY accept `OutOfDate` only inside the advisory grace window its pinned policy version publishes, and MUST reject `Revoked`. Quote collateral MUST chain to a pinned Intel root that the verifier holds, never one fetched from the attester.

## 9. Verification

The complete ordered checklist, from quote to receipt, is [0004](0004-receipts.md) Section 6. For version 1 evidence a verifier MUST at least:

1. Verify the quote signature and certificate chain with a DCAP verifier. The sidecar does not do this itself and says so (`checks.quote_signature_verified_by_sidecar: false`).
2. Recompute `SHA-256(canonical_json(bindings))` and compare it with the first 32 bytes of `report_data`; for a fresh quote, compare the last 32 bytes with its nonce.
3. Compare `model_digest`, `compose_hash` and `image_digest` with values it trusts.
4. Pin the TLS certificate as in Section 3.2.
5. Verify receipts with `bindings.receipt_pubkey`, and encrypt only to `bindings.hpke_pubkey`.

The router's attestor repeats a nonce-bound check for every attested provider every ten minutes and fails closed: a provider whose evidence does not verify is not eligible for the `attested` or `unlinkable` lanes until it verifies again.

## 10. Security considerations

* **Declared versus measured.** In version 1, `image_digest` is an operator declaration (a process cannot read its own image digest), and the compose hash is measured only where the platform reports it. A verifier MUST treat them accordingly.
* **GPU binding.** Version 1 binds no GPU evidence into the sidecar's quote. Where the router checks GPU evidence a provider reports, that evidence is not bound to the TD. Even with version 2, current GPUs cannot be bound to the TD (no TDISP).
* **SEV-SNP.** SNP lacks a runtime measurement register, so GPU evidence cannot be bound into an SNP report. SNP hosts MUST NOT be presented as carrying confidential-GPU guarantees.
* **Freshness.** A boot quote proves what booted, not that it is still running. Verifiers SHOULD request a nonce-bound quote and SHOULD require the TLS key of the live connection to be the bound one.
* **Weights after boot.** Weights are hashed once, at boot. They MUST be mounted read-only.
* **Side channels and physical attacks** on TEEs are out of scope ([README](README.md#honest-limits)).

## 11. References

### Normative

* [RFC2119] Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119.
* [RFC8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174.
* [RFC8785] Rundgren, A., Jordan, B., Erdtman, S., "JSON Canonicalization Scheme (JCS)", RFC 8785.
* [FIPS180-4] NIST, "Secure Hash Standard (SHS)", FIPS 180-4.
* [RFC5280] Cooper, D., et al., "Internet X.509 Public Key Infrastructure Certificate and CRL Profile", RFC 5280.

### Informative

* [DSTACK] Dstack-TEE, "dstack", https://github.com/Dstack-TEE/dstack (Apache-2.0).
* [TLOG-TILES] C2SP, "tlog-tiles", https://github.com/C2SP/C2SP/blob/main/tlog-tiles.md.
* [SIGNED-NOTE] C2SP, "signed-note", https://github.com/C2SP/C2SP/blob/main/signed-note.md.
* [TLOG-COSIGNATURE] C2SP, "tlog-cosignature", https://github.com/C2SP/C2SP/blob/main/tlog-cosignature.md.
* [RFC9162] Laurie, B., et al., "Certificate Transparency Version 2.0", RFC 9162.
* [REKOR] Sigstore, "Rekor", https://github.com/sigstore/rekor.
* [IN-TOTO] in-toto, "Attestation Framework, Statement v1", https://github.com/in-toto/attestation.
* [DSSE] Secure Systems Lab, "Dead Simple Signing Envelope", https://github.com/secure-systems-lab/dsse.
* [RFC9334] Birkholz, H., et al., "Remote ATtestation procedureS (RATS) Architecture", RFC 9334.
* Intel, "Intel Trust Domain Extensions (TDX) DCAP Quote Generation and Verification".
* NVIDIA, "Attestation documentation", https://docs.nvidia.com/attestation/.
