import PageFrame from "../../components/PageFrame";
import { Button, Code } from "../../components/UI";
import { sampleRequest } from "../../components/Extensions";
import { API_BASE } from "../../lib/api";
export const metadata = { title: "Developer documentation — Anyroute" };
const receipt = {
  id: "gen-1790461071-M1D5SJxd7YpD5A",
  model: "meta-llama/llama-3.3-70b-instruct",
  provider: "DeepInfra",
  choices: [{ message: { role: "assistant", content: "…" }, finish_reason: "stop" }],
  usage: {
    prompt_tokens: 120,
    completion_tokens: 64,
    total_tokens: 184,
    cost: 0.00003248,
    is_byok: false,
    cost_details: { upstream_inference_cost: 0.00003248, royalty: 0, margin: 0 },
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  },
  receipt: {
    id: "gen-1790461071-M1D5SJxd7YpD5A",
    sig: "<base64 Ed25519 signature>",
    key_id: "ab214b090f5922fe",
    alg: "Ed25519",
    payload: { v: 1, model: "…", provider: "…", tokens: { prompt: 120, completion: 64 }, cost: "0.00003248", mode: "prepaid", request_sha256: "…", response_sha256: "…" },
    anchor_hint: "Anchored on chain 4663 within the hour; GET /api/v1/generation?id=… returns the merkle proof.",
    paid_with: { token: "NVDA", raw_units: "<units>", fair_price: "<18-decimal USD>", swap_tx: "<tx once swapped>" },
  },
};
const BASE = API_BASE || "<your router>";
const claudeCode = `claude mcp add --transport http anyroute ${BASE}/mcp --header "Authorization: Bearer $ANYROUTE_API_KEY"`;
const cursorConfig = JSON.stringify({ mcpServers: { anyroute: { url: `${BASE}/mcp`, headers: { Authorization: "Bearer sk-ar-v1-…" } } } }, null, 2);
const desktopConfig = JSON.stringify(
  { mcpServers: { anyroute: { command: "npx", args: ["-y", "mcp-remote", `${BASE}/mcp`, "--header", "Authorization:${ANYROUTE_AUTH}"], env: { ANYROUTE_AUTH: "Bearer sk-ar-v1-…" } } } },
  null,
  2,
);
const mcpCurl = `curl -s ${BASE}/mcp \\
  -H "content-type: application/json" \\
  -H "accept: application/json, text/event-stream" \\
  -H "Authorization: Bearer $ANYROUTE_API_KEY" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'`;
