# Integrations

Ready-to-submit listings of Anyroute in the tools people already use. Each folder has a README with the exact steps to use it today and to submit it. **Nothing here has been published or submitted yet.**

| Folder | Where it lists Anyroute | What is in it | Works today without submitting |
| --- | --- | --- | --- |
| [`litellm/`](litellm/) | LiteLLM (proxy and SDK) | cost-map entries for 358 models, provider registration, sample `config.yaml` | yes, via `config.yaml` |
| [`vercel-ai-sdk/`](vercel-ai-sdk/) | Vercel AI SDK community providers | `@anyroute/ai-sdk-provider` package (receipt and cost in `providerMetadata`, attested lane option) | after `npm publish` |
| [`sillytavern/`](sillytavern/) | SillyTavern "Custom (OpenAI-compatible)" | connection recipe, importable preset | yes |
| [`mcp-registry/`](mcp-registry/) | Official MCP Registry | `server.json` for `io.github.AnyRouteRH/anyroute` (the existing `/mcp` server, including `anyroute_agent_rules` and `anyroute_agent_check`) | yes, via `claude mcp add` |
| [`x402-bazaar/`](x402-bazaar/) | x402 Bazaar discovery | v1 and v2 (`extensions.bazaar`) discovery items for chat, completions, embeddings; tags `attested`, `tee`, `uncensored-ok` | not yet: x402 is built but not switched on at anyroute.tech; it turns on when `X402_PAY_TO` is set |
| [`elizaos/`](elizaos/) | ElizaOS plugin registry | `@anyroute/plugin-anyroute` model provider (text, embeddings, attested lane) | after `npm publish` |
| [`huggingface/`](huggingface/) | Hugging Face model cards | badge and "Run it on Anyroute" snippet | yes, per model-card PR |
| [`dune/`](dune/) | Dune | DuneSQL query that recomputes the commerce ledger (`/commerce`) from public chain data | yes, once the router's addresses are filled in, where Dune indexes Robinhood Chain |

Use `https://anyroute.tech/api/v1` for inference and `https://anyroute.tech/mcp` for MCP. Before submitting a listing, review its endpoint and publication status. The client SDK code is in `packages/client` and `packages/client-py`; npm and PyPI releases are not published yet.

## Regenerate from the live catalogue

```sh
bun scripts/gen-integrations.ts
```

Rewrites `litellm/` from `GET /api/v1/models` (public, no key). The catalogue generator has validation in the repository.

The two TypeScript packages have their own `package.json` and are not part of the router's build or typecheck:

```sh
cd integrations/vercel-ai-sdk && bun install && bun run typecheck
cd integrations/elizaos && bun install && bun run typecheck
```

Both packages are Apache-2.0, like the client SDK in `packages/client`.

The official SDKs (TypeScript, Python, Go) and the LangChain and LlamaIndex packages live in [`sdks/`](../sdks/).
