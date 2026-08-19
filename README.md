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
