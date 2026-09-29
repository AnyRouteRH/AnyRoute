import PageFrame from "../../components/PageFrame";
import { Button, Code } from "../../components/UI";
import { sampleRequest } from "../../components/Extensions";
import { API_BASE } from "../../lib/api";
import { QUICKSTART, QUICKSTART_FLAGS } from "../../lib/providers";
import OnionAddress from "../../components/OnionAddress";
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
const councilRequest = JSON.stringify(
  {
    model: "anyroute/council",
    messages: [{ role: "user", content: "Your prompt" }],
    max_tokens: 400,
    council: { models: ["<model-a>", "<model-b>", "<model-c>"], judge: "<judge-model>", mode: "judge", max_cost_usd: 0.05 },
  },
  null,
  2,
);
const councilResponse = JSON.stringify(
  {
    id: "<judge receipt id>",
    model: "anyroute/council",
    choices: [{ message: { role: "assistant", content: "<the chosen member's answer>" } }],
    usage: { prompt_tokens: 1180, completion_tokens: 402, cost: 0.0021, calls: 4 },
    receipt: { id: "<judge receipt id>", sig: "…", payload: { council: { members: [{ receipt_id: "<member receipt id>" }], judge: { receipt_id: "<judge receipt id>" } } } },
    council: {
      mode: "judge",
      members: [{ label: "A", model: "<model-a>", provider: "…", receipt_id: "<member receipt id>", cost: "0.00041", latency_ms: 812, status: "ok" }],
      judge: { model: "<judge-model>", receipt_id: "<judge receipt id>", cost: "0.00062", latency_ms: 390 },
      selected: { label: "A", receipt_id: "<member receipt id>" },
      total_cost: "0.0021",
    },
  },
  null,
  2,
);
const verifyRequest = JSON.stringify({ model: "meta-llama/llama-3.3-70b-instruct", messages: [{ role: "user", content: "Your prompt" }], verify: "dual" }, null, 2);
const attestedCouncilRequest = JSON.stringify(
  {
    model: "anyroute/council",
    messages: [{ role: "user", content: "Your prompt" }],
    council: { models: ["<model-a>", "<model-b>"], judge: "<judge-model>", attested: true },
  },
  null,
  2,
);
const attestedCouncilResponse = JSON.stringify(
  {
    id: "<judge receipt id>",
    model: "anyroute/council",
    council: {
      attested: true,
      attestation_refs: [
        { role: "member", label: "A", receipt_id: "<member receipt id>", provider: "<provider-a>", tee: "tdx", report_hash: "<attestation report hash>", attested_at: "…", tls_pin: { spki_sha256: "…", attestation_ref: "…" } },
        { role: "member", label: "B", receipt_id: "<member receipt id>", provider: "<provider-b>", tee: "tdx", report_hash: "…", attested_at: "…", tls_pin: null },
        { role: "judge", receipt_id: "<judge receipt id>", provider: "<provider-a>", tee: "tdx", report_hash: "…", attested_at: "…", tls_pin: { spki_sha256: "…", attestation_ref: "…" } },
      ],
    },
  },
  null,
  2,
);
const attestedDualRequest = JSON.stringify({ model: "<model>", messages: [{ role: "user", content: "Your prompt" }], verify: "dual", provider: { lane: "attested" } }, null, 2);
const claimRequest = JSON.stringify({ model: "<author>/<model>", address: "0x…your payout address" }, null, 2);
const claimResponse = JSON.stringify(
  {
    data: {
      id: "claim-…",
      model: "<author>/<model>",
      hugging_face_id: "<owner>/<repository>",
      handle: "<owner>",
      status: "pending",
      file: "anyroute-claim.txt",
      file_content: "anyroute-claim-…\n",
      expires_at: "2026-…",
      royalty_bps: 500,
    },
  },
  null,
  2,
);
const BASE = API_BASE || "<your router>";
const torCurl = `curl --socks5-hostname 127.0.0.1:9050 http://<onion address>/api/v1/models

# a call with your key, the same request as on the clearnet
curl --socks5-hostname 127.0.0.1:9050 http://<onion address>/api/v1/chat/completions \\
  -H "Authorization: Bearer $ANYROUTE_API_KEY" -H "Content-Type: application/json" \\
  -d '{"model":"meta-llama/llama-3.3-70b-instruct","messages":[{"role":"user","content":"Hello"}]}'`;
