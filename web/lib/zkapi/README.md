# Sepolia browser payments

The page is disabled by default. No operator URL, proving key or manifest is
bundled. It contains Anyroute's wrapper and bindings generated directly from
the pinned MIT OR Apache-2.0 Rust crate, without upstream SDK JavaScript.

Build with Rust/Cargo 1.96.0, the wasm32-unknown-unknown target, and
wasm-bindgen-cli 0.2.117. Install that CLI into a task-specific directory with
`cargo install wasm-bindgen-cli --version 0.2.117 --locked --root /tmp/zkapi-tools`.
The protocol workspace lock resolves wasm-bindgen 0.2.117. The exact command is:

```sh
ZKAPI_SOURCE=/path/to/upstream PATH=/tmp/zkapi-tools/bin:$PATH bash web/scripts/build-zkapi-wasm.sh
```

The script archives only protocol/rust from revision
045b444ea1b52538d1b40273c7cb6ed09468a052, builds with `cargo --locked`, strips
host source paths, and generates the bindings, WASM and provenance hashes into
web/public/zkapi/. It never reads sdk/ or setup artifacts. Compilation of the
protocol library does not establish a production audit or a setup ceremony.

Build constants: NEXT_PUBLIC_ZKAPI_ENABLED defaults to false (only `true`
enables initialization); NEXT_PUBLIC_ZKAPI_MANIFEST_URL and
NEXT_PUBLIC_ZKAPI_MANIFEST_SHA256 default to empty. The latter pins the exact
manifest bytes, including whitespace. These are public configuration, never
credentials. The inference origin is the existing NEXT_PUBLIC_ANYROUTE_API_URL,
or the page origin. The key response must identify that origin's /api/v1 path.
An inference-only scope is checked by requiring /api/v1/credits to refuse it
with HTTP 403 and error.type inference_only. Keys are never persisted.

The hosted operator must expose this manifest contract, using its own setup
and newly deployed matching vault. Values below are field descriptions,
not a served manifest:

| Field | Required value |
| --- | --- |
| protocol_version, chain_id | 2, 11155111 |
| source_revision | 045b444ea1b52538d1b40273c7cb6ed09468a052 |
| circuit_id | zkapi-v2-note-bound-v1 |
| billing_asset, billing_unit | native_eth, gwei |
| contract_address | 20-byte vault address |
| request_charge_cap | positive safe-integer gwei proof minimum |
| admission_enabled | boolean; false refuses new deposits and leases while allowing recovery |
| state_signing_key, clearance_signing_key | objects with x/y hexadecimal field coordinates |
| operator_url, indexer_url | HTTPS bases without credentials or trailing slash |
| proving_keys.request, proving_keys.withdrawal | objects with url and lowercase SHA-256; hosted on operator origin |

ZK8's /config.json shape is also accepted directly: source_commit is normalized
to source_revision; protocol version is 2 for the pinned circuit; decimal
state_signing_key_x/y and clearance_signing_key_x/y are normalized to hex. Its
setup_provenance must bind the same circuit revision and ID. The setup_ceremony
must be single-party and production_audited false, with explicit native feed,
decimals, freshness and billing-unit pins. Proving-key URLs are derived as
operator_url/setup/request.pk and operator_url/setup/withdrawal.pk, with hashes
from setup_provenance.artifacts. Admission state is preserved. No deployment
manifest, provenance or proving-key bytes are copied into the web bundle.

All fetches omit credentials and refuse redirects. The manifest and proving
key hashes are checked; WASM validates tree roots, proof statements, successor
commitment algebra and Schnorr signatures, and withdrawal clearance. The
injected wallet independently checks chain ID, deployed vault code, signing
coordinates, native billing units and solvency minimum. Quote checks require
the pinned Chainlink feed, its latest finalized round and 4,500-second freshness.
The manifest is a trusted build pin; it is not independently signed evidence
of deployed operator behavior. The RPC connection is the user's wallet's RPC.

