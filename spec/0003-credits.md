# SEAL 0003: Anonymous credits

| | |
| :--- | :--- |
| Status | Draft |
| Version | 0.1.0 |
| Updated | 2026-09-29 |
| License | Apache-2.0 |
| Related | [0002](0002-transport.md), [0004](0004-receipts.md) |

## Status of this document

This is a working draft of the SEAL protocol. It is not an IETF document. Sections marked **(implemented)** describe formats that exist in this repository and are frozen under their version string. Sections marked **(planned)** describe the target design and may change before 1.0.0.

## Abstract

A request on the `unlinkable` lane is paid with a credential the issuer signed blindly: the issuer sees what it signs at purchase and what is spent at redemption, and cannot connect the two. SEAL defines two credential types. Blind RSA tokens (Privacy Pass token type `0x0002`) are implemented: fixed value, single use, publicly verifiable. Blinded e-cash credits (Cashu-style blind Diffie-Hellman key exchange with DLEQ proofs and P2PK locks) are planned: they add change for variable-cost requests and a proof that the issuer did not tag a user with a private key.

## 1. Conventions and terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

* **Issuer (M)**: the party that blind-signs credentials. In version 1 the router; in the planned design a mint running in an enclave.
* **Nullifier**: a value derived from a spent credential that the issuer stores so the credential cannot be spent twice. It reveals nothing about the purchase.
* **Epoch** or **keyset**: a period during which one set of issuer keys signs.
* **Denomination**: the fixed value of one credential under a key.
* For the elliptic-curve scheme: `G` is the secp256k1 generator, lowercase letters are scalars, uppercase are points, and `hash_to_curve` is as defined in [NUT-00].

## 2. Properties

