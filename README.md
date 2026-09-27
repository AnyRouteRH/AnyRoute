# Anyroute

**Any model. One key. Paid per call.** An OpenRouter-compatible inference router on Robinhood Chain (4663):
one USDG balance, 0% on prepaid, ≤1% per call, signed receipts anchored on-chain, bonded providers,
an attested private route, creator royalties, and pay-with-any-Stock-Token.

Existing OpenRouter/OpenAI clients change two lines: the base URL and the key.

```ts
const client = new OpenAI({ baseURL: "https://<router>/api/v1", apiKey: "sk-ar-v1-…" });
await client.chat.completions.create({ model: "meta-llama/llama-3.3-70b-instruct", messages, provider: { sort: "price" } });
```

---

## Quick start (local, no setup)

Everything at once — local chain + contracts, mock providers, router, website:

```bash
bun install && bun run launch      # prints the address (http://127.0.0.1:8787, or the next free port)
```

Open the dashboard, create a key, press Deposit → "Add 10 test USDG", and run a call in the Playground.
Flags: `--open` opens the browser, `--fresh` wipes the local chain and database, `--port N` serves on another port.
Ctrl-C stops everything; chain, database, keys and balances are kept in `.data/`. Needs Bun 1.3+, Foundry
(`anvil`, `forge`) and pnpm (the website is rebuilt when its sources change). The test-USDG faucet and the
mock TEE's dev attestation are local-only.

Piece by piece:

```bash
bun install
bun test                                   # 115 backend tests on in-process Postgres (12 opt-in: E2E/Redis/live chain)
bun run services:up && bun run test:pg     # same suite on real Postgres 16 + Redis
cd contracts && forge test && cd ..        # Solidity suite (Foundry)
bun scripts/mock-providers.ts &            # 3 local mock providers (ports 9101-9103)
bun scripts/seed.ts config/providers.local.yaml
bun run dev                                # router on http://127.0.0.1:8787
```

Full local chain (anvil + every contract deployed + router wired to it):

```bash
bun scripts/deploy-local.ts --keep         # starts anvil :8546, deploys, writes .env.local
bun --env-file=.env.local run dev
```

Production stack: `docker compose up` (router + Postgres/TimescaleDB + Redis). Copy `.env.example` to `.env` first.
Going live also needs real provider API keys (`config/providers.example.yaml`), a mainnet deployment of the contracts
through the owner Safe + 24h timelock (`contracts/script/Deploy.s.sol`), and a DCAP verifier (`TDX_VERIFIER_URL`)
for the private route. With `ANYROUTE_ENV=production` the router refuses to start without an https base URL and
strong secrets, or with an in-memory database, dev attestation or the test faucet.

### Website

The website (landing page, live model catalog, docs, dashboard) lives in `web/` and is served by the router
itself at `/` once built — same origin as the API, so no CORS or extra hosting:

```bash
cd web && pnpm install --frozen-lockfile && pnpm build && cd ..   # writes web/out/
bun run dev                                                        # site at /, API at /api/v1
```

The dashboard talks to the live API: create or paste a key, deposit USDG and withdraw with your wallet, open
Stock Token sessions, stream calls in the playground, and verify each receipt against the chain. A clearly
labelled sample workspace (`?demo=1`) keeps the original browser-only preview for demos. `WEB_DIR` points at
another build; `PUBLIC_RPC_URL` / `EXPLORER_URL` are what the site tells wallets to use.

---

## What's in the box

| Layer | Where | What |
|---|---|---|
| Edge router | `src/api/chat.ts`, `src/router/*` | OpenRouter API parity, provider selection (1/price² × uptime × quality), fallback, empty-200 detection, SSE |
| Ledger | `src/ledger/ledger.ts`, `drizzle/0001_invariants.sql` | Append-only pico-USD ledger, reserve → settle/release holds, DB-enforced invariants |
| Payments | `src/pay/*` | Prepaid (0%), HTTP 402 per-call (tx hash or gasless EIP-3009), Pay-with-Stock-Token |
| Receipts | `src/receipts/*`, `src/services/anchor.ts` | Ed25519 per generation, weekly key rotation (pubkeys on-chain), hourly merkle anchors |
| Providers | `src/services/registry.ts`, `health.ts`, `probes.ts` | Provider spec import, onboarding (apply → bond → 7-day shadow → live), 30s outage window |
| Accountability | `src/services/canaries.ts`, `slasher.ts` | Quant fingerprints + quality score, bond slashing with a 72h dispute window and refunds |
| Privacy | `src/services/attestor.ts` | TEE attestation (TDX quote + NVIDIA NRAS, nonce-bound), fail-closed private route |
| Settlement | `src/services/settlement.ts` | Hourly provider invoices (2% fee), royalties, spent roots for self-custodial withdrawals, margin → staking |
| Gateway floor | `src/gateway/*`, `src/api/keys.ts` | Virtual keys/budgets/RPM/TPM, teams/RBAC, BYOK, cache, guardrails, OTel, LiteLLM import |
| Admin | `src/admin/trpc.ts` | tRPC v11 at `/trpc` |
| Website | `web/` (Next.js static export), `src/app.ts` | Landing, live catalog, docs, dashboard; served at `/` by the router |
| Contracts | `contracts/src/*` | Credits, CallPay, PayWithStock (+ Chainlink oracle, Uniswap V3/V4 adapters), ProviderBond, ReceiptAnchor, Royalty, AnyrToken, AnyrStaking, AnyrPaymaster |

---

## API

All routes are under `/api/v1` (also `/v1/*` for the three OpenAI-style endpoints).

