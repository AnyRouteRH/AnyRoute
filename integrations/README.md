# Integrations

Ready-to-submit listings of Anyroute in the tools people already use. Each folder has a README with the exact steps to use it today and to submit it. **Nothing here has been published or submitted yet.**

| Folder | Where it lists Anyroute | What is in it | Works today without submitting |
| --- | --- | --- | --- |
| [`litellm/`](litellm/) | LiteLLM (proxy and SDK) | cost-map entries for 358 models, provider registration, sample `config.yaml` | yes, via `config.yaml` |
| [`vercel-ai-sdk/`](vercel-ai-sdk/) | Vercel AI SDK community providers | `@anyroute/ai-sdk-provider` package (receipt and cost in `providerMetadata`, attested lane option) | after `npm publish` |
| [`sillytavern/`](sillytavern/) | SillyTavern "Custom (OpenAI-compatible)" | connection recipe, importable preset | yes |
| [`mcp-registry/`](mcp-registry/) | Official MCP Registry | `server.json` for `io.github.AnyRouteRH/anyroute` (the existing `/mcp` server) | yes, via `claude mcp add` |
| [`x402-bazaar/`](x402-bazaar/) | x402 Bazaar discovery | discovery items for chat, completions, embeddings; tags `attested`, `tee`, `uncensored-ok` | no: x402 is off on the live router until `X402_PAY_TO` is set |
| [`elizaos/`](elizaos/) | ElizaOS plugin registry | `@anyroute/plugin-anyroute` model provider (text, embeddings, attested lane) | after `npm publish` |
| [`huggingface/`](huggingface/) | Hugging Face model cards | badge and "Run it on Anyroute" snippet | yes, per model-card PR |

Every listing points at the public router, `https://api-production-70da.up.railway.app/api/v1`. When a custom domain goes live, search this folder for that host and regenerate the LiteLLM files.

## Regenerate from the live catalogue

```sh
bun scripts/gen-integrations.ts
```

Rewrites `litellm/` from `GET /api/v1/models` (public, no key). Tested by `test/gen-integrations.test.ts` against a fixture.

The two TypeScript packages have their own `package.json` and are not part of the router's build or typecheck:

```sh
cd integrations/vercel-ai-sdk && bun install && bun run typecheck
cd integrations/elizaos && bun install && bun run typecheck
```

Both packages are Apache-2.0, like the client SDK in `packages/client`.
