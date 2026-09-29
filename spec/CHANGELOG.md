# Changelog

All notable changes to the SEAL specification. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Before 1.0.0 any document may change incompatibly; implemented wire formats keep their own version strings.

## [Unreleased]

### Changed

- `0002-transport.md` Section 5: lanes are first-class in the router. How a lane is chosen (request, key default, saved route, and `unlinkable` by default for a relayed blind-token request), enforcement with no fallback (503 `no_attested_endpoint`), 403 `lane_requires_anonymous_auth` for an API key or wallet on `unlinkable` with an opt-in downgrade to `attested`, the lane-aware selection weight `uptime * quality * attested_bonus / price^2`, and lane availability in the model list and status. Replaces 409 `lane_unavailable` and, for lanes, 503 `disclosure_provider_unavailable`.

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
