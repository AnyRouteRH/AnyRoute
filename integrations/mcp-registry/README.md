# MCP Registry

`server.json` lists Anyroute's existing remote MCP server (`POST /mcp`, Streamable HTTP) in the official [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.AnyRouteRH/anyroute`. Clients that read the registry (and the directories that mirror it) can then find and add it.

The server has eight tools: `list_models`, `list_attested_models`, `chat` (optionally on the attested lane), `verify_provider`, `get_receipt`, `verify_receipt`, `anyroute_agent_rules` and `anyroute_agent_check`. `chat` and both agent tools need an API key.

`anyroute_agent_rules` reads the calling key’s own and inherited rulebooks, remaining caps and kill state. `anyroute_agent_check` evaluates an intent without sending a prompt, reserving budget or recording a policy event. Check before expensive calls; never retry a denial unchanged. A later call is evaluated again. These rules are enforced by the router for requests through Anyroute only. `AGENT_POLICY_ENABLED` defaults to false for self-hosters; switched on at anyroute.tech. Ordinary chat exposes text to router memory; the separate encrypted-chat adapter forwards ciphertext.

`server.json` validates against the registry schema it names (`2025-12-11`). Nothing is published yet.

## Publish

Needs a GitHub account that is a member of the `AnyRouteRH` org (the `io.github.AnyRouteRH/` namespace is proven by GitHub login).

```sh
brew install mcp-publisher        # or download a release from github.com/modelcontextprotocol/registry
cd integrations/mcp-registry
mcp-publisher login github        # device-code login in the browser
mcp-publisher publish             # reads ./server.json
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.AnyRouteRH/anyroute"
```

For each later change, bump `version` (the registry rejects a republish of the same version).

## Before publishing, check

- Before publication, set `remotes[0].url` to `https://anyroute.tech/mcp` and `websiteUrl` to `https://anyroute.tech`, and bump `version`.
- To publish under a domain name instead of the GitHub org, use `mcp-publisher login dns --domain <domain> --private-key <ed25519 key>` after adding the TXT record it asks for, and change `name` to the reversed domain (`<tld>.<name>/anyroute`).

## Add it by hand today

```sh
claude mcp add --transport http anyroute https://anyroute.tech/mcp --header "Authorization: Bearer $ANYROUTE_API_KEY"
```
