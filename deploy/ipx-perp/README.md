# IPX index price for an external perpetual venue

This directory describes what an operator must supply to list a perpetual market whose index price is the Anyroute inference price index (IPX), on a venue that lets a builder run the market's price oracle. It covers the parts that live in this repository and the parts that do not.

**Status.** The repository contains the publisher, its safety rules, a read endpoint and a verifier. It does not contain, and this document does not perform, any listing, account, deposit or transaction on a venue. Those steps need an account and funds that only the operator can provide.

## What the router publishes

With `IPX_ENABLED` and `IPX_ORACLE_ENABLED`, the worker job `ipx-oracle` runs every `IPX_ORACLE_INTERVAL_S` seconds. For each class it takes the latest whole-hour IPX sample (the volume-weighted USDG price per 1,000,000 tokens from receipts, see `src/services/ipx.ts`), applies the rules below, signs the result with the oracle key and stores it. It then hands the signed update to each configured sink.

`GET /api/v1/ipx/:class/oracle` returns the stored update, its assessed state, the public key and how to verify it. `bun scripts/ipx-oracle-verify.ts --url <that URL> --public-key <pinned key>` checks one.

| Field | Meaning |
|---|---|
| `price`, `price_e8` | USDG per 1,000,000 tokens, as a decimal string and scaled by 10^8. Null when halted. |
| `timestamp`, `valid_until`, `stale_after_s` | Unix seconds. Do not use the update after `valid_until`. |
| `sequence` | Increases by one per signed record, per class. |
| `status` | `ok`, `thin` or `halted`. |
| `thin`, `volume_usdg_24h`, `thin_threshold_usdg` | Trailing 24-hour receipt volume against the threshold (`IPX_THIN_USDG`). |
| `reduce_only`, `reduce_only_reasons` | Recommendation to allow only position reductions. |
| `source` | End of the sample hour, the receipt root and receipt count behind the price, and the unclamped sample. |
| `clamp` | The move limit, and whether it changed the price. |
| `signature` | Algorithm, signer (public key or address), digest and signature value. |

The digest is SHA-256 over the canonical JSON of the update without `signature` (keys sorted recursively, no whitespace). `ed25519` signs the 32 digest bytes; `secp256k1-eip191` applies EIP-191 personal signing to them. The endpoint text repeats this.

## Safety rules

| Rule | Trigger | Effect | What a consumer does |
|---|---|---|---|
| THIN | Trailing 24-hour volume below `IPX_THIN_USDG` | `status: "thin"`, `reduce_only: true` | Allow reductions only |
| Stale price | No update for `IPX_ORACLE_STALE_AFTER_S` (default 1800) | Each update carries `valid_until`. With no price for the latest hour the publisher signs nothing, so the last update runs out | Halt the market after `valid_until` |
| Move clamp | Sample differs from the previous published price by more than `IPX_ORACLE_MAX_MOVE_BPS` (default 1000) | The price moves at most that far per update, `clamp.applied` is true, and an alert is sent. A large move converges over several updates. The on-chain sink does not post a clamped price | Treat as informational; the raw sample is in `source.raw_price_e8` |
| Kill switch | `IPX_ORACLE_HALTED=true`, or `PUT /api/v1/ipx/oracle/halt` with the operator token | No price is signed or sent to any sink. The latest record becomes a signed record with `status: "halted"` and no price. Reads report `consumer_action: "halt"` immediately | Halt |

Alerts go to `ALERT_WEBHOOK_URL` when set, using the same delivery as the readiness alerts. Messages carry check names only: `ipx_oracle_clamped_<class>`, `ipx_oracle_no_price_<class>`, `ipx_oracle_halted_<class>`, `ipx_oracle_publish_failed_<class>`.

After a halt is lifted, the first price is clamped against the last price published before the halt, so a large change during the halt is approached in steps.

Set the venue's own maximum price age no higher than `IPX_ORACLE_STALE_AFTER_S`, and keep `IPX_ORACLE_STALE_AFTER_S` at least twice `IPX_ORACLE_INTERVAL_S` (enforced).

## What an operator must supply