Required operator paths are GET /v2/billing/quote, POST /v2/openrouter/leases,
POST /v2/openrouter/leases/{id}, GET /v2/requests/{id}, and
POST /v2/withdraw/clearance. They use public proof/nullifier capability binding,
without site cookies. Indexer GET /v1/tree/snapshot returns the whole tree;
the wrapper never requests a user's note path from the operator. The hosted
services and proving-key responses need CORS for the website origin. A
password-gated operator is not supported by this page. Provision only
inference-only child keys and maintain recovery endpoints when stopping new
admissions.

## Hosting policy

The router applies a narrowly scoped policy when ZKAPI_PAGE_ORIGINS is set
to a comma-separated list of exact HTTPS origins. Paths, trailing slashes,
wildcards and credentials are refused at startup. Empty preserves the existing
site policy; do not enable funding under that policy. The hosted gateway,
manifest, proving keys and indexer share one origin, so list that origin once.
The /zkapi page, /zkapi/, /zkapi/index.html and /zkapi.html retain the site's
exact inline-script hashes, add worker-src 'self', and append only those origins
to connect-src. The /zkapi/prover-worker.js response gets default-src 'none',
script-src 'self' 'wasm-unsafe-eval', and connect-src 'self' plus those origins.
No unsafe-eval, blob workers, wildcard origins or remote scripts are allowed.
The static handler serves .wasm as application/wasm and modules as
text/javascript. Other pages retain their existing CSP.

The Docker web stage accepts NEXT_PUBLIC_ZKAPI_ENABLED (default false),
NEXT_PUBLIC_ZKAPI_MANIFEST_URL and NEXT_PUBLIC_ZKAPI_MANIFEST_SHA256 (both
default empty) as public build arguments. Set them before building, along
with the matching router origin policy at runtime. The operator must allow
CORS for the page origin. No deployment setting is changed automatically.
The export audit checks asset isolation, not production HTTP headers.

## Recovery and limits

The browser saves one record, anyroute-zkapi-private-wallet-v1, with deployment,
private note state, pending deposit and transaction hash, proof journal and
withdrawal transaction hash. There are no new router tables, Redis keys or log
fields. EIP-1193 reads a public wallet address and balance; they stay in page
memory. Notes, witnesses and exports never cross the network. Chain transaction
calldata carries only the registration commitment, amount, public inputs,
proof and public Merkle siblings. Operator requests carry public proofs,
nullifiers, request IDs and quote metadata. Chat sends ordinary plaintext
prompts to Anyroute; its IP, account linkage and provider limits still apply.

Exports contain plaintext secrets and a corruption checksum. They are neither
encrypted nor authenticated backups. Restore refuses to overwrite an existing
note or journal. Use a current backup; an old signed state is not necessarily
the latest spend state. The same-origin Web Lock protects concurrent tabs,
not other devices or manually copied backups. A journal is committed before
issuance and never cleared on an ambiguous error. After a reload, retire the
saved proof rather than minting another key. Retirement's pending 409 does not
mean settlement succeeded; only Rust-verified successors clear the journal.

New leases stop ten minutes before note expiry to leave time for settlement
and withdrawal. This margin is not a guarantee of operator availability.
One chat attempt per lease is persisted before sending, with the fixed Llama
3.3 70B Instruct model and max_tokens 64. Failed or lost replies can still cost
money: the displayed spend covers replies received here, while settlement is
the operator's usage assertion. It is not a proof of correct token metering
or concurrent stream drain. Browser caps are $5 per note and $1 per lease;
they do not impose a vault TVL cap, aggregate operator exposure cap or server
admission policy. Withdraw before note expiry. A signed successor is not cash.

Deposit submission saves secrets before opening the wallet. If confirmation
is delayed, use the saved hash; if the wallet's hash response was lost, supply
the transaction hash from wallet activity. No automatic funding retry occurs.
Only an unsent deposit, or an explicit wallet rejection, can be retried using
the same saved secret. Ambiguous submissions block retries. Withdrawal saves
a pending marker before signing, and preserves it if the hash reply is lost.
Withdrawal recovery checks the matching mutual-close event and on-chain Closed status before
clearing the note. Escape/challenge tooling, relayed withdrawals, mainnet,
encrypted inference and automatic onion routing are outside this page's scope.
No public transaction or inference request was made during this implementation.