| Method | Path | Notes |
|---|---|---|
| POST | `/chat/completions` | OpenAI body + `model` (`author/model[:nitro\|:floor\|:free\|:private]`), `models[]`, `provider{…}`, `route`, `transforms`, `usage`, `reasoning`, `tools`, `response_format`, `stream`. Headers: `X-Pay-With`, `X-Payment`, `X-Wallet-Auth`, `HTTP-Referer`, `X-Title` |
| POST | `/completions`, `/embeddings` | Legacy completions; embeddings (prepaid) |
| GET | `/models`, `/models/:author/:slug/endpoints`, `/providers` | OpenRouter shapes + `data_policy`, `quantization`, `attested_available`, `creator`, `royalty_bps` |
| GET | `/generation?id=` | Full generation record, `paid_with`, `anchor {root, index, proof[]}` |
| POST/GET/PATCH/DELETE | `/keys`, `/keys/:hash` | No auth → new self-custodial root key. With a management key → virtual sub-keys (`limit`, `limit_reset`, `rpm`, `tpm`, `allowed_models`, `team`, `pay_with_default`, `guardrails`, `routing`) |
| GET | `/key`, `/credits`, `/credits/withdrawal-proof` | Balance; merkle proof for `Credits.finalizeWithdrawal` |
| POST/GET/DELETE | `/byok` | Bring-your-own provider keys (encrypted at rest) |
| POST/GET/PUT | `/teams`, `/teams/:id/members/:hash` | Roles: owner, admin, member, viewer |
| POST | `/auth/wallet` | Turn a per-call payer's change into a key (signed message) |
| GET/POST | `/paywith/tokens`, `/paywith/open`, `/paywith/close`, `/paywith/session`, `/paywith/statement` | Stock-Token sessions (unsigned txs for the wallet) and monthly statements |
| GET/POST | `/receipts/:id`, `/receipts/verify`, `/receipts/keys` | Public receipt proofs; JWKS of signing keys |
| GET | `/rankings?period=day\|week\|month` | Tokens by model and app, paid to creators |
| POST | `/providers/apply` | Provider onboarding (OpenRouter provider spec) |
| POST | `/paymaster` | ERC-7677 paymaster service (sponsors Anyroute actions only) |
| GET | `/status`, `/health` | Configuration and job status |

Response additions: `provider`, `usage.cost`, `usage.cost_details {upstream_inference_cost, royalty, margin}`,
`usage.prompt_tokens_details.cached_tokens`, `usage.completion_tokens_details.reasoning_tokens`, and
`receipt {id, sig, key_id, payload, leaf, anchor_hint, paid_with?}`.

### Paying

- **Prepaid (0%)** — `bun scripts/key.ts new`, approve USDG to `Credits`, `deposit(key_hash, amount)`. The key works on
  first use; there is no account step. Withdraw any time: `requestWithdrawal` (signed by the key) → next spent root →
  `finalizeWithdrawal` with the proof from `/credits/withdrawal-proof`.
- **Per call (≤1%)** — no key: the router answers `402` with `price_usdg`, `pay_to`, `nonce`, `expiry`, `chain`, calldata,
  and ready-to-sign EIP-712 data. Pay either on-chain (`CallPay.pay`, gas sponsored by `AnyrPaymaster`) and retry with
  `X-Payment: <txHash>`, or sign the USDG `ReceiveWithAuthorization` and retry with
  `X-Payment: base64({"scheme":"eip3009",…})` — the router relays it, no gas needed. Change stays on the payer's
  wallet account (`X-Wallet-Auth` or `/auth/wallet`).
- **Pay with Stock Tokens** — `POST /paywith/open {token: "NVDA", cap_raw_per_day, wallet}` returns the approve +
  `openSession` txs. Calls with `X-Pay-With: NVDA` accrue; at $1 (or 24h) the router swaps exactly the USDG owed at
  Chainlink fair value (slippage-bounded, V3/V4) from the capped session. Receipts show the share fraction; if the
  oracle is stale/paused the call falls back to prepaid USDG, else 402.

---

## Tests

```bash
bun test                    # backend suite (in-process Postgres)
bun run test:pg             # same suite on real Postgres 16 + Redis (bun run services:up first)
bun run test:contracts      # Foundry: unit, fuzz, invariant
bun run test:fork           # contracts against live Robinhood Chain state
bun run test:e2e            # anvil + every contract deployed + router
bun run typecheck
```

## Contributing: publish guard

`bun install` points git at `.githooks/`, which blocks commits and pushes that carry the wrong author
identity, a non-UTC timestamp, secrets (provider/GitHub/AWS tokens, PEM keys, unlisted 32-byte hex),
local-only files (`.env*`, `.data/`, key files, and any path pattern in your local `.git/info/publish-denypaths`)
or any string in your local `.git/info/publish-denylist`. Both lists live under `.git/info/`, which is never pushed.

- **Identity.** Set it once per clone: `git config anyroute.allowedEmail <email>`, or accept a set of addresses
  with `git config anyroute.allowedEmailPattern '<extended regex>'` (matched against the whole email; the
  `ANYROUTE_ALLOWED_EMAIL_RE` environment variable overrides it). Empty names and machine-derived emails
  (`(none)`, `*.local`, `*.lan`, `localhost`) are always refused.
- **UTC only.** A commit's author and committer dates carry your UTC offset, so both must be `+0000`. Run
  `export TZ=UTC` in your shell (or `alias git='TZ=UTC git'`) before committing. To fix commits already made:
  `git commit --amend --reset-author --no-edit` (last one) or `git rebase --reset-author-date <base>`.
- **CI.** Local hooks can be skipped with `--no-verify`, so `.github/workflows/publish-guard.yml` runs the same
  checks on every push and pull request. It accepts `contributor@anyroute.invalid` and GitHub noreply addresses
  (`<id>+<user>@users.noreply.github.com`, `noreply@github.com`); commits with any other identity or a non-UTC
  date fail the check.