const x402Example = `import { privateKeyToAccount } from "viem/accounts";
import { toHex } from "viem";

const account = privateKeyToAccount(process.env.AGENT_KEY);
const url = "https://<router>/api/v1/chat/completions";
const headers = { "content-type": "application/json" };
const body = JSON.stringify({ model: "meta-llama/llama-3.3-70b-instruct", messages: [{ role: "user", content: "Hello" }] });

// 1. Ask with no key. The router answers 402 with x402 payment requirements.
const { accepts } = await (await fetch(url, { method: "POST", headers, body })).json();
const req = accepts[0];

// 2. Sign a USDG transfer authorization (EIP-3009) to req.payTo. The router relays it and pays the gas.
const authorization = {
  from: account.address,
  to: req.payTo,
  value: BigInt(req.maxAmountRequired),
  validAfter: 0n,
  validBefore: BigInt(Math.floor(Date.now() / 1000) + req.maxTimeoutSeconds),
  nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
};
const signature = await account.signTypedData({
  domain: { name: req.extra.name, version: req.extra.version, chainId: req.extra.chainId, verifyingContract: req.asset },
  types: { TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ] },
  primaryType: "TransferWithAuthorization",
  message: authorization,
});
const xPayment = btoa(JSON.stringify({
  x402Version: 1, scheme: "exact", network: req.network,
  payload: { signature, authorization: Object.fromEntries(Object.entries(authorization).map(([k, v]) => [k, String(v)])) },
}));

// 3. Retry the identical request with X-PAYMENT.
const paid = await fetch(url, { method: "POST", headers: { ...headers, "X-PAYMENT": xPayment }, body });
const completion = await paid.json(); // usage + signed receipt; receipt.payload.payment_tx is the settlement
const settlement = JSON.parse(atob(paid.headers.get("X-PAYMENT-RESPONSE"))); // { success, transaction, network, payer }`;
const endpoints = [
  ["POST /api/v1/chat/completions", "Chat, tools and streaming (OpenAI/OpenRouter shape); X-Pay-With, X-Payment, X-Wallet-Auth headers"],
  ["POST /api/v1/completions · /embeddings", "Legacy completions; embeddings (prepaid keys)"],
  ["GET /api/v1/models · /models/:author/:slug/endpoints", "Catalog, prices, policies, quantization, attestation; per-provider health"],
  ["GET /api/v1/generation?id=… · /generations", "Full generation record with receipt and anchor proof; your recent generations"],
  ["POST · GET · PATCH · DELETE /api/v1/keys", "Create a self-custodial key (no auth), or budgeted sub-keys with rpm/tpm, model allowlists, guardrails"],
  ["GET /api/v1/key · /credits", "Current key; balance, held and total usage"],
  ["POST /api/v1/credits/deposit-tx · /withdraw-request", "Unsigned wallet transactions to deposit, or a key-signed withdrawal request"],
  ["GET /api/v1/credits/withdrawal-proof", "Merkle proof and calldata to finalize a withdrawal"],
  ["POST /api/v1/paywith/open · /close · /revoke · GET /session · /statement", "Stock Token sessions and monthly statements"],
  ["POST /api/v1/paywith/allowance/typed-data · /allowance · GET /charges · POST /charges/{id}/signature", "Wallet authorizations: a bounded allowance, or a signature per charge"],
  ["POST /api/v1/byok · /teams", "Bring your own provider key; team roles"],
  ["GET · POST · PATCH · DELETE /api/v1/routes", "Saved Routes: named routing policies you call as model \"@route/<slug>\""],
  ["POST · GET · DELETE /api/v1/sessions · GET /sessions/current", "Agent Sessions: short-lived, budget-capped keys for agent runs"],
  ["GET /api/v1/spend · /spend/alerts", "Spend Watch: totals, projection, breakdowns, key budgets and alert rules"],
  ["GET /api/v1/disclosure/:providerId", "A provider’s documented retention, jurisdiction, legal hold and training use, each with a source and date, and the class it is served under now"],
  ["GET /api/v1/holder", "$ANYR holders: balance, live tier (higher rate limits, lower fees), the tier ladder and free credits received"],
  ["POST /api/v1/receipts/verify · GET /receipts/keys", "Verify a receipt’s signature and anchor inclusion; signing keys (JWKS)"],
  ["POST /mcp", "AnyRoute MCP: list_models, chat, get_receipt and verify_receipt as tools for Claude, Cursor or any MCP client"],
  ["GET /api/v1/rankings · /providers · /status", "Usage rankings and creator payouts; provider registry; router configuration"],
  ["POST /api/v1/providers/apply · /creators/claim · /paymaster", "Provider onboarding; royalty claims; ERC-7677 gas sponsorship"],
];
export default function Docs() {
  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <span className="eyebrow">DEVELOPER DOCS / API V1</span>
          <h1>
            Change the route.
            <br />
            Keep the request.
          </h1>
          <p>Route calls to any model, pay in USDG or with a Stock Token, and verify every receipt.</p>
        </div>
        <div className="side-layout">
          <nav className="side-nav" aria-label="Documentation sections" data-reveal="fade">
            <span className="side-nav-label">On this page</span>
            <a href="#quickstart">Quickstart</a>
            <a href="#routing">Routing</a>
            <a href="#disclosure">Disclosure</a>
            <a href="#payments">Payments</a>
            <a href="#x402">x402</a>
            <a href="#receipts">Receipts</a>
            <a href="#mcp">MCP</a>
            <a href="#endpoints">Endpoints</a>
            <a href="#limits">Limits</a>
          </nav>
        <article className="page-body prose">
          <div className="note" data-reveal>
            The router serves this site, so your base URL is this site’s address followed by /api/v1. Create a key in the dashboard, deposit USDG to it and call it from any OpenAI- or OpenRouter-compatible client.
          </div>
          <h2 id="quickstart">Two changes to get started.</h2>
          <p>
            Anyroute accepts the familiar chat-completions request. Replace the base URL and key; requests, streaming, tools, provider preferences and usage fields work unchanged. Keys are self-custodial: POST /api/v1/keys (no account) returns a key and the hash to deposit USDG to.
          </p>
          <Code>{sampleRequest}</Code>
          <h2 id="routing">Make the route explicit.</h2>
          <p>
            The provider object supports order, allow_fallbacks, only, ignore, data_collection, zdr, quantizations, sort, max_price, require_parameters and preferred latency or throughput. Model suffixes :nitro, :floor, :free and :private work
            too. models[] lists fallback models. The private flag is an Anyroute extension: it selects only providers with a fresh TEE attestation. By default providers are weighted by 1/price² × 30-day uptime × canary quality, and a
            provider with two failures in 30 seconds is skipped.
          </p>
          <Code label="Routing preferences">
            {JSON.stringify(
              {
                model: "meta-llama/llama-3.3-70b-instruct",
                models: ["qwen/qwen3-32b"],
                messages: [{ role: "user", content: "Your prompt" }],
                provider: { allow_fallbacks: true, data_collection: "deny", sort: "latency", private: true },
              },
              null,
              2,
            )}
          </Code>
          <h2 id="disclosure">Route by what a provider discloses.</h2>
          <p>
            Each provider has a disclosure profile its operator documents: retention (attested, policy or logs), jurisdiction, legal-hold status and training use, each with a source and a date. Anything undocumented reads as the conservative
            default (logs, unknown). GET /api/v1/disclosure/:providerId returns the profile and the class the provider is served under right now. It reports what was documented and, for attested, what the router verified; it is not a guarantee of a
            provider’s behaviour.
          </p>
          <p>
            Set provider.disclosure (or the X-Anyroute-Disclosure-Max header) to none, policy or any, the default. none routes only to providers whose retention is declared attested and whose TEE attestation is fresh; policy also accepts a
            documented no-retention policy with no legal hold. provider.lane (or X-Anyroute-Lane) is public, the default, or attested, which implies none; if both are set the stricter applies. When nothing qualifies the request fails with 409, or
            503 when qualifying providers are down. It is never sent to a provider that does not qualify, and nothing is charged. The unlinkable lane is not available yet and returns 501. A request with a disclosure setting never uses the response cache.
          </p>
          <p>
            Responses carry X-Anyroute-Disclosure (attested, policy or vendor-forwarded) and X-Anyroute-Lane, and the signed receipt records disclosure and lane. On a stream the header is sent only when every reachable provider shares one class; the
            receipt always states it. A development attestation is marked attestation_simulated and is refused in production. GET /api/v1/models?lane=attested lists the models that have an attested endpoint now.
          </p>
          <Code label="Attested providers only">
            {JSON.stringify(
              {
                model: "meta-llama/llama-3.3-70b-instruct",
                messages: [{ role: "user", content: "Your prompt" }],
                provider: { disclosure: "none" },
              },
              null,
              2,
            )}
          </Code>
          <h2 id="payments">One settlement unit. More ways to pay.</h2>
          <div className="table-wrap">
            <table className="docs-table">
              <thead>
                <tr>
                  <th>Route</th>
                  <th>Behavior</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Prepaid USDG</td>
                  <td>Deposit to your key’s hash on the Credits contract. 0% router fee. Withdraw any time with your key’s signature.</td>
                </tr>
                <tr>
                  <td>Agent per-call</td>
                  <td>No key: the router answers 402 with a quote. Pay with CallPay (gas can be sponsored) or sign a gasless USDG authorization (see x402 below), then retry with X-Payment. 1% margin, including gas.</td>
                </tr>
                <tr>
                  <td>Stock Token</td>
                  <td>A wallet-capped session. Calls accrue in USDG; at $1 or 24 hours the router swaps exactly what is owed at the Chainlink fair value and records the token units on each receipt. Every swap carries the wallet’s EIP-712 signature (a bounded allowance or the charge itself) naming the receipts it pays.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="note">
            Providers are paid their list price minus a 2% settlement fee; creator royalties appear as a separate cost line. Stock Token swaps are slippage-bounded and never exceed your daily cap. Prices are per token and come from each
            provider.
          </p>
          <h2 id="x402">x402: pay per call with no account.</h2>
          <p>
            Where the router has x402 enabled, any x402 client or agent can pay for a call in USDG on Robinhood Chain (chain id 4663) with no account and no API key. Send the request without credentials: the 402 response is an x402 v1 body
            (x402Version, error, accepts) with one exact-scheme requirement. Sign the USDG authorization it describes, retry the identical request with an X-PAYMENT header, and the router verifies the signature, amount, recipient, time
            window and nonce, relays the transfer (it pays the gas) and serves the call. Chat, completions and embeddings all work this way; GET /api/v1/status reports per_call.x402.configured.
          </p>
          <ul>
            <li>
              <b>Requirement.</b> scheme exact, asset USDG, payTo the router’s receiving address, maxAmountRequired in USDG base units (6 decimals) from the same per-call price as the CallPay quote (worst case for this request, including the 1% margin), and extra
              carrying USDG’s EIP-712 name and version plus the numeric chainId.
            </li>
            <li>
              <b>Network name.</b> x402 v1 names chains with lowercase hyphenated strings and has no Robinhood Chain entry, so the requirement says robinhood-chain (and the router also accepts the CAIP-2 name eip155:4663 in the payment). A client that
              only knows built-in networks needs that name mapped to chain 4663, or a v2 client with an eip155 handler.
            </li>
            <li>
              <b>Response.</b> The paid response carries X-PAYMENT-RESPONSE (base64 JSON with success, transaction, network and payer) and the signed receipt records the same transaction as payment_tx.
            </li>
            <li>
              <b>Change.</b> The whole payment is credited to the paying wallet’s account and the call is charged from it, so anything unused stays there as credit you can spend with X-Wallet-Auth. Paying more than maxAmountRequired is allowed; nothing is refunded on-chain.
            </li>
            <li>
              <b>Rejections.</b> A payment that fails verification gets a 402 whose error is a reason such as invalid_exact_evm_payload_authorization_value (underpaid), invalid_exact_evm_payload_recipient_mismatch, invalid_exact_evm_payload_authorization_nonce_used
              (replayed) or invalid_exact_evm_payload_signature, together with fresh requirements. Nothing moves on-chain for a rejected payment.
            </li>
          </ul>
          <Code label="x402 client (JavaScript, viem)">{x402Example}</Code>
          <h2 id="receipts">The response is only the beginning.</h2>
          <p>
            Every generation returns normalized usage and an Ed25519-signed receipt with hashes of the request and response (never their content). Receipts are anchored in hourly merkle batches on Robinhood Chain, and the signing keys
            are published on-chain. Signed is not the same as anchored: the dashboard and /api/v1/receipts/verify report each separately.
          </p>
          <Code label="Response shape">{JSON.stringify(receipt, null, 2)}</Code>
          <h2 id="mcp">Use every model as a tool.</h2>
          <p>
            The router hosts a remote MCP server at /mcp (Streamable HTTP, stateless, JSON replies). Connect it to Claude, Cursor or any MCP client with your Anyroute key. Four tools: list_models (live models, context length and price per 1M
            tokens), chat (call any model; returns the reply, a receipt id, cost and latency), get_receipt and verify_receipt. Chat goes through /api/v1/chat/completions with your key, so balance, limits and signed receipts are the same.
            Only chat needs a key.
          </p>
          <Code label="Claude Code">{claudeCode}</Code>
          <Code label="Cursor · ~/.cursor/mcp.json">{cursorConfig}</Code>
          <Code label="Claude Desktop · claude_desktop_config.json (through the mcp-remote bridge)">{desktopConfig}</Code>
          <Code label="Check it with curl">{mcpCurl}</Code>
          <h2 id="endpoints">Endpoint map</h2>
          <div className="table-wrap">
            <table className="docs-table endpoint-table">
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>Purpose</th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map(([a, b]) => (
                  <tr key={a}>
                    <td className="mono">{a}</td>
                    <td>{b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2 id="limits">Limits and guarantees.</h2>
          <p>
            Each call holds its worst-case cost before routing and settles the metered usage after, so a key never goes past its balance or budget. Keys have a per-minute request limit, and optional token-per-minute limits; n and best_of are capped at 16. If every
            provider fails, nothing is charged. A cancelled stream is billed only for what was generated.
          </p>
          <p>
            The router stores key hashes, balances and receipt metadata. It never stores prompts or responses; the optional response cache is encrypted, per-workspace and expires. Provider data policies are listed per provider.
          </p>
          <h3>Primary references</h3>
          <p>
            <a href="https://openrouter.ai/docs/quickstart" target="_blank" rel="noreferrer" className="inline-link">
              OpenRouter’s official API documentation
            </a>{" "}
            describes the request shape Anyroute is compatible with.{" "}
            <a href="https://docs.robinhood.com/chain/" target="_blank" rel="noreferrer" className="inline-link">
              Robinhood Chain’s official documentation
            </a>{" "}
            describes the network. Neither reference implies a partnership.
          </p>
          <div className="page-end">
            <Button href="/dashboard/">Open the dashboard</Button>
            <Button href="/openapi.json" secondary download>
              Download OpenAPI
            </Button>
          </div>
        </article>
        </div>
      </main>
    </PageFrame>
  );
}