const claudeCode = `claude mcp add --transport http anyroute ${BASE}/mcp --header "Authorization: Bearer $ANYROUTE_API_KEY"`;
const claudeCodeAttested = `claude mcp add --transport http anyroute-attested "${BASE}/mcp?lane=attested" --header "Authorization: Bearer $ANYROUTE_API_KEY"

# the same restriction as a header instead of a URL query
claude mcp add --transport http anyroute-attested ${BASE}/mcp --header "Authorization: Bearer $ANYROUTE_API_KEY" --header "X-Anyroute-Lane: attested"`;
const mcpAttestedCall = JSON.stringify(
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "chat", arguments: { model: "<model from list_attested_models>", prompt: "Your prompt", lane: "attested" } } },
  null,
  2,
);
const mcpAttestedResult = JSON.stringify(
  {
    text: "…",
    receipt_id: "gen-…",
    lane: "attested",
    disclosure: "attested",
    upstream_attestation: { attested: true, gpu_attested: true, receipt_verified: true, kind: "aci/1", receipt_id: "<gateway receipt id>" },
    "…": "cost_usd, latency_ms, model, provider, usage",
  },
  null,
  2,
);
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
const responseHeaders = `X-Receipt-Id: gen-1790461071-M1D5SJxd7YpD5A
Inference-Id: gen-1790461071-M1D5SJxd7YpD5A
X-Anyroute-Lane: attested
X-Anyroute-Policy-Hash: sha256:<64 hex, only when the endpoint attested one>`;

const modelAttestation = `"attestation": {
  "best": "attested",
  "manifest_ref": { "rekor_entry": "<log entry uuid>", "registry_tx": null },
  "exec_profile_id": null,
  "policy_hash": "sha256:<64 hex>"
},
"datacenter_region": null`;

const sdkReceipt = `import { AnyRoute } from "@anyroute/client";

const client = new AnyRoute({ baseUrl: "https://<router>", apiKey: process.env.ANYROUTE_API_KEY });
const res = await client.chat.completions.create(
  { model: "meta-llama/llama-3.3-70b-instruct", messages: [{ role: "user", content: "Hello" }] },
  { disclosure: "policy" }, // or lane: "attested"; the router refuses rather than downgrade
);

const check = res.anyroute.receiptVerification; // checked against /.well-known/anyroute-receipt-keys.json
console.log(check.valid, check.anchor);          // anchor: "proof_valid" | "proof_invalid" | "no_proof"
for (const c of check.checks) console.log(c.id, c.status, c.detail); // pass | fail | not_checked`;
const sdkAttested = `import { AnyRoute, AttestationRefused } from "@anyroute/client";
import { nodeAttestFetcher } from "@anyroute/client/node"; // Node and Bun: reads the provider's certificate too

try {
  const res = await client.chat.completions.create(request, {
    attested: {
      providerId: "<provider id>",
      attestUrl: "https://<provider>/attest",
      expected: { modelDigest: "sha256:<the digest you expect>" }, // optional, but this is what makes it your model
      attestFetcher: nodeAttestFetcher(),
    },
  });
  console.log(res.anyroute.provider.bound.modelDigest, res.anyroute.servedByVerifiedProvider);
} catch (e) {
  if (e instanceof AttestationRefused) console.error(e.verification.checks.filter((c) => c.status === "fail"));
  else throw e;
}`;
const sdkPython = `from anyroute_client import AnyRoute, AttestedOptions, AttestationRefused, ExpectedDigests

client = AnyRoute("https://<router>", "sk-ar-v1-…")
try:
    res = client.chat(
        {"model": "meta-llama/llama-3.3-70b-instruct", "messages": [{"role": "user", "content": "Hello"}]},
        attested=AttestedOptions(
            provider_id="<provider id>",
            attest_url="https://<provider>/attest",
            expected=ExpectedDigests(model_digest="sha256:<the digest you expect>"),
        ),
    )
    print(res["anyroute"]["receipt_verification"].valid)
except AttestationRefused as e:
    print([c for c in e.verification.checks if c.status == "fail"])`;
const badgeScript = `<script src="https://<router>/badge.js" data-endpoint="<provider id or model id>"
        data-theme="light" async></script>`;
const badgeImg = `<img src="https://<router>/api/v1/badge/<provider id>.svg" alt="Anyroute attestation status" height="48">

<!-- Markdown, for a README or a model card -->
[![Anyroute attestation status](https://<router>/api/v1/badge/<author>/<model>.svg)](https://<router>/registry/)`;