| Property | Blind RSA tokens (implemented) | Blinded e-cash credits (planned) |
| :--- | :--- | :--- |
| Unlinkable purchase and redemption | Yes | Yes |
| Verification without the issuer | Yes (public key) | No (the issuer's private key verifies) |
| Proof of no per-user key | Keys committed on chain per epoch; a client can check the key id | DLEQ proof on every signature |
| Change for variable cost | No (the request may cost at most the token's value; the remainder stays in the pool) | Yes (blinded change outputs) |
| Bound to a holder | No (bearer) | Yes (P2PK lock to the SDK key) |

## 3. Blind RSA tokens (implemented)

### 3.1 Suite

Tokens are Privacy Pass token type `0x0002` [RFC9578] over RSA blind signatures [RFC9474] with the variant RFC 9578 fixes for this type: RSABSSA-SHA384-PSS-Deterministic, a 2048-bit modulus, SHA-384, MGF1-SHA-384 and a 48-byte salt. Tokens are presented with the `PrivateToken` HTTP authentication scheme [RFC9577].

### 3.2 Challenge

The router issues one `TokenChallenge` ([RFC9577] Section 2.1): token type `0x0002`, issuer name and origin info both the router's host, and an empty redemption context. Tokens are single use, so the challenge does not need to be fresh.

### 3.3 Keys, denominations and epochs

For every epoch the issuer creates one key per denomination: 1,000, 10,000 and 100,000 units. A token's value is its denomination at the unit price fixed when its key was created. Epoch `e` covers `[e * epoch_seconds, (e + 1) * epoch_seconds)` since the Unix epoch (one week by default). A key signs only inside its epoch, is redeemable until a grace period after it (one week by default), and loses its private half when its epoch ends. The next epoch's keys are published before they are used. Key status values are `upcoming`, `issuing`, `redeem_only`, `expired` and `revoked`.

`BlindIssuer` (on chain) records, per epoch, a commitment to the denominations and key ids, aggregate issuance counts, and revocation. It holds no funds and records no buyer. A client SHOULD check a key id against the on-chain commitment before buying, which prevents the issuer from giving one buyer a key nobody else has.

### 3.4 Wire format

```
token_input = 0x0002 || nonce (32) || challenge_digest (32) || token_key_id (32)
token       = token_input || authenticator (256)
challenge_digest = SHA-256(TokenChallenge)
token_key_id     = SHA-256(public key, as RFC 9578 encodes it)
```

### 3.5 Purchase

`POST /api/v1/blind/purchase` with an API key carries N blinded messages for one denomination; the caller's balance pays for N signatures. The issuer records the debit and a per-key issued count. It MUST NOT record the blinded messages, the signatures, or anything derived from a token. A purchase is idempotent: its hold id derives from the account, the key and the blinded messages, so a retry after a lost response signs again without charging again. `GET /api/v1/blind/keys` lists the keys, public.

The purchase is linkable to the account; the blinding is what makes the later redemption unlinkable. Through the Oblivious HTTP gateway the purchase can also be made without revealing the buyer's address.

### 3.6 Redemption

A request presents `Authorization: PrivateToken token=<base64url>`. The router:

1. verifies the signature, key epoch and challenge, without spending;
2. requires the request's maximum cost to be at most the token's value (else 402);
3. claims the nullifier `SHA-256(token)` under a primary-key constraint, so a second claim fails;
4. confirms the spend after the request was served, or releases the claim if nothing was served.

Every redemption is charged to one pooled internal account. The ledger, the generation record and the receipt carry no buyer: the receipt carries the nullifier and the key id ([0004](0004-receipts.md)).

## 4. Blinded e-cash credits (planned)

### 4.1 Scheme

Chaumian e-cash with blind Diffie-Hellman key exchange on secp256k1, as in the Cashu protocol [NUT-00]; the planned implementation builds on the Cashu Development Kit [CDK]. The issuer's key for amount `a` in keyset `K` is `k_a`, with public key `K_a = k_a·G`.

```
client:  x random secret;  Y = hash_to_curve(x);  r random;  B_ = Y + r·G
issuer:  C_ = k_a·B_                              plus DLEQ proof (4.2)
client:  C = C_ - r·K_a                            the proof is (a, x, C, keyset id)
redeem:  issuer checks k_a·hash_to_curve(x) == C, then stores Y as the nullifier
```

The issuer MUST check and store the nullifier before any compute starts, atomically with reserving the request's maximum cost.

### 4.2 DLEQ proof

Every blind signature MUST carry a discrete-log-equality proof [NUT-12] that `log_G(K_a) == log_{B_}(C_)`: the issuer used the published key, not one reserved for this user. The client MUST verify it before accepting a signature and MUST keep it with the proof so a third party can verify it later.

```
issuer:  p random;  R1 = p·G;  R2 = p·B_;  e = H(R1, R2, K_a, C_);  s = p + e·k_a mod n
client:  R1 = s·G - e·K_a;  R2 = s·B_ - e·C_;  accept iff e == H(R1, R2, K_a, C_)
```

`H` and the point encodings are as in [NUT-12].

### 4.3 Locking, change and backup

* **P2PK.** Secrets are well-known secrets locked to the SDK's public key [NUT-11]; spending requires a Schnorr signature by that key. Credits are therefore non-transferable prepaid inference.
* **Change.** A request carries proofs worth at least its maximum cost plus blinded change outputs. After settlement the issuer signs change outputs worth the difference, in the manner of fee return [NUT-08], and swaps follow [NUT-03].
* **Deterministic secrets.** Wallets derive secrets and blinding factors from a seed [NUT-13] so they can be restored from backup.
* **Payment challenge.** A request without credits is answered with HTTP 402 in the shape of [NUT-24].

### 4.4 Denominations and keysets

Amounts are in the unit `tok`. Denominations are powers of two from 2^10 to 2^20. A wallet MUST split amounts canonically (the binary decomposition), so the set of denominations a user holds does not fingerprint them. Keysets carry `id`, `unit` and `active` [NUT-02]; they are derived from the KMS epoch ([0001](0001-attestation.md) Section 7), published in the transparency log, and rotated monthly: `active = false`, then a 30-day grace for redemption, then retirement, after which the keyset's nullifier shard is dropped.

### 4.5 Issuer deployment

The issuer runs as an enclave with the same attestation as the sidecar ([0001](0001-attestation.md)). Nullifiers are kept in a sealed store inside the enclave with exactly one writer per keyset; a standby enclave receives snapshots. Multi-writer redemption MUST NOT be allowed: it turns a race into a double spend.

### 4.6 Purchase

A client asks for a quote (amount and rail), pays on the rail, then submits blinded outputs against the quote id. The issuer learns the amount and the rail transaction, never the blinded outputs' later use. Clients SHOULD round amounts and delay issuance after payment to weaken timing correlation. `CreditMintEvents` emits `Purchased(quote_id_hash, amount, rail)` and `KeysetPublished(id, pubkeys_hash, log_ref)` so issuance is auditable; no buyer-to-token link exists to leak.

### 4.7 Relation to Privacy Pass

Privacy Pass tokens are fixed value and single use with no change, and the drafts that add amounts are unfinished. SEAL keeps type `0x0002` tokens as an optional, publicly verifiable credential for third parties that need offline-verifiable proof of paid access without calling the issuer.

## 5. Security considerations

* **Key tagging.** An issuer that signs one user with a unique key can link that user's redemptions. Blind RSA tokens rely on published, committed per-epoch keys; e-cash credits add a DLEQ proof per signature. Clients MUST refuse keys not in the commitment or log.
* **Double spend.** Nullifier storage is the only durable artifact of a redemption and MUST be checked atomically with the reservation. In version 1 this is a primary-key constraint in the router's database.
* **Anonymity set.** Unlinkability is only as strong as the number of users holding the same denomination under the same key. Few denominations and canonical splitting keep sets large; per-user timing (buy then spend at once) shrinks them.
* **Purchase linkage.** A purchase with an API key or on a transparent chain is linkable to the payer. The blinding protects the redemption, not the purchase.
* **Value.** A token pays for at most its face value. A request that could cost more is refused before the token is claimed.
* **Loss.** Tokens and proofs are bearer or holder-locked data held by the client. Lost secrets cannot be recovered except from a deterministic backup.

## 6. References

### Normative

* [RFC2119] Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119.
* [RFC8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174.
* [RFC9474] Denis, F., Jacobs, F., Wood, C. A., "RSA Blind Signatures", RFC 9474.
* [RFC9576] Davidson, A., et al., "The Privacy Pass Architecture", RFC 9576.
* [RFC9577] Pauly, T., Valdez, S., Wood, C. A., "The Privacy Pass HTTP Authentication Scheme", RFC 9577.
* [RFC9578] Celi, S., et al., "Privacy Pass Issuance Protocols", RFC 9578.
* [NUT-00], [NUT-02], [NUT-03], [NUT-08], [NUT-11], [NUT-12], [NUT-13], [NUT-24] Cashu, "Notation, Usage, and Terminology", https://github.com/cashubtc/nuts.

### Informative

* [CDK] Cashu Development Kit, https://github.com/cashubtc/cdk (MIT).
* Chaum, D., "Blind Signatures for Untraceable Payments", CRYPTO 1982.
* Chaum, D., Pedersen, T. P., "Wallet Databases with Observers", CRYPTO 1992 (DLEQ proofs).
