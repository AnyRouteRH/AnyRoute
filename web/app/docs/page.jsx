import PageFrame from "../../components/PageFrame";
import { Button, Code } from "../../components/UI";
import { sampleRequest } from "../../components/Extensions";
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
const endpoints = [
  ["POST /api/v1/chat/completions", "Chat, tools and streaming (OpenAI/OpenRouter shape); X-Pay-With, X-Payment, X-Wallet-Auth headers"],
  ["POST /api/v1/completions · /embeddings", "Legacy completions; embeddings (prepaid keys)"],
  ["GET /api/v1/models · /models/:author/:slug/endpoints", "Catalog, prices, policies, quantization, attestation; per-provider health"],
  ["GET /api/v1/generation?id=… · /generations", "Full generation record with receipt and anchor proof; your recent generations"],
  ["POST · GET · PATCH · DELETE /api/v1/keys", "Create a self-custodial key (no auth), or budgeted sub-keys with rpm/tpm, model allowlists, guardrails"],
  ["GET /api/v1/key · /credits", "Current key; balance, held and total usage"],
  ["POST /api/v1/credits/deposit-tx · /withdraw-request", "Unsigned wallet transactions to deposit, or a key-signed withdrawal request"],
  ["GET /api/v1/credits/withdrawal-proof", "Merkle proof and calldata to finalize a withdrawal"],
  ["POST /api/v1/paywith/open · /close · GET /session · /statement", "Stock Token sessions and monthly statements"],
  ["POST /api/v1/byok · /teams", "Bring your own provider key; team roles"],
  ["POST /api/v1/receipts/verify · GET /receipts/keys", "Verify a receipt’s signature and anchor inclusion; signing keys (JWKS)"],
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
            <a href="#payments">Payments</a>
            <a href="#receipts">Receipts</a>
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
                  <td>No key: the router answers 402 with a quote. Pay with CallPay (gas can be sponsored) or sign a gasless USDG authorization, then retry with X-Payment. 1% margin, including gas.</td>
                </tr>
                <tr>
                  <td>Stock Token</td>
                  <td>A wallet-capped session. Calls accrue in USDG; at $1 or 24 hours the router swaps exactly what is owed at the Chainlink fair value and records the token units on each receipt.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="note">
            Providers are paid their list price minus a 2% settlement fee; creator royalties appear as a separate cost line. Stock Token swaps are slippage-bounded and never exceed your daily cap. Prices are per token and come from each
            provider.
          </p>
          <h2 id="receipts">The response is only the beginning.</h2>
          <p>
            Every generation returns normalized usage and an Ed25519-signed receipt with hashes of the request and response (never their content). Receipts are anchored in hourly merkle batches on Robinhood Chain, and the signing keys
            are published on-chain. Signed is not the same as anchored: the dashboard and /api/v1/receipts/verify report each separately.
          </p>
          <Code label="Response shape">{JSON.stringify(receipt, null, 2)}</Code>
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
