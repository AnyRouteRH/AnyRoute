# Changelog

All notable changes to the SEAL specification. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Before 1.0.0 any document may change incompatibly; implemented wire formats keep their own version strings.

## [Unreleased]

### Added

- `0002-transport.md` Section 5.6: lane `unlinkable` over the onion service is implemented, off by default (`UNLINKABLE_VIA_ONION`). Tor takes the place of the independent relay; onion requests are recognised only by the secret the onion proxy sets (compared in constant time), address headers are removed and never used on them, payment and endpoint rules are those of Section 5.5, streaming works, and the router refuses to start with the switch on unless the onion address, the proxy secret and blind tokens are configured. Sections 5.1, 5.4 and 5.5 name the second path, and `GET /api/v1/status` reports `lanes.unlinkable.via`. `README.md`: the `unlinkable` lane row, G5, party R, an honest limit for the Tor path, and status rows.
- `0001-attestation.md` Section 6.2: the witnessed log is implemented, off by default. Entry format and kinds (receipt keys, Oblivious HTTP key configurations, blind-token issuer keys, measurement bundles, sidecar key bindings), C2SP tlog-tiles serving, signed-note checkpoints, cosignature/v1 witnesses that check consistency before cosigning and hand cosignatures back with `POST /api/v1/tlog/cosignatures`, and the client's split-view rule; `README.md` status row updated.
- `0004-receipts.md` Section 5.2: per-host anchoring of node receipts is implemented, off by default. The router takes each attested host's receipt key from the boot quote it verified, keeps only leaves signed by that key under that attestation, roots them per host and interval, posts each root with `ReceiptAnchor.anchorAttested` where a chain is configured (status `local` otherwise), and serves `GET /api/v1/host-anchors/proof/{leaf}` and `POST /api/v1/host-anchors/proof`; `packages/client` checks a receipt against the proof and the root on chain (`verifyHostAnchor`).
- `0002-transport.md` Section 4.5: chunked Oblivious HTTP is implemented, off by default (`OHTTP_CHUNKED_ENABLED` on the gateway, `RELAY_CHUNKED_ENABLED` on a relay). Chunked requests, responses sent chunk by chunk as they are produced so `"stream": true` works through a relay, the final-chunk rule for truncation, `Incremental: ?1`, `gateway.chunked` in the relay list, and an opt-in check of the key configuration against the witnessed log; a mandatory inclusion proof, relay diversity, fixed-tick padding and fingerprint normalisation stay planned. `README.md`: its status row.
- `0005-policy.md` Section 3.4: privacy-safe stats as implemented. Four counter families with fixed labels and a per-request contribution bound of 1, hourly release with Laplace noise through Mironov's snapping mechanism and a CSPRNG, non-negative post-processing, the per-day epsilon ledger, the `GET /v1/stats` document, and the router's rule that attested and unlinkable traffic reaches public metrics only through these counters.
- `0004-receipts.md` Section 4: router receipts v2 are implemented. A COSE_Sign1 (RFC 9052) signed EdDSA with the router's Ed25519 receipt key over a deterministic-CBOR (RFC 8949) claim set; bucketed token counts; the chunk hash chain over router streams; the v2 anchor leaf beside the v1 leaf in the same hourly tree; `GET /api/v1/receipts/{id}/proof`, with `anchored` true only once the root is on chain; a byte-exact test vector.

### Changed

- `0002-transport.md` Section 5: lanes are first-class in the router. How a lane is chosen (request, key default, saved route, and `unlinkable` by default for a relayed blind-token request), enforcement with no fallback (503 `no_attested_endpoint`), 403 `lane_requires_anonymous_auth` for an API key or wallet on `unlinkable` with an opt-in downgrade to `attested`, the lane-aware selection weight `uptime * quality * attested_bonus / price^2`, and lane availability in the model list and status. Replaces 409 `lane_unavailable` and, for lanes, 503 `disclosure_provider_unavailable`.
- `0005-policy.md` Section 4.3: planned telemetry now covers only what Section 3.4 does not (per-category counts, attested privacy parameters).
- `0004-receipts.md` Section 4.2: each chain value `c_i` travels as an SSE comment line (`: anyroute-chain <i> <hex>`) after the i-th event instead of in the event's `id` field, so clients that treat every event block as starting with `data:` keep working.
- `README.md`: status rows for privacy-safe stats and for receipts v2.

## [0.1.0] - 2026-09-29

First public draft.

### Added

- `README.md`: what SEAL is, the lanes `public`, `attested` and `unlinkable`, guarantees G1 to G8 as design targets, what each party learns, honest limits, and a status table of what exists in this repository and what is planned.
- `0001-attestation.md`: the sidecar's evidence document and version 1 bindings (`report_data = SHA-256(canonical_json(bindings)) || nonce`), the attestation reference and certificate, the model digest, boot order, measurement registry and Rekor bundles; planned version 2 binding, RTMR3 events, manifests, witnessed log and KMS.
- `0002-transport.md`: inner encryption `anyroute-hpke/v1` (RFC 9180) with its request layout and framed response; the Oblivious HTTP gateway (RFC 9458, RFC 9292), epoch keys, signed key history and relays; the onion service; lane rules and refusals; planned chunked inner encryption and chunked Oblivious HTTP.
- `0003-credits.md`: Privacy Pass type `0x0002` blind RSA tokens (RFC 9474, RFC 9576 to RFC 9578) as implemented; planned blinded e-cash credits with BDHKE, DLEQ proofs, P2PK locks and change.
- `0004-receipts.md`: receipt claims across node receipts v1, router receipts v1 and planned COSE_Sign1 receipts v2; the chunk hash chain; hourly Merkle anchoring; the ten-step verification order and what can be checked today.
- `0005-policy.md`: the measured in-enclave classifier policy, refusal outcomes and receipts; planned `policy.json`, streaming enforcement, noisy telemetry and disputes without logs.
- `LICENSE`: Apache License 2.0 for this folder.

[0.1.0]: https://github.com/AnyRouteRH/AnyRoute/tree/main/spec
