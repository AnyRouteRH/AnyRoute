import { Code } from "./UI";

export default function ClaudeUnlinkableDocs() {
  return <>
    <h2 id="claude-unlinkable">Claude Code, unlinkable.</h2>
    <p>Claude Code can use the proxy’s Anthropic Messages API over Tor, paid with blind tokens. Start Tor on your computer, download and check <a href="#private-get" className="inline-link">private.mjs</a>, and buy tokens with a funded Anyroute key. The purchase uses the key; inference sends only tokens.</p>
    <Code label="Buy tokens and start the proxy">{`export ANYROUTE_API_KEY=sk-ar-v1-…
node private.mjs buy --count 20 --denomination 10000
node private.mjs start
# Optional: --shared-circuit reuses a Tor circuit within this proxy session.
# If the operator uses a lower token cap: --max-tokens-per-request <cap>`}</Code>
    <p>In another shell, list the currently available attested models through the proxy. Choose models with reliable tool calling and enough context for your code. Replace both model values below with ids returned by that list. The proxy discards the client’s API key, metadata and identifying headers.</p>
    <Code label="Claude Code environment">{`curl http://127.0.0.1:8788/v1/models
export ANTHROPIC_BASE_URL=http://127.0.0.1:8788
export ANTHROPIC_API_KEY=anyroute-private
unset ANTHROPIC_AUTH_TOKEN
export ANTHROPIC_MODEL='<attested model id from the list>'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='<attested model id from the list>'
export ANTHROPIC_DEFAULT_SONNET_MODEL="$ANTHROPIC_MODEL"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$ANTHROPIC_MODEL"
claude`}</Code>
    <p>POST /v1/messages streams the Messages events, tools, refusals and receipt headers from the router. POST /v1/messages/count_tokens is answered on your computer with the router’s estimator: no network call and no token payment. It is an estimate, including tool schemas and images, rather than a model tokenizer.</p>
    <p>Before inference, the proxy estimates input tokens plus max_tokens at prices fetched over Tor from GET /api/v1/models?lane=unlinkable, cached in memory for one minute, including the request fee, reasoning price and royalty. It chooses the least total face value covering that estimate, breaking ties by fewer tokens, up to 16 by default. Every selected token is spent for that one request; unused value is forfeited. A changed price or a more expensive routing candidate can cause 402 token_value_too_low without spending the set. Lower max_tokens or buy larger denominations if your available set cannot cover a call.</p>
    <p>The header extension is <code>Authorization: PrivateToken token=A, token=B</code>, with each value a base64url Privacy Pass token. Single-token headers and receipts retain their existing format. Sets verify and reserve atomically; receipts add only token_count, token_key_ids and nullifiers as payment identifiers. Those tokens become linked to one request, never to their purchase. A refusal before service releases the whole set; a lost response leaves the sent set unconfirmed on your computer.</p>
    <p>Operator configuration: ANYROUTE_FEATURE_BLIND=false, UNLINKABLE_VIA_ONION=false and BLIND_MULTI_TOKEN_ENABLED=false by default. Enable them with the existing onion ingress and attestation configuration; ONION_ADDRESS and ONION_PROXY_SECRET must be configured. BLIND_MAX_TOKENS_PER_REQUEST defaults to 16 (allowed range 1–64). BLIND_UNIT_PRICE_USD defaults to 0.000002 per unit; denominations are 1000, 10000 and 100000. Tor onion access and blind tokens are switched on at anyroute.tech. Downloading the proxy changes no operator configuration.</p>
    <p>Tor adds latency, and its first connection can take a minute. Each call uses a fresh SOCKS identity by default; --shared-circuit reuses one for this proxy process, which can reduce setup latency and makes calls share a network circuit. Claude Code’s effectiveness depends on the selected open model and its tool support.</p>
    <div className="note">The router reads your code and prompts in memory on this lane, and the attested provider receives them. This path hides who sent and paid for a request, not what it asks. Identifying code, file paths or text can still identify you; timing and request size can correlate calls, especially immediately after a purchase. Tor cannot prevent an observer of both ends from correlating traffic.</div>
  </>;
}
