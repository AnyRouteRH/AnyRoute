# x402 Bazaar

`discovery.json` describes Anyroute's pay-per-call endpoints in the x402 Bazaar discovery shape, so agents browsing an x402 index can find them and pay per request with no account and no key:

| Resource | Pays for |
| --- | --- |
| `POST /api/v1/chat/completions` | a chat completion on any catalogue model |
| `POST /api/v1/completions` | a text completion |
| `POST /api/v1/embeddings` | embeddings |

Each item is a v1 discovery resource: `resource`, `type: "http"`, `x402Version: 1`, and the `accepts` requirement the router itself sends in its 402 reply (`exact` scheme, USDG on Robinhood Chain, chain id 4663, EIP-3009 `TransferWithAuthorization`), plus `outputSchema` (the request body fields and response) and `metadata` with the tags `attested`, `tee`, `uncensored-ok` and a price hint.

Prices are per request. `maxAmountRequired` here is the router's per-call ceiling (25 USDG, 6 decimals); the 402 reply quotes the exact amount for the request: the model's per-token price times its prompt and `max_tokens`, plus the 1% per-call margin. Unused value stays as change on the payer's wallet account.

## Status: not live yet

- The live router does not accept x402 today. `GET /api/v1/status` shows `per_call.x402.configured: false`, and a keyless call answers 401. x402 turns on when `X402_PAY_TO` is set on the api service (the router role must hold gas to relay the authorization).
- `payTo` is left as `<X402_PAY_TO>`. Fill it with the same address before submitting.

## Submit (not done yet)

1. Set `X402_PAY_TO` on the router, redeploy, and check a keyless `POST /api/v1/chat/completions` answers 402 with an `accepts` entry matching this file.
2. Replace `<X402_PAY_TO>` in `discovery.json`.
3. Bazaar indexes resources that a discovery-enabled facilitator settles. Anyroute verifies and relays payments itself on Robinhood Chain, which the public facilitators do not list, so submit `discovery.json` to the index directly (Agentic.Market or the Bazaar maintainers) rather than waiting for a first settlement to auto-index it.
4. For x402 v2 indexes: the network is `eip155:4663` (the router accepts it), and the same `outputSchema` and `metadata` go under `extensions.bazaar`.