1. **A venue account** that is allowed to list a market and to run its oracle. This repository holds no account, key or credential for any venue.
2. **An insurance fund** if the venue requires one: a reserve in the asset and amount the venue specifies, held under the operator's account, that covers liquidation shortfalls. The amount is a risk decision for the operator and the venue's rules. This software does not fund, move or size it.
3. **Oracle key registration.** Generate a dedicated key outside this software (`IPX_ORACLE_PRIVATE_KEY`, 32 bytes, hex) and store it as a secret of the worker only. Register the matching public key (ed25519) or address (secp256k1) with the venue, choosing the algorithm the venue accepts (`IPX_ORACLE_ALGORITHM`). Give the API replicas `IPX_ORACLE_PUBLIC_KEY` instead of the private key. The key signs messages only and must not be reused for any chain role. Plan its rotation with the venue.
4. **Market parameters**, chosen by the operator within the venue's limits: market symbol; margin and settlement asset; price decimals and tick size; contract size; maximum leverage; initial and maintenance margin; funding interval and parameters; position and open-interest limits; liquidation parameters; the venue's maximum oracle age; how the venue handles reduce-only markets.
5. **The push interface** of the venue's price-update API: URL, authentication, request format, and how a request is signed. Copy `push-config.example.json`, replace the placeholders, and point `IPX_ORACLE_PUSH_CONFIG` at it. Variables it may use, and the `{{env:IPX_ORACLE_PUSH_*}}` secret references, are described in `src/services/ipx-oracle-push.ts`. Secrets stay in the environment.
6. **Operations.** A worker whose `WORKER_JOBS` includes `ipx-oracle`, a webhook for alerts, and a person who can call the halt endpoint.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `IPX_ENABLED`, `IPX_ORACLE_ENABLED` | `false` | Both are required |
| `IPX_ORACLE_PRIVATE_KEY` | none | Worker only. Never generated or printed by this software |
| `IPX_ORACLE_PUBLIC_KEY` | derived | For API replicas that do not hold the private key |
| `IPX_ORACLE_ALGORITHM` | `ed25519` | Or `secp256k1-eip191` |
| `IPX_ORACLE_CLASSES` | all IPX classes | Comma list |
| `IPX_ORACLE_INTERVAL_S` | `300` | 10 to 3600 |
| `IPX_ORACLE_STALE_AFTER_S` | `1800` | At least twice the interval |
| `IPX_ORACLE_MAX_MOVE_BPS` | `1000` | 1 to 10000 |
| `IPX_ORACLE_HALTED` | `false` | Configuration kill switch |
| `IPX_ORACLE_PUBLISHERS` | none | `onchain`, `https` |
| `IPX_ORACLE_FEEDS` | none | `{"IPX-OPEN-70B":"0x<IPXFeed address>"}` |
| `IPX_ORACLE_ONCHAIN_SUBMIT` | `false` | Off: calldata only. On: posts with `IPX_KEEPER_PRIVATE_KEY` |
| `IPX_KEEPER_PRIVATE_KEY` | none | The IPXFeed keeper. Needs its own worker; production refuses it beside another signing key or on the API |
| `IPX_ORACLE_PUSH_CONFIG` | none | Path to a JSON file, or the JSON |

## Bring-up order

1. Enable IPX and the oracle on the worker with the private key; give the API the public key. Leave `IPX_ORACLE_PUBLISHERS` empty.
2. Wait for the first hour with receipts. Read `GET /api/v1/ipx/<class>/oracle` and run the verifier with the pinned key. Confirm `status`, `thin` and `valid_until` are what you expect.
3. Exercise the halt endpoint and lift it again while nothing consumes the feed.
4. Add the `onchain` sink with `IPX_ORACLE_ONCHAIN_SUBMIT=false` and inspect the calldata it records against `IPXFeed.update`. Enable submission only for a feed the operator has deployed and where the keeper is set.
5. Add the `https` sink against the venue's test environment if it has one. Only then move to the production market.

## Limits

- The price is built from receipts on this router. When volume is low a few accounts can move it. `IPX_MAX_ACCOUNT_SHARE_BPS` caps one account's share and `IPX_THIN_USDG` sets the volume below which the market is reduce-only. Neither replaces the venue's own controls.
- If the router, the worker or the database is unavailable, updates stop and consumers halt after `valid_until`. That is the intended behaviour.
- The reason text of a halt is public in the endpoint response. Keep it short and factual.