const endpoints = [
  ["POST /api/v1/chat/completions", "Chat, tools and streaming (OpenAI/OpenRouter shape); X-Pay-With, X-Payment, X-Wallet-Auth headers"],
  ["POST /api/v1/completions · /embeddings", "Legacy completions; embeddings (prepaid keys)"],
  ["GET /api/v1/models · /models/:author/:slug/endpoints", "Catalog, prices, policies, quantization, attestation (best class, manifest reference, policy hash) and datacenter region; per-provider health and attested policy hash"],
  ["GET /api/v1/generation?id=… · /generations", "Full generation record with receipt and anchor proof; your recent generations"],
  ["POST · GET · PATCH · DELETE /api/v1/keys", "Create a self-custodial key (no auth), or budgeted sub-keys with rpm/tpm, model allowlists, guardrails"],
  ["GET /api/v1/key · /credits", "Current key; balance, held and total usage"],
  ["POST /api/v1/credits/deposit-tx · /withdraw-request", "Unsigned wallet transactions to deposit, or a key-signed withdrawal request"],
  ["GET /api/v1/credits/withdrawal-proof", "Merkle proof and calldata to finalize a withdrawal"],
  ["POST /api/v1/paywith/open · /close · /revoke · GET /session · /statement", "Stock Token sessions and monthly statements"],
  ["POST /api/v1/paywith/allowance/typed-data · /allowance · GET /charges · POST /charges/{id}/signature", "Wallet authorizations: a bounded allowance, or a signature per charge"],
  ["POST /api/v1/byok · /teams", "Bring your own provider key; team roles"],
  ["GET · POST · PATCH · DELETE /api/v1/routes", "Saved Routes: named routing policies you call as model \"@route/<slug>\", optionally pinned to the attested lane"],
  ["POST · GET · DELETE /api/v1/sessions · GET /sessions/current", "Agent Sessions: short-lived, budget-capped keys for agent runs"],
  ["GET /api/v1/spend · /spend/alerts", "Spend Watch: totals, projection, breakdowns, key budgets and alert rules"],
  ["GET /api/v1/disclosure/:providerId", "A provider’s documented retention, jurisdiction, legal hold and training use, each with a source and date, and the class it is served under now"],
  ["GET /api/v1/models?variant=…", "Open-weights variants (mainstream, native_low_refusal, abliterated) with license, base model and weights source; restricted variants list only attested endpoints"],
  ["POST /api/v1/creators/claims · /claims/{id}/verify", "Claim a model’s creator royalty by publishing a challenge in its Hugging Face repository"],
  ["GET /api/v1/blind/keys", "Blind tokens, where enabled: the issuer keys per epoch and denomination, the challenge every token carries, and prices"],
  ["POST /api/v1/blind/purchase", "Blind tokens, where enabled: buy tokens with credits by sending blinded messages; spend one with Authorization: PrivateToken on chat or embeddings"],
  ["GET /api/v1/ohttp/keys · POST /api/v1/ohttp/gateway", "Oblivious HTTP, where enabled: the gateway key configuration (application/ohttp-keys), and the gateway that unwraps message/ohttp-req sent by a relay and returns message/ohttp-res"],
  ["GET /api/v1/ohttp/key-list · GET /api/v1/relays", "Oblivious HTTP, where enabled: the gateway key history signed with the receipt key, and the relays clients may use, by operator"],
  ["GET /api/v1/holder", "$ANYR holders: balance, live tier (higher rate limits, lower fees), the tier ladder and free credits received"],
  ["POST /api/v1/receipts/verify · GET /receipts/keys", "Verify a receipt’s signature and anchor inclusion; signing keys (JWKS)"],
  ["GET /.well-known/anyroute-receipt-keys.json", "The same signing keys at a fixed path, for clients that verify receipts themselves"],
  ["GET /api/v1/attestation/:providerId", "What the router has verified about a provider’s hardware attestation: status, verifiers, measurements, transparency-log and on-chain state, and what was not checked"],
  ["GET /api/v1/badge/:id.svg", "Attestation badge image for a provider id or a model id (attested, policy, vendor-forwarded or unverified), with the measurement and policy hash while attested and the share of 7 days with a fresh attestation; ?theme=dark. An unknown id is Unverified with a 404"],
  ["GET /api/v1/attestation/summary · /attestation/:providerId/history", "Proof-time: per attesting provider, the share of the last 24 hours and 7 days with a fresh attestation the router verified itself, measurement changes and the last failed check; and a provider’s recorded attestor, canary and probe events, newest first, paged by cursor. Failures are codes with fixed messages, never the provider’s own text. Kept for ATTESTATION_HISTORY_DAYS (30); 501 when it is 0"],
  ["GET /api/v1/measurements/key · /measurements/bundles/:providerId", "Where enabled: the key that signs measurement bundles (compose hash, source commit and tarball hash, model and image digests, MRTD allow-list), and a provider’s bundles with the transparency-log entry the router verified for each"],
  ["POST /mcp", "AnyRoute MCP: list_models, list_attested_models, chat (optionally on the attested lane), verify_provider, get_receipt and verify_receipt as tools for Claude, Cursor or any MCP client"],
  ["GET /api/v1/rankings · /providers · /status", "Usage rankings and creator payouts; the provider registry with each provider’s attestation status (attestation.status, tee, verifiers, last_verified_at); router configuration, including its onion address where there is one"],
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
            <a href="#tor">Tor</a>
            <a href="#lane">Lane</a>
            <a href="#payments">Payments</a>
            <a href="#x402">x402</a>
            <a href="#receipts">Receipts</a>
            <a href="#council">Council</a>
            <a href="#mcp">MCP</a>
            <a href="#sdk">SDKs</a>
            <a href="#run-a-provider">Run a provider</a>
            <a href="#badge">Badge</a>
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
            503 when qualifying providers are down. It is never sent to a provider that does not qualify, and nothing is charged. The unlinkable lane is served only where the router enables Oblivious HTTP (see below); elsewhere it returns 501. A request with a disclosure setting never uses the response cache.
          </p>
          <p>
            Responses carry X-Anyroute-Disclosure (attested, policy or vendor-forwarded) and X-Anyroute-Lane, and the signed receipt records disclosure and lane. On a stream the header is sent only when every reachable provider shares one class; the
            receipt always states it. A development attestation is marked attestation_simulated and is refused in production. GET /api/v1/models?lane=attested lists the models that have an attested endpoint now.
          </p>
          <p>
            A saved route can carry the same settings: provider.lane (public or attested) and provider.disclosure in its provider policy. When a request calls @route/&lt;slug&gt;, the stricter of the route’s and the request’s value applies, so a
            request can tighten a route but never loosen it, and a route on the attested lane is served by an attested provider or refused. Saving such a route fails with 409 route_lane_unavailable, naming the models, when a model in its list has
            no provider that meets the setting right now. In the dashboard, Batch Studio can run a whole batch on the attested lane: it sends provider.lane attested with every row, offers only the models GET /api/v1/models?lane=attested lists, shows
            the lane and receipt id of each row from X-Anyroute-Lane and X-Receipt-Id, and marks a row the router refuses or withholds as failed closed.
          </p>
          <h2 id="unlinkable">The unlinkable lane, where the router enables it.</h2>
          <p>
            Lane unlinkable keeps the router from tying together who pays, where a request came from and what it says. It is served only when all three hold: the request arrives through the router’s Oblivious HTTP gateway (RFC 9458) by way of a relay
            run by an operator other than the router’s own; it is paid with a blind token (Authorization: PrivateToken), never a key or a wallet; and it is routed only to attested providers, the same filter as lane attested. The receipt then
            says lane unlinkable. GET /api/v1/relays lists the relays by operator. GET /api/v1/ohttp/keys is the gateway’s key configuration and GET /api/v1/ohttp/key-list is the key history, signed with the receipt key and hash-chained, for pinning.
          </p>
          <p>
            A direct request for the lane is refused with 403 unlinkable_requires_relay and says what to do; through the gateway without a token it is 401 (unlinkable_requires_token) with the token challenge, and 403 for a key or a relay run by the
            router’s own operator. What is hidden: the relay sees your address and an encrypted request; the router sees the request and the relay, never your address; the token’s purchase cannot be tied to its use. What is not: a relay that
            cooperates with the router can join the two, timing and message sizes can be correlated (responses are padded), and any identifier you put in the request body reaches the provider. Streaming is not available through the gateway.
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
          <h2 id="tor">Reach AnyRoute over Tor.</h2>
          <p>
            Where the router runs an onion service, you can call it through Tor and keep your network address from the router and from the network it runs on. GET /api/v1/status publishes the address as onion.address, and it is shown below. Use it as
            http://&lt;address&gt; from Tor Browser or any client that can use a SOCKS5 proxy and lets the proxy resolve names (curl --socks5-hostname, or torsocks); the API is the same, under /api/v1 on that host. The onion service itself
            encrypts and authenticates the connection to the router, so plain http:// is correct there. The site’s pages also carry an Onion-Location header, which Tor Browser turns into an “.onion available” prompt.
          </p>
          <OnionAddress />
          <Code label="Through a local Tor client (SOCKS5 on 127.0.0.1:9050)">{torCurl}</Code>
          <p>
            Tor hides where you connect from, not what you send: an API key, a wallet signature or a prompt identifies you or your account exactly as it does on the clearnet. For payment that cannot be linked to your requests, use blind tokens, and for the
            unlinkable lane a relay. Requests that arrive over Tor have no address the router can limit, so calls without an API key (unkeyed chat and embeddings, new keys, wallet sign-in challenges) share limits with everyone else using the
            onion address, and a call with a key is limited per key as usual: use a key or a token for a quota of your own. The first request can take several seconds while Tor builds its circuit. A relay operator can also reach a gateway’s onion address through a
            SOCKS5 proxy (RELAY_SOCKS5_PROXY in relay/), so the gateway never sees the relay’s address either.
          </p>
          <h2 id="lane">Open-weights variants, and paying their creators.</h2>
          <p>
            Every model has a variant. mainstream keeps the publisher’s own alignment. native_low_refusal (trained to refuse little) and abliterated (refusal behaviour removed from the weights after training) are restricted variants. GET
            /api/v1/models reports variant, variant_source, license, base_model, weights (source, revision, digest) and creator_handle, and takes ?variant= (a comma list) next to ?lane=. variant_source says whether an operator declared the
            variant; a model nobody has classified whose name says its refusals were removed is treated as abliterated.
          </p>
          <p>
            A restricted variant is served only by a provider that is served under attested retention with a fresh attestation and whose attestation reported the in-enclave hard-block classifier as enabled (classifier_enabled in GET
            /api/v1/providers). That is a property of the model, not a request option: no lane or disclosure setting, and no provider.only, sends it anywhere else, and the response cache is never used for it. Its listing shows only the endpoints
            that qualify, and a request with none qualifying fails with no_providers before anything is sent. The router takes the flag only from what a verified attestation commits to (a development report counts only outside production) and treats
            anything unknown as off, so a provider whose attestation says nothing about a classifier does not qualify. The flag shows what the attestation reports; it does not prove how the classifier behaves.
          </p>
          <p>
            When an operator enables the day-zero pipeline (DAYZERO_ENABLED, with DAYZERO_BASE_MODELS naming the base models), the router watches Hugging Face for new fine-tunes of those models whose name or tags contain a configured keyword (abliterated, uncensored,
            decensored and unfiltered by default), and keeps those whose model card carries an allowed license (MIT or Apache-2.0 by default; the base model’s own card is checked too). Each candidate is evaluated on a provider’s endpoint with 16 benign prompts that base models often
            over-refuse (fiction, security education, medical and legal information; none is harmful or illegal), 12 capability prompts with exact checks and the router’s canary set, and the scores are stored. A model becomes servable only after an
            operator approves the evaluated candidate and an attested provider that reports the classifier serves it. Until then it is routed to no one, and a candidate that later fails an evaluation is withdrawn. The operator endpoints are under
            /api/v1/lane/candidates.
          </p>
          <p>
            The uploader of a model’s weights can claim its royalty. POST /api/v1/creators/claims with the model and a payout address returns a challenge. Commit it, on its own line, to the file named in the response on the main branch of the Hugging
            Face repository the weights come from, then POST /api/v1/creators/claims/{"{id}"}/verify. The router reads the repository’s owner and the file through the Hugging Face API. On a match the address is recorded as the model’s royalty recipient
            (5% of the notional price unless the router is configured otherwise, at most 20%), registered in the royalty contract where one is deployed, and shown as creator and royalty_bps. Every later call to the model includes the royalty as its own
            cost line, and each hourly settlement streams it in USDG to the recipient. A claim needs a Hugging Face weights source recorded by the operator, and it proves control of that repository and nothing more.
          </p>
          <Code label="Claim a royalty: request, then response">{`${claimRequest}\n\n${claimResponse}`}</Code>
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
          <h3 id="response-headers">Response headers</h3>
          <p>
            Every chat, completion and embeddings response names its receipt in X-Receipt-Id, the same id as the body’s id and receipt.id, and again in Inference-Id, the header Hugging Face inference clients read. X-Anyroute-Lane is the lane
            the request was served under: public, attested or unlinkable. X-Anyroute-Policy-Hash is sent only when the endpoint that served the call has a fresh, verified attestation that binds the hash of the policy its in-enclave classifier
            enforces; the router relays that value and never computes one. On a stream these headers arrive before the first chunk, so the policy hash is sent there only when every endpoint the request can reach attested the same one. Browsers can
            read all of them.
          </p>
          <Code label="Response headers">{responseHeaders}</Code>
          <p>
            GET /api/v1/models adds, per model, an attestation object for its strongest live endpoint and a datacenter_region. best is that endpoint’s disclosure class. manifest_ref points at the transparency-log entry and the on-chain registry
            transaction of its measured image, each only once the router checked it. policy_hash is the attested classifier policy. Anything the router has not verified is null, never filled in; exec_profile_id stays null until an attestation reports
            one. datacenter_region is set only when every endpoint reports the same single region.
          </p>
          <Code label="GET /api/v1/models (new fields)">{modelAttestation}</Code>
          <h2 id="council">Ask several models, or the same one twice.</h2>
          <p>
            Two opt-in modes, available when the router enables them (the ANYROUTE_FEATURE_COUNCIL setting, off by default). Neither streams. Every call they make is routed, billed and receipted like a request of its own, and the worst case of all of
            them is held before anything is sent, so your balance and key budget bound the whole request. Your provider preferences, including a disclosure ceiling or lane, apply to every call, the judge included: a member with no provider that meets them refuses the request with a 409 instead of being dropped or downgraded. The disclosure header and the top-level receipt show the weakest class among the calls; each member’s receipt shows its own.
          </p>
          <p>
            <b>Council.</b> Set model to anyroute/council and list 2 to 5 members and a judge. The members run in parallel; the judge either picks one answer, returned unchanged (mode judge), or writes a final one (mode fuse, text only). A member
            that fails is not billed and the council goes on with the rest, as long as at least two answered. The response carries a council field listing each member (model, receipt id, cost, latency) and the judge; the top-level receipt is the
            judge’s call and its signed payload lists the member receipt ids. Set council.max_cost_usd to refuse the request unless its worst case fits; lower max_tokens to make it fit. A judge is a model’s opinion, not a proof.
          </p>
          <Code label="Council request">{councilRequest}</Code>
          <Code label="Council response (abridged)">{councilResponse}</Code>
          <p>
            <b>Dual verification.</b> Add verify: "dual" to a request for one model. It goes to two different providers of that model at temperature 0 with a fixed seed (yours, if you send seed), and both outputs are compared. The response has a
            verification field with the two provider ids, agree (true when the outputs match exactly or differ only in whitespace), the two receipt ids and the seed; each receipt carries the same agreement bit. Both calls are billed, and the body
            is the first provider’s output. If fewer than two providers of the model support temperature and seed under your routing preferences, the answer is 409. Agreement shows two providers gave the same text; it does not show that either is attested, and providers running different quantizations may legitimately differ.
          </p>
          <Code label="Dual verification request">{verifyRequest}</Code>
          <p>
            <b>Attested council and attested dual verification.</b> Set council.attested to true (or send provider.lane or the X-Anyroute-Lane header as attested, which asks for the same thing) and every member and the judge are held to the attested lane:
            a provider whose retention is declared attested and whose hardware attestation the router holds fresh, the same test as any other attested-lane request. Nothing is downgraded and no member is dropped. A member, or the judge, with no
            attested provider refuses the whole request with a 409 (lane_unavailable, and error.metadata.council_seat says which seat), or a 503 while attested providers are down; nothing is sent, held or charged. Each call’s signed receipt then has an
            attestation_ref: the hash of the attestation report the router verified for the provider that served it, and the TLS key its connection was pinned to (tls_pin is null for a provider that did not attest through a self-signed certificate).
            The response’s council field adds attested and attestation_refs (members in order, then the judge), and both are signed in the top-level receipt, so changing a reference breaks its signature. attested is true only when every call was served
            under the attested class. These are the router’s own records, the same ones behind GET /api/v1/attestation/{"{providerId}"}; they show what was running and pinned, not what it did with your prompt.
          </p>
          <Code label="Attested council request">{attestedCouncilRequest}</Code>
          <Code label="Attested council response (abridged)">{attestedCouncilResponse}</Code>
          <p>
            Dual verification with provider.lane set to attested sends the two calls to two different attested providers of the model. Both receipts carry the agreement bit, and the verification field and each receipt add attested and the two
            attestation references. If the model has fewer than two attested providers the answer is 409 (verification_unavailable with one, lane_unavailable with none), and nothing is sent or charged. Agreement still only shows that two providers
            gave the same text.
          </p>
          <Code label="Attested dual verification request">{attestedDualRequest}</Code>
          <p>
            <b>Availability.</b> Production has one attested provider today, and it serves a small (0.5B) model, so an attested council, which needs an attested provider for every member and the judge, and attested dual verification, which needs
            two for one model, will mostly answer with the 409 above until more attested providers join. That refusal is the intended behaviour, not a fault: the router does not fall back to a provider that is not attested. On a development
            router the attestation can be a development report; receipts then say so (attestation_simulated, and simulated inside the reference), and a production router never accepts one. Receipts from calls made any other way do not carry attestation_ref, and older receipts verify as before.
          </p>
          <h2 id="mcp">Use every model as a tool.</h2>
          <p>
            The router hosts a remote MCP server at /mcp (Streamable HTTP, stateless, JSON replies). Connect it to Claude, Cursor or any MCP client with your Anyroute key. Six tools: list_models (live models, context length and price per 1M
            tokens), chat (call any model; returns the reply, a receipt id, cost and latency), get_receipt and verify_receipt, and two for private work, list_attested_models and verify_provider (below). Chat goes through /api/v1/chat/completions with your key, so balance, limits and signed receipts are the same.
            Only chat needs a key.
          </p>
          <Code label="Claude Code">{claudeCode}</Code>
          <Code label="Cursor · ~/.cursor/mcp.json">{cursorConfig}</Code>
          <Code label="Claude Desktop · claude_desktop_config.json (through the mcp-remote bridge)">{desktopConfig}</Code>
          <Code label="Check it with curl">{mcpCurl}</Code>
          <h3>Keep a prompt with proven enclaves</h3>
          <p>
            list_attested_models lists the models the attested lane can serve now: those with an endpoint whose TEE attestation the router verified itself and whose provider documents no retention. Each carries gpu_attested, true when the latest verified gateway receipt
            for the model asserted GPU attestation, false when it did not and null before any receipt. chat takes lane (public or attested) and disclosure (none, policy or any) with the meaning of provider.lane and provider.disclosure: on the attested lane the prompt goes only to
            such a provider, and when none can answer the call fails (409 lane_unavailable, or 503 while they are down) with nothing sent and nothing charged. The result reports the lane, the disclosure class the signed receipt records and, when the provider is an attested gateway,
            its upstream_attestation (attested, gpu_attested, receipt_verified and a reason when it is not attested). If the gateway’s receipt does not show an attested upstream, the reply is withheld and the error carries the receipt id; the upstream had already produced the answer, so the call is billed.
          </p>
          <p>
            To make every chat call on a connection attested, add ?lane=attested to the /mcp URL, or send X-Anyroute-Lane: attested; ?disclosure= and X-Anyroute-Disclosure-Max set a ceiling the same way. The strictest setting wins: a call can tighten the connection’s setting and never relax it,
            and a value the router does not recognise refuses the call instead of falling back to public. The unlinkable lane needs a relay and a blind token, so it is not offered over MCP.
          </p>
          <Code label="Claude Code · every chat call attested">{claudeCodeAttested}</Code>
          <Code label="tools/call · chat on the attested lane">{mcpAttestedCall}</Code>
          <Code label="Result (abridged)">{mcpAttestedResult}</Code>
          <p>
            verify_provider takes a provider id (the provider field of a receipt) and returns the router’s own attestation record in plain terms: the status (attested or unverified; a development report is marked as such and refused in production), the TEE and the verifiers that accepted its quote, whether the router pins the
            provider’s TLS key, the state of the transparency-log entry for its measurement, and not_checked, the list of what the router does not verify. Attestation shows what code is running, not what a provider does with a prompt. The same record is at GET /api/v1/attestation/:providerId and on the verify page.
          </p>
          <p>
            The Telegram bot follows the same rule. /private on sends every chat with lane attested, /models attested lists the models with a proven enclave and /model accepts only those while private mode is on. Each answer’s footer says attested, or attested · GPU when the gateway’s receipt asserts GPU attestation,
            taken from the signed receipt, with a link to the provider’s verify page; an answer whose receipt does not show an attested provider is not delivered. When no attested provider can answer, the bot says nothing was sent and nothing was charged.
          </p>
          <h2 id="sdk">Verify before you send.</h2>
          <p>
            Two client libraries wrap the OpenAI-shaped call and add the checks a plain HTTP client would skip. The TypeScript package, @anyroute/client, has no runtime dependencies and runs on Bun, Node 20 and later, and in browsers. The Python package, anyroute-client (Python
            3.10 and later), depends only on cryptography and httpx. Their source is in packages/client and packages/client-py in the repository. Both report every check as pass, fail or not checked, and a check they did not make is never shown as passed.
          </p>
          <h3>Receipts</h3>
          <p>
            Each response carries its verification: the Ed25519 signature over the receipt’s canonical JSON against the key in the router’s published key list (fetched once, and read again if a receipt names a key it has not seen, as after a weekly rotation), that the key id is the
            hash of the key, that the receipt is dated inside its key’s window, that its leaf recomputes from the signed bytes and, when the receipt came with an anchor proof, that the leaf is under the stated root. It does not check that the key is registered on chain or that the root was posted
            there, and says so. Pass pinned keys to skip the fetch. A receipt a provider’s sidecar signed with its enclave key is checked against the receipt key its attestation binds, and must name the same attestation and model digest.
          </p>
          <Code label="TypeScript · receipts, disclosure and lane">{sdkReceipt}</Code>
          <h3>Attested providers</h3>
          <p>
            Give a request an attested option and the client checks the provider first and sends nothing unless every check passes. It reads the router’s record (GET /api/v1/attestation/:providerId) and the provider’s own /attest document, then checks that the router reports the provider
            attested with a quote it verified recently; that the quote is an Intel TDX quote whose report_data is SHA-256 of the canonical bindings followed by the nonce, so the TLS key, receipt key and the image, compose and model digests are committed in the quote; that a fresh quote for a random nonce
            the client chose says the same; that the certificate name is derived from SHA-256 of the quote; that, where the runtime can read the connection’s certificate, it carries that name and the attested TLS key; and that the router’s recorded digests equal the provider’s. If you supply the model digest you
            expect, it must match. Simulated (development) evidence is refused unless you opt in, and is then labelled simulated. On success the request is pinned to that provider (provider.only, no fallbacks, lane attested), and the receipt is checked for naming it.
          </p>
          <p>
            What it does not check, and reports as not checked: Intel’s signature and certificate chain over the quote (the router does that; pass a quoteVerifier to run your own), what the provider does with your prompt, whether the running software matches its published source, and
            the transport when the runtime cannot read the certificate, as in a browser. Passing nodeAttestFetcher on Node or Bun reads the certificate from the same connection that served /attest.
          </p>
          <Code label="TypeScript · verify before send">{sdkAttested}</Code>
          <Code label="Python">{sdkPython}</Code>
          <h3>Blind tokens and end-to-end encryption</h3>
          <p>
            Where the router has blind tokens enabled, buyTokens() from @anyroute/client/blind blinds, buys and unblinds tokens with your key, and client.withPrivateToken(token) makes a client that spends one; the blind-token module needs the optional package @cloudflare/blindrsa-ts, and the main entry point never loads it. For end-to-end encryption to an enclave, sealedPost() encrypts
            a request with an HPKE implementation you supply, sends it as application/anyroute-hpke and opens the reply. It seals only to an HPKE key the provider’s verified quote commits to, and refuses if the provider did not verify or the quote commits to no such key. The SDK ships no HPKE cipher: the
            implementation and wire format must match the provider’s sidecar. The Python package covers receipts, provider verification, and disclosure and lane options, and can spend a blind token you already hold; it cannot buy tokens and has no streaming or HPKE support.
          </p>
          <p>
            <a href="/verify/" className="inline-link">
              The verify page
            </a>{" "}
            shows what the router has recorded for a provider (/verify/?p=&lt;provider id&gt;) and checks a pasted receipt in your browser. It reads the router’s record only; use an SDK to check the provider itself.
          </p>
          <h2 id="run-a-provider">Run a provider.</h2>
          <p>
            A model host runs the sidecar in front of its model server, inside a confidential VM. The sidecar hashes the weights at boot and refuses to start unless the digest is on its allow-list, binds its TLS key, receipt key and the image, compose and model digests into an Intel TDX quote, and signs a receipt for every
            response. The onboarding command writes all of that for you:
          </p>
          <Code label="Terminal">{QUICKSTART}</Code>
          <p>
            It asks where the model runs (a Phala Cloud CPU or GPU confidential VM, or your own TDX host), measures the weights, and writes sidecar.yaml and a compose file in which every image, the weights and the sidecar source are pinned by hash. It makes the key the router will use: 32 random bytes in a file only you can read, with just their
            SHA-256 in the configuration. Then deploy, and check the running endpoint before you apply:
          </p>
          <Code label="Terminal · without questions">{QUICKSTART_FLAGS}</Code>
          <p>
            The doctor command reads /healthz and /attest the way a client would, and checks that the served model digest is your weights, that the quote commits to the keys and digests, that the certificate carries the attestation name and the attested key, and that a response carries a receipt signed by that key. It sends your router key
            only over a certificate the evidence proves belongs to the attested instance. It does not repeat Intel’s signature check on the quote; the router does. The apply command prints the exact body for POST /api/v1/providers/apply and, with --submit, files it. An operator reviews the application before anything is routed, and the router key goes to them separately unless you pass --include-key.
          </p>
          <p>
            The sidecar attests the TDX virtual machine and does not collect GPU confidential-computing evidence. The data policy in your application is your own declaration and is shown as declared. Providers the router lists, and what it has verified about each, are on{" "}
            <a href="/providers/" className="inline-link">
              the providers page
            </a>
            .
          </p>
          <h2 id="badge">Show your attestation with a badge.</h2>
          <p>
            Any site can show an endpoint’s live status with one line. The script has no dependencies and sets no cookies. It reads the router’s public record from each visitor’s browser (the proof-time summary, the attestation record and the disclosure class, and for a model its attestation object and endpoints) and shows Attested only when every check passes: the record was read within five minutes of the visitor’s clock, the last verified attestation is inside the router’s freshness window, the record and the summary agree and name the same measurement, and the policy hash is well formed and, for a model, the same in the model’s attestation object, its endpoint and the record. Any failed check reads Unverified.
          </p>
          <Code label="HTML · script badge">{badgeScript}</Code>
          <p>
            data-endpoint takes a provider id or a model id. data-theme is light, dark or auto (follows the visitor’s colour scheme). The badge shows the status (Attested, Policy, Vendor-forwarded or Unverified), the first eight characters of the measurement and of the policy hash while attested, and the share of the last 7 days with a fresh attestation, never rounded up. It links to the endpoint’s registry entry. It does not verify the hardware quote itself: the router does that with its configured verifiers, and the badge says so.
          </p>
          <p>For places that do not run scripts, the router serves the same status as an image. The image says what the router’s record says; nothing about it is checked in the viewer’s browser.</p>
          <Code label="HTML and Markdown · image badge">{badgeImg}</Code>
          <p>
            <a href="/registry/" className="inline-link">
              The registry
            </a>{" "}
            lists every attested endpoint, and each entry (/registry/&lt;provider id&gt;/) shows its measurement versions, every check the router ran and the badge snippets for it.
          </p>
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
