import RouterLimits from "../../components/RouterLimits"; // HD1
import AgentGuardDocs from "../../components/AgentGuardDocs"; // V98
import FastCreditDocs from '../../components/FastCreditDocs'; // V97
import KeyProvisioningDocs from "../../components/KeyProvisioningDocs"; // ZK6
import FacilitatorDocs from "../../components/FacilitatorDocs"; // v6 F: hosted x402 facilitator.
import ToolsMarketDocs from "../../components/ToolsMarketDocs"; // v6 T: paid x402 tools.
import ZkapiDocs from "../../components/ZkapiDocs"; // ZK9: Sepolia browser payment.
import GetUsdgDocs from "../../components/GetUsdgDocs"; // ON1
import FirstCallDocs from "../../components/FirstCallDocs"; // ON2
import RouteExplanationDocs from "../../components/RouteExplanationDocs"; // V84
import StructuredOutputDocs from "../../components/StructuredOutputDocs"; // V83
import StatementDocs from "../../components/StatementDocs"; // V87
import ProofPackDocs from "../../components/ProofPackDocs"; // U100
import WebhookDocs from "../../components/WebhookDocs"; // V86: optional signed event delivery.
import MakeGoodDocs from "../../components/MakeGoodDocs"; // V6 R: make-good refunds.
import AgentProfileDocs from "../../components/AgentProfileDocs";
import AgentIdentityDocs from "../../components/AgentIdentityDocs";
import SealedAgentDocs from "../../components/SealedAgentDocs";
import AgreementsDocs from "../../components/AgreementsDocs";
import DocsFeatureIndex, { DocsFeatureLinks } from "../../components/DocsFeatureIndex";
import NetworkPayoutDocs from "../../components/NetworkPayoutDocs";
import NetworkStatsDocs from "../../components/NetworkStatsDocs";
import CommerceStatsDocs from "../../components/CommerceStatsDocs"; // v6 L
import HostBondsDocs from "../../components/HostBondsDocs";
import AgentLedgerDocs from "../../components/AgentLedgerDocs";
import NetworkHostsDocs from "../../components/NetworkHostsDocs";
import SanctionsSection from "./SanctionsSection";
import E2eeDocs from "../../components/E2eeDocs";
import PageFrame from "../../components/PageFrame";
import { Button, Code } from "../../components/UI";
import { sampleRequest } from "../../components/Extensions";
import AgentAutonomyDocs from "../../components/AgentAutonomyDocs";
import AgentAlertDocs from "../../components/AgentAlertDocs";
import AgentRulebookDocs from "../../components/AgentRulebookDocs";
import SpendingLimitsDocs from "../../components/SpendingLimitsDocs";
import DefaultRouteDocs from "../../components/DefaultRouteDocs";
import StarterSetupsDocs from "../../components/StarterSetupsDocs"; // U103
import AgentBreakersDocs from "../../components/AgentBreakersDocs";
import AgentCertificateDocs from "../../components/AgentCertificateDocs";
import AgentApprovalDocs from "../../components/AgentApprovalDocs";
import TradingAgentDocs from "../../components/TradingAgentDocs"; // B
import { API_BASE } from "../../lib/api";
import { QUICKSTART, QUICKSTART_FLAGS } from "../../lib/providers";
import OnionAddress from "../../components/OnionAddress";
import ClaudeUnlinkableDocs from "../../components/ClaudeUnlinkableDocs";
import NetworkPolicyDocs from "../../components/NetworkPolicyDocs";
import PrivateProxyDocs from "../../components/PrivateProxyDocs";
import HostsDocs from "../../components/HostsDocs";
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
    anchor_hint: "Rooted within the hour; GET /api/v1/receipts/gen-1790461071-M1D5SJxd7YpD5A/proof returns the merkle path.",
    paid_with: { token: "NVDA", raw_units: "<units>", fair_price: "<18-decimal USD>", swap_tx: "<tx once swapped>" },
  },
};
// GET /api/v1/receipts/{id}/privacy for an attested-lane call paid from a key; the four long sentences are elided here and read in full in the response.
const privacyExample = {
  "data": {
    "receipt_id": "gen-1790461071-M1D5SJxd7YpD5A",
    "lane": "attested",
    "label": {
      "prompt_readers": {
        "router": true,
        "provider": {
          "id": "attested-gateway",
          "access": "attested_enclave",
          "reply_withheld": false
        },
        "text": "…"
      },
      "network": {
        "hidden": false,
        "via": null,
        "stored": false,
        "counter": "none",
        "text": "…"
      },
      "payment": {
        "kind": "key_balance",
        "identifies": "api_key",
        "text": "…"
      },
      "stored": {
        "prompt_text": false,
        "reply_text": false,
        "client_address": false,
        "fingerprints": true,
        "linked_to": "api_key",
        "cache": "never",
        "records": [
          "…"
        ],
        "public_by_id": true,
        "text": "…"
      },
      "hardware": {
        "attested": true,
        "tee": "Intel TDX",
        "gpu_attested": true,
        "verified_by": "gateway_receipt",
        "development_report": false,
        "text": "…"
      }
    },
    "summary": [
      "Read by: AnyRoute's router (in memory, to route it) and the provider's attested enclave (attested-gateway).",
      "Your IP address: seen by AnyRoute's servers when you connected; not saved with this answer.",
      "Paid with: an API key's balance. The receipt names the key by its hash.",
      "Kept: token counts, cost, timing and hashes of the request and reply. Not kept: the prompt or the reply text.",
      "Hardware: attested (Intel TDX with GPU attestation), checked from the gateway's signed receipt."
    ],
    "short": "Read by: router + proven enclave · IP: seen, not saved · Paid: API key balance",
    "verify_url": "https://router.example/verify?r=gen-1790461071-M1D5SJxd7YpD5A"
  }
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
const keepCurl = `# the inventory, byte for byte, and its hash
curl -s ${BASE}/keep/inventory.json | sha256sum

# the same hash in the router's key log (a data_inventory entry), where the operator has switched that on
curl -s "${BASE}/api/v1/tlog/proof?kind=data_inventory&sha256=<the hash>"`;
const torCurl = `curl --socks5-hostname 127.0.0.1:9050 http://<onion address>/api/v1/models

# a call with your key, the same request as on the clearnet
curl --socks5-hostname 127.0.0.1:9050 http://<onion address>/api/v1/chat/completions \\
  -H "Authorization: Bearer $ANYROUTE_API_KEY" -H "Content-Type: application/json" \\
  -d '{"model":"meta-llama/llama-3.3-70b-instruct","messages":[{"role":"user","content":"Hello"}]}'`;
const torBuyTokens = `// Buy blind tokens ahead of time with your key (Node or Bun; needs the optional package @cloudflare/blindrsa-ts).
// The purchase names your account; the tokens it returns cannot be tied back to it when you spend them.
import { buyTokens } from "@anyroute/client/blind";

const { tokens } = await buyTokens({ baseUrl: "https://<router>", apiKey: process.env.ANYROUTE_API_KEY, denomination: 10000, count: 10 });
console.log(tokens.join("\\n")); // one token pays for one call; keep them private until you spend them`;
const tokenFileExample = `{
  "version": 1,
  "tokens": [
    {
      "token": "AAJ…",
      "key_id": "47aec8f7ed92f6f0c7f516e96db914edb6ceef5faeba45e1c252c38f9b997afe",
      "denomination": 1000,
      "epoch": 2900,
      "value_usd": "0.002",
      "redeem_until": "2026-10-13T01:53:13.999Z",
      "bought_at": "2026-09-30T00:00:00.000Z"
    }
  ],
  "unconfirmed": []
}`;
const tokenFileSdk = `import { readFile, writeFile } from "node:fs/promises";
import { AnyRoute, parseTokenFile, serializeTokenFile, withoutTokens } from "@anyroute/client";

const path = \`\${process.env.HOME}/.anyroute/tokens.json\`;
const file = parseTokenFile(await readFile(path, "utf8")); // throws TokenFileError with a reason if it is not a token file
const [next] = file.tokens; // one token pays for one call

const client = new AnyRoute({ baseUrl: "http://<onion address>" }).withPrivateToken(next.token);
// ... send the call, then take the token out of the file so it is not used twice:
await writeFile(path, serializeTokenFile(withoutTokens(file, [next.token])), { mode: 0o600 });`;
const tokenFileMerge = `# Add a downloaded file to the one you already have (do not copy it over: that would drop the tokens already there)
jq -s '.[0] + {tokens: (map(.tokens) | add | unique_by(.token))}' ~/.anyroute/tokens.json anyroute-tokens.json > merged.json \\
  && chmod 600 merged.json && mv merged.json ~/.anyroute/tokens.json

# One token from the file, spent on one call over Tor
TOKEN=$(jq -r '.tokens[0].token' ~/.anyroute/tokens.json)
curl -N --proxy socks5h://127.0.0.1:9050 http://<onion address>/api/v1/chat/completions \\
  -H "Authorization: PrivateToken token=$TOKEN" -H "X-Anyroute-Lane: unlinkable" -H "Content-Type: application/json" \\
  -d '{"model":"<model from the list>","messages":[{"role":"user","content":"Hello"}]}'`;
const torUnlinkable = `# Is the lane served over Tor here? lanes.unlinkable.via lists "onion", and onion.url is the address.
curl -s --proxy socks5h://127.0.0.1:9050 http://<onion address>/api/v1/status | jq '.data.lanes.unlinkable, .data.onion'

# Models an attested provider can serve on the lane right now
curl -s --proxy socks5h://127.0.0.1:9050 "http://<onion address>/api/v1/models?lane=unlinkable" | jq -r '.data[].id'

# Spend one token on one call, streamed. A SOCKS user name of its own gives the call its own Tor circuit.
curl -N --proxy "socks5h://call-1:x@127.0.0.1:9050" http://<onion address>/api/v1/chat/completions \\
  -H "Authorization: PrivateToken token=$TOKEN" -H "X-Anyroute-Lane: unlinkable" -H "Content-Type: application/json" \\
  -d '{"model":"<model from the list>","messages":[{"role":"user","content":"Hello"}],"stream":true}'

# The same with torsocks
torsocks curl -N http://<onion address>/api/v1/chat/completions -H "Authorization: PrivateToken token=$TOKEN" \\
  -H "X-Anyroute-Lane: unlinkable" -H "Content-Type: application/json" \\
  -d '{"model":"<model from the list>","messages":[{"role":"user","content":"Hello"}]}'`;
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
const claudeCodeEnv = `export ANTHROPIC_BASE_URL=${BASE}
export ANTHROPIC_AUTH_TOKEN=$ANYROUTE_API_KEY        # sent as Authorization: Bearer. ANTHROPIC_API_KEY sends x-api-key instead; either works.

# Anthropic model names are not served here: name AnyRoute models.
export ANTHROPIC_MODEL=meta-llama/llama-3.3-70b-instruct
export ANTHROPIC_DEFAULT_SONNET_MODEL=meta-llama/llama-3.3-70b-instruct
export ANTHROPIC_DEFAULT_OPUS_MODEL=meta-llama/llama-3.3-70b-instruct
export ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen/qwen3-32b   # session titles and other background calls
export CLAUDE_CODE_SUBAGENT_MODEL=qwen/qwen3-32b

export CLAUDE_CODE_ATTRIBUTION_HEADER=0              # keep Claude Code's attribution line out of the prompt
claude`;
const claudeCodeAttestedEnv = `# Every request from this Claude Code session on the attested lane.
# A request no attested provider can serve is refused (409) with nothing sent and nothing charged.
export ANTHROPIC_CUSTOM_HEADERS="X-Anyroute-Lane: attested"
export ANTHROPIC_MODEL=<a model from GET /v1/models?lane=attested>`;
const claudeCodeSettings = JSON.stringify(
  {
    env: {
      ANTHROPIC_BASE_URL: BASE,
      ANTHROPIC_AUTH_TOKEN: "sk-ar-v1-…",
      ANTHROPIC_MODEL: "<a model from GET /v1/models>",
      ANTHROPIC_CUSTOM_HEADERS: "X-Anyroute-Lane: attested",
    },
  },
  null,
  2,
);
const anthropicPython = `import anthropic

client = anthropic.Anthropic(base_url="${BASE}", api_key="sk-ar-v1-…")   # or auth_token=... for Authorization: Bearer

raw = client.messages.with_raw_response.create(
    model="<a model from GET /v1/models?lane=attested>",
    max_tokens=512,
    messages=[{"role": "user", "content": "Hello"}],
    extra_body={"provider": {"lane": "attested"}},        # or extra_headers={"x-anyroute-lane": "attested"}
)
message = raw.parse()
print(message.content[0].text)
print(raw.headers["x-receipt-id"], raw.headers["x-anyroute-lane"], raw.headers.get("x-anyroute-policy-hash"))`;
const anthropicTs = `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ baseURL: "${BASE}", apiKey: process.env.ANYROUTE_API_KEY });

const { data: message, response } = await client.messages
  .create(
    { model: "<a model from GET /v1/models?lane=attested>", max_tokens: 512, messages: [{ role: "user", content: "Hello" }] },
    { headers: { "x-anyroute-lane": "attested" } }, // or provider: { lane: "attested" } in the body
  )
  .withResponse();
console.log(message.content, response.headers.get("x-receipt-id"), response.headers.get("x-anyroute-lane"));`;
const anthropicCurl = `curl -s ${BASE}/v1/messages \\
  -H "x-api-key: $ANYROUTE_API_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" \\
  -H "x-anyroute-lane: attested" \\
  -d '{"model":"<a model from GET /v1/models?lane=attested>","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'`;
const anthropicReply = JSON.stringify(
  {
    id: "gen-…",
    type: "message",
    role: "assistant",
    model: "<the model that answered>",
    content: [{ type: "text", text: "…" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    anyroute: {
      receipt_id: "gen-…",
      lane: "attested",
      disclosure: "attested",
      policy_hash: "sha256:<64 hex, only when the endpoint attested one>",
      provider: "…",
      cost_usd: 0.000022,
      upstream_attestation: { attested: true, gpu_attested: true, receipt_verified: true, kind: "aci/1" },
      receipt: { id: "gen-…", sig: "…", key_id: "…", alg: "Ed25519", payload: "…" },
    },
  },
  null,
  2,
);
const anthropicModelMap = `ANTHROPIC_MODEL_MAP={"claude-sonnet-4-5":"meta-llama/llama-3.3-70b-instruct","claude-haiku-*":"qwen/qwen3-32b"}`;
const ollamaHost = `export OLLAMA_HOST=${BASE}/ollama
ollama list                      # the live catalog, as Ollama names
ollama show meta-llama/llama-3.3-70b-instruct:latest`;
const ollamaPython = `from ollama import Client

client = Client(
    host="${BASE}/ollama",
    headers={"Authorization": "Bearer sk-ar-v1-…", "X-Anyroute-Lane": "attested"},
)
reply = client.chat(
    model="<a model from GET /ollama/api/tags>",
    messages=[{"role": "user", "content": "Hello"}],
)
print(reply.message.content)`;
const ollamaOpenWebUi = `# Open WebUI: the Ollama connection
OLLAMA_BASE_URL=${BASE}/ollama
# then in Admin Settings, Connections, give that connection your key (sk-ar-v1-…) as its Bearer key`;
const ollamaContinue = `# Continue: ~/.continue/config.yaml
models:
  - name: Anyroute
    provider: ollama
    model: meta-llama/llama-3.3-70b-instruct:latest
    apiBase: ${BASE}/ollama
    apiKey: sk-ar-v1-…            # sent as Authorization: Bearer
    requestOptions:
      headers:
        X-Anyroute-Lane: attested`;
const ollamaLangChain = `from langchain_ollama import ChatOllama

llm = ChatOllama(
    model="<a model from GET /ollama/api/tags>",
    base_url="${BASE}/ollama",
    client_kwargs={"headers": {"Authorization": "Bearer sk-ar-v1-…"}},
)`;
const ollamaCurl = `curl -s ${BASE}/ollama/api/chat \\
  -H "Authorization: Bearer $ANYROUTE_API_KEY" \\
  -H "X-Anyroute-Lane: attested" \\
  -d '{"model":"<a model from GET /ollama/api/tags>","messages":[{"role":"user","content":"Hello"}],"stream":false}'`;
const ollamaStream = `{"model":"meta-llama/llama-3.3-70b-instruct:latest","created_at":"2026-09-30T12:00:00.000Z","message":{"role":"assistant","content":"Hel"},"done":false}
{"model":"meta-llama/llama-3.3-70b-instruct:latest","created_at":"2026-09-30T12:00:00.041Z","message":{"role":"assistant","content":"lo!"},"done":false}
{"model":"meta-llama/llama-3.3-70b-instruct:latest","created_at":"2026-09-30T12:00:00.052Z","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","total_duration":412000000,"load_duration":0,"prompt_eval_count":9,"prompt_eval_duration":361000000,"eval_count":3,"eval_duration":51000000,"anyroute":{"receipt_id":"gen-…","lane":"attested","disclosure":"attested","provider":"…","cost_usd":0.0000021}}`;
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
const settlement = JSON.parse(atob(paid.headers.get("X-PAYMENT-RESPONSE"))); // { success, transaction, network, payer }

// x402 v2: the same requirement is in the PAYMENT-REQUIRED header (network "eip155:4663", amount). Send
// btoa(JSON.stringify({ x402Version: 2, resource, accepted, payload: { signature, authorization } })) as
// PAYMENT-SIGNATURE and read the same settlement from PAYMENT-RESPONSE.`;
const x402RecoveryExample = `// The paid call timed out, or came back 502, 503 or 504: send the identical request again with the same payment
// header and the payer's EIP-191 signature. The router sends the kept answer again and never relays the payment twice.
const message = \`anyroute:x402-recovery:4663:\${account.address.toLowerCase()}:\${authorization.nonce.toLowerCase()}\`;
const recovered = await fetch(url, {
  method: "POST",
  headers: { ...headers, "X-PAYMENT": xPayment, "PAYMENT-RECOVERY": await account.signMessage({ message }) },
  body, // the identical request
});
// 200: the same bytes and the same X-PAYMENT-RESPONSE as the lost answer.
// 404 payment_recovery_not_found: nothing is kept (error.metadata.settled says whether the payment was settled).`;
const laneRefusal = `POST /api/v1/chat/completions
{ "model": "<model>", "messages": [...], "provider": { "lane": "attested" } }

HTTP/1.1 503
{ "error": { "code": 503, "type": "no_attested_endpoint",
    "metadata": { "lane": "attested", "reason": "none_attested", "excluded": [...] } } }`;
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
const sdkTransparency = `import { AnyRoute, SplitViewDetected } from "@anyroute/client";

// Pin the log key and the witness keys from somewhere other than the log itself.
const client = new AnyRoute({
  baseUrl: "https://<router>",
  apiKey: process.env.ANYROUTE_API_KEY,
  transparency: { logKey: "<origin>+<key id>+<key>", witnesses: ["<witness key>", "<witness key>"], quorum: 2 },
});

const res = await client.chat.completions.create({ model: "meta-llama/llama-3.3-70b-instruct", messages: [{ role: "user", content: "Hello" }] });
res.anyroute.receiptVerification.checks.find((c) => c.id === "key_logged"); // fails if the receipt key is not logged

// Any other key or configuration, by kind: ohttp_key_config, blind_issuer_key, attestation_binding, ...
try {
  await client.transparency.requireLogged("ohttp_key_config", keyConfigBytes);
} catch (e) {
  if (e instanceof SplitViewDetected) console.error("two views of the log", e.evidence);
  throw e; // not_logged, not_witnessed, bad_proof: do not use the key
}`;
const sdkRekorAnchor = `import { TransparencyLog } from "@anyroute/client";

// Rekor anchoring: a verified Rekor entry for the checkpoint counts in place of witness cosignatures.
// Pin both keys out of band: the log's anchoring key (the one published for this log; the router also serves it at
// GET /api/v1/tlog/rekor/key) and Rekor's own key (https://rekor.sigstore.dev/api/v1/log/publicKey).
const log = new TransparencyLog({
  logUrl: "https://<router>",
  logKey: "<origin>+<key id>+<key>",
  rekor: { anchorKey: "-----BEGIN PUBLIC KEY-----\\n…", rekorKey: "-----BEGIN PUBLIC KEY-----\\n…" },
});

const logged = await log.requireLogged("receipt_key", receiptKeyBytes); // not_anchored, anchor_mismatch, bad_anchor: refused
console.log(logged.rekor.uuid, logged.rekor.logIndex); // the entry, also on search.sigstore.dev`;
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
const sdkOblivious = `import { AnyRoute, TransparencyLog } from "@anyroute/client";
import { obliviousFetch } from "@anyroute/client/ohttp"; // npm install ohttp-ts@0.6.0 hpke@1.1.7

// keyConfig: the base64url-decoded "config" of the current key in GET /api/v1/ohttp/key-list, after checking the
// list's signature against the receipt key you pinned. receiptKeys: the same pinned key set.
const client = new AnyRoute({
  baseUrl: "https://<router>",
  privateToken: "<a blind token>",
  lane: "unlinkable",
  receiptKeys,
  fetch: obliviousFetch({
    relayUrl: "https://<independent relay>/relay",
    keyConfig,
    // Optional: refuse a key configuration the witnessed key log does not include (the log is read directly).
    transparency: new TransparencyLog({ logUrl: "https://<router>", logKey: "<log key>", witnesses: ["<witness key>", "<witness key>"] }),
  }),
});
const stream = await client.chat.completions.stream({ model: "<model>", messages: [{ role: "user", content: "Hello" }] });
for await (const chunk of stream) process.stdout.write(chunk.choices?.[0]?.delta?.content ?? "");
// A response cut off on the way throws AnyRouteError "ohttp_truncated"; an altered chunk, "ohttp_decrypt_failed".
console.log((await stream.meta()).lane); // "unlinkable"`;
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

const agentsSdk = `import asyncio
import os

from agents import Agent, Runner, set_default_openai_api, set_default_openai_client, set_tracing_disabled
from openai import AsyncOpenAI

client = AsyncOpenAI(
    base_url="${BASE}/v1",
    api_key=os.environ["ANYROUTE_API_KEY"],  # sk-ar-v1-…
    default_headers={"X-Anyroute-Lane": "attested"},  # optional: attested providers only
)
set_default_openai_client(client, use_for_tracing=False)
set_default_openai_api("responses")
set_tracing_disabled(True)  # otherwise the SDK sends traces to its own tracing service

agent = Agent(name="Assistant", instructions="Answer briefly.", model="<model from GET /api/v1/models?lane=attested>")


async def main():
    result = await Runner.run(agent, "Hello, AnyRoute.")
    print(result.final_output)


asyncio.run(main())`;
const codexConfig = `# ~/.codex/config.toml  (export ANYROUTE_API_KEY first)
model = "<model id from GET /api/v1/models>"
model_provider = "anyroute"

[model_providers.anyroute]
name = "AnyRoute"
base_url = "${BASE}/v1"
env_key = "ANYROUTE_API_KEY"
wire_api = "responses"
# optional: send every prompt only to attested providers
http_headers = { "X-Anyroute-Lane" = "attested" }`;
const responsesCurl = `curl -s ${BASE}/v1/responses \\
  -H "Authorization: Bearer $ANYROUTE_API_KEY" -H "Content-Type: application/json" \\
  -H "X-Anyroute-Lane: attested" \\
  -d '{"model":"<model from GET /api/v1/models?lane=attested>","input":"Your prompt","max_output_tokens":200}'`;
const responsesResult = JSON.stringify(
  {
    id: "resp_gen-…",
    object: "response",
    status: "completed",
    model: "<model>",
    output: [{ type: "message", id: "msg_…", role: "assistant", status: "completed", content: [{ type: "output_text", text: "…", annotations: [] }] }],
    usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17, cost: 0.00002 },
    metadata: { anyroute_receipt_id: "gen-…", anyroute_lane: "attested", anyroute_disclosure: "attested" },
    store: false,
    "…": "instructions, tools, tool_choice, temperature, top_p and the other fields Responses clients read",
  },
  null,
  2,
);
const responsesRefusal = JSON.stringify(
  { error: { code: 400, type: "previous_response_id_not_supported", param: "previous_response_id", message: "`previous_response_id` is not supported. AnyRoute stores no responses, so there is no earlier turn to continue from. Send the whole conversation in `input` on every request…" } },
  null,
  2,
);
const rerankCurl = `curl ${BASE}/api/v1/rerank \\
  -H "Authorization: Bearer $ANYROUTE_API_KEY" -H "Content-Type: application/json" \\
  -d '{"model":"<rerank model>:floor","query":"How long do refunds take?","documents":["Shipping takes 3 to 5 days.","Refunds are issued within 14 days.",{"text":"Returns need a receipt."}],"top_n":2,"return_documents":true}'`;
const rerankResponse = JSON.stringify(
  {
    id: "<receipt id>",
    object: "rerank",
    model: "<rerank model>",
    provider: "<provider>",
    results: [
      { index: 1, relevance_score: 0.93, document: { text: "Refunds are issued within 14 days." } },
      { index: 2, relevance_score: 0.41, document: { text: "Returns need a receipt." } },
    ],
    usage: { total_tokens: 48, search_units: 1, cost: 0.002, cost_details: { upstream_inference_cost: 0.002, royalty: 0 } },
    meta: { billed_units: { search_units: 1 } },
    cost: 0.002,
    receipt: { id: "<receipt id>", sig: "…", key_id: "…", alg: "Ed25519", payload: { kind: "rerank", search_units: 1, documents: 3, "…": "" } },
  },
  null,
  2,
);
const ragCurl = `curl ${BASE}/api/v1/rag \\
  -H "Authorization: Bearer $ANYROUTE_API_KEY" -H "Content-Type: application/json" \\
  -d '{"documents":[{"id":"handbook","text":"Refunds are issued within 14 days of the return arriving. …"},{"id":"faq","text":"…"}],"question":"How long do refunds take?","model":"<chat model>","provider":{"lane":"attested"}}'`;
const ragResponse = JSON.stringify(
  {
    id: "<chat receipt id>",
    object: "rag.answer",
    model: "<chat model>",
    answer: "Refunds are issued within 14 days of the return arriving [1].",
    finish_reason: "stop",
    sources: [{ ref: 1, document_id: "handbook", chunk_index: 0, score: 0.71, start: 0, end: 212 }],
    receipts: [
      {
        step: "embeddings",
        receipt_id: "<embeddings receipt id>",
        model: "qwen/qwen3-embedding-8b",
        provider: "<provider>",
        lane: "attested",
        disclosure: "attested",
        cost: 0.0000011,
        tokens: { prompt: 105, completion: 0 },
        inputs: 3,
        upstream_attestation: { attested: true, gpu_attested: true, receipt_verified: true, kind: "aci/1", receipt_id: "<gateway receipt id>" },
      },
      { step: "chat", receipt_id: "<chat receipt id>", model: "<chat model>", provider: "<provider>", lane: "attested", disclosure: "attested", "…": "cost, tokens, upstream_attestation" },
    ],
    embedding_model: "qwen/qwen3-embedding-8b",
    lane: "attested",
    lane_source: "request",
    disclosure: "attested",
    retrieval: { documents: 2, chunks: 2, top_k: 2, chunk: { size: 1000, overlap: 150 }, embedding_calls: 1 },
    usage: { embedding_tokens: 105, prompt_tokens: 240, completion_tokens: 18, cost: 0.0000101, cost_usd: "0.0000101" },
  },
  null,
  2,
);
const ragRefusal = JSON.stringify(
  {
    error: {
      code: 503,
      type: "no_attested_endpoint",
      message: 'RAG stopped at the chat step: No endpoint for <chat model> that fits this request has a fresh, verified attestation, so lane "attested" cannot be served. Nothing was sent to any provider and nothing was charged. …',
      metadata: { step: "chat", lane: "attested", reason: "none_attested", receipts: [{ step: "embeddings", receipt_id: "<embeddings receipt id>", lane: "attested", "…": "the call that was made, and billed" }] },
    },
  },
  null,
  2,
);
const batchCurl = `curl ${BASE}/api/v1/batches \\
  -H "Authorization: Bearer $ANYROUTE_API_KEY" -H "Content-Type: application/json" \\
  -d '{"completion_window":"24h","requests":[{"custom_id":"row-1","method":"POST","url":"/v1/chat/completions","body":{"model":"<chat model>","messages":[{"role":"user","content":"Summarize: …"}],"max_tokens":200}},{"custom_id":"row-2","method":"POST","url":"/v1/chat/completions","body":{"model":"<chat model>","messages":[{"role":"user","content":"Classify: …"}]}}]}'

# Check on it, then read the results once status is completed
curl ${BASE}/api/v1/batches/$BATCH_ID -H "Authorization: Bearer $ANYROUTE_API_KEY"
curl ${BASE}/api/v1/batches/$BATCH_ID/output -H "Authorization: Bearer $ANYROUTE_API_KEY" > output.jsonl
curl ${BASE}/api/v1/batches/$BATCH_ID/errors -H "Authorization: Bearer $ANYROUTE_API_KEY" > errors.jsonl`;
const batchOutputLine = [
  JSON.stringify({ id: "batch_req_…", custom_id: "row-1", response: { status_code: 200, request_id: "<generation id>", body: { id: "<generation id>", choices: ["…"], usage: { "…": "tokens", cost: 0.0000162 }, receipt: { "…": "the signed receipt of this line" } } }, error: null }),
  JSON.stringify({ id: "batch_req_…", custom_id: "row-2", response: { status_code: 402, request_id: null, body: { error: { "…": "the error a normal call returns" } } }, error: { code: "insufficient_credits", message: "…" } }),
].join("\n");
const endpoints = [
  ["POST /api/v1/chat/completions", "Chat, tools and streaming (OpenAI/OpenRouter shape); X-Pay-With, X-Payment, X-Wallet-Auth headers"],
  ["POST /api/v1/completions · /embeddings", "Legacy completions; embeddings (prepaid keys)"],
  ["POST /api/v1/rerank · /v1/rerank", "Rerank documents against a query (Cohere and Jina shape: query, documents, top_n, return_documents), billed per token or per search unit, with a signed receipt; 404 model_not_found until a provider lists a rerank model"],
  ["GET /api/v1/models · /models/:author/:slug/endpoints", "Catalog, prices, policies, quantization, attestation (best class, manifest reference, policy hash) and datacenter region; per-provider health and attested policy hash"],
  ["GET /api/v1/generation?id=… · /generations", "Full generation record with receipt and anchor proof; your recent generations"],
  ["POST · GET · PATCH · DELETE /api/v1/keys", "Create a self-custodial key (no auth), or budgeted sub-keys with rpm/tpm, model allowlists, guardrails and a tracing destination"],
  ["GET /api/v1/key · /credits", "Current key; balance, held and total usage"],
  ["POST /api/v1/credits/deposit-tx · /withdraw-request", "Unsigned wallet transactions to deposit, or a key-signed withdrawal request"],
  ["GET /api/v1/credits/withdrawal-proof", "Merkle proof and calldata to finalize a withdrawal"],
  ["POST /api/v1/paywith/open · /close · /revoke · GET /session · /statement", "Stock Token sessions and monthly statements"],
  ["POST /api/v1/paywith/allowance/typed-data · /allowance · GET /charges · POST /charges/{id}/signature", "Wallet authorizations: a bounded allowance, or a signature per charge"],
  ["POST /api/v1/byok · /teams", "Bring your own provider key; team roles"],
  ["GET · POST · PATCH · DELETE /api/v1/routes", "Saved Routes: named routing policies you call as model \"@route/<slug>\", optionally pinned to the attested lane"],
  ["GET · PUT · DELETE /api/v1/presets/:name · /versions · /diff · POST /rollback", "Presets: versioned saved routes with a system prompt, tools and response_format, called as model \"@preset/<name>\" or pinned as \"@preset/<name>@<version>\""],
  ["POST · GET /api/v1/characters · GET · PUT · DELETE /characters/:id · GET /characters/:id/export · /greetings · /usage", "Characters: Tavern cards (V1, V2 or V3, as JSON or PNG) kept public, unlisted or private (sealed on your device), called as model \"@character/<id>\"; public discovery by tag and text; export as JSON or PNG; per-day calls and cost for the creator"],
  ["POST /api/v1/characters/:id/chat · /characters/group/next", "Chat with a character (chat completions plus greeting, regenerate, user_name and memory), on the attested lane when the model has one; pick the next speaker in a group chat"],
  ["POST · GET · DELETE /api/v1/memory · GET · PUT · DELETE /memory/:id · POST /memory/search", "Memory ledger for characters: entries encrypted on your device, stored as ciphertext under a scope the router cannot tie to a character; embeddings only with embedding_opt_in"],
  ["POST · GET · DELETE /api/v1/sessions · GET /sessions/current", "Agent Sessions: short-lived, budget-capped keys for agent runs"],
  ["GET /api/v1/spend · /spend/alerts", "Spend Watch: totals, projection, breakdowns, key budgets and alert rules"],
  ["GET /api/v1/disclosure/:providerId", "A provider’s documented retention, jurisdiction, legal hold and training use, each with a source and date, and the class it is served under now"],
  ["GET /api/v1/models?variant=…", "Open-weights variants (mainstream, native_low_refusal, abliterated) with license, base model and weights source; restricted variants list only attested endpoints"],
  ["POST /api/v1/creators/claims · /claims/{id}/verify", "Claim a model’s creator royalty by publishing a challenge in its Hugging Face repository"],
  ["GET /api/v1/blind/keys", "Blind tokens, where enabled: the issuer keys per epoch and denomination, the challenge every token carries, and prices"],
  ["POST /api/v1/blind/purchase", "Blind tokens, where enabled: buy tokens with credits by sending blinded messages; spend one with Authorization: PrivateToken on chat or embeddings"],
  ["GET /api/v1/ohttp/keys · POST /api/v1/ohttp/gateway", "Oblivious HTTP, where enabled: the gateway key configuration (application/ohttp-keys), and the gateway that unwraps message/ohttp-req sent by a relay and returns message/ohttp-res (and, where chunked Oblivious HTTP is on, message/ohttp-chunked-req and message/ohttp-chunked-res, sent as it is produced)"],
  ["GET /api/v1/ohttp/key-list · GET /api/v1/relays", "Oblivious HTTP, where enabled: the gateway key history signed with the receipt key, and the relays clients may use, by operator"],
  ["GET /tlog/checkpoint · /tlog/tile/…", "Transparency log, where enabled: the newest checkpoint (a signed note with the witnesses’ cosignatures) and the C2SP tlog-tiles hash tiles and entry bundles"],
  ["GET /api/v1/tlog · /tlog/proof · /tlog/consistency · POST /tlog/cosignatures", "Transparency log, where enabled: origin, log key, witnesses and quorum; an entry with its inclusion and consistency proofs; and where witnesses hand in cosignatures"],
  ["GET /api/v1/tlog/rekor · /tlog/rekor/key · /tlog/rekor/{size}", "Transparency log with Rekor anchoring, where enabled: the anchoring key (ECDSA P-256), the anchored checkpoints, and one checkpoint’s Rekor entry with its log index, integrated time, inclusion proof and signed entry timestamp"],
  ["GET /api/v1/holder", "$ANYR holders: balance, live tier (higher rate limits, lower fees), the tier ladder and free credits received"],
  ["POST /api/v1/receipts/verify · GET /receipts/keys", "Verify a receipt (v1, or v2 with its chain head and Merkle path); signing keys (JWKS)"],
  ["GET /api/v1/receipts/:id · /receipts/:id/proof", "A receipt by id, v2 beside v1 (?format=cose for the COSE bytes), with its privacy label beside the signed payload; the Merkle path to its hourly root, with anchored true only once that root is on chain"],
  ["GET /api/v1/receipts/:id/privacy", "What we saw: who could read the prompt, who saw the address, how it was paid, what was kept and what hardware answered, in plain English and as fields, computed from the signed receipt. Public by id"],
  ["GET /api/v1/host-anchors/proof/:leaf · POST /host-anchors/proof", "Where enabled: the Merkle path from a receipt a provider’s sidecar signed (by its leaf, or the receipt itself) to that host’s root, with the attestation reference and receipt key every leaf in the root was checked against; anchored true only once the root is on chain"],
  ["GET /.well-known/anyroute-receipt-keys.json", "The same signing keys at a fixed path, for clients that verify receipts themselves"],
  ["GET /api/v1/attestation/:providerId", "What the router has verified about a provider’s hardware attestation: status, verifiers, measurements, transparency-log and on-chain state, and what was not checked"],
  ["GET /api/v1/badge/:id.svg", "Attestation badge image for a provider id or a model id (attested, policy, vendor-forwarded or unverified), with the measurement and policy hash while attested and the share of 7 days with a fresh attestation; ?theme=dark. An unknown id is Unverified with a 404"],
  ["GET /api/v1/attestation/summary · /attestation/:providerId/history", "Proof-time: per attesting provider, the share of the last 24 hours and 7 days with a fresh attestation the router verified itself, measurement changes and the last failed check; and a provider’s recorded attestor, canary and probe events, newest first, paged by cursor. Failures are codes with fixed messages, never the provider’s own text. Kept for ATTESTATION_HISTORY_DAYS (30); 501 when it is 0"],
  ["GET /api/v1/measurements/key · /measurements/bundles/:providerId", "Where enabled: the key that signs measurement bundles (compose hash, source commit and tarball hash, model and image digests, MRTD allow-list), and a provider’s bundles with the transparency-log entry the router verified for each"],
  ["POST /mcp", "AnyRoute MCP: list_models, list_attested_models, chat (optionally on the attested lane), verify_provider, get_receipt and verify_receipt as tools for Claude, Cursor or any MCP client"],
  ["POST /v1/messages · /messages/count_tokens", "Anthropic Messages API (also under /api/v1) for the Anthropic SDKs and Claude Code: x-api-key or Authorization: Bearer; tools, images and streaming; the lane in X-Anyroute-Lane or provider.lane; the receipt in the reply and in X-Receipt-Id"],
  ["GET /ollama/api/tags · POST /ollama/api/chat · /generate · /embed", "Ollama API for Ollama clients (Open WebUI, Continue, the ollama libraries, LangChain): set the host to <router>/ollama and send the key as Authorization: Bearer; NDJSON streaming, tools, images, format and options; also /api/show, /api/version, /api/ps and /api/embeddings; the lane in X-Anyroute-Lane; the receipt in X-Receipt-Id and the closing line"],
  ["POST /v1/responses · /api/v1/responses", "OpenAI Responses API for the OpenAI Agents SDK, the Codex CLI and other Responses clients: the chat route’s billing, lanes and signed receipts behind the Responses shape and event stream. Stateless: store must be false, there is no previous_response_id and no GET; function and custom tools only"],
  ["POST · GET /api/v1/batches · GET /batches/:id · POST /batches/:id/cancel · GET /batches/:id/output · /batches/:id/errors", "Batch API (also under /v1): many chat or embeddings requests in one call, run in the background at 50% of the normal price within 24 hours; results as JSONL for 24 hours after the batch finishes (prepaid key)"],
  ["POST /api/v1/rag · /v1/rag","Answers from documents you send with the question, ranked in memory and stored nowhere: it embeds, ranks and answers through the embeddings and chat routes, and returns the sources and every call’s receipt (prepaid key; the lane and disclosure options of chat)"],
  ["GET /api/v1/rankings · /providers · /status", "Usage rankings and creator payouts; the provider registry with each provider’s attestation status (attestation.status, tee, verifiers, last_verified_at); router configuration, including its onion address where there is one"],
  ["GET /api/v1/status/slo · /status/incidents · /status/incidents.atom · .rss", "The status page (/status): per lane and API surface, availability over 1 hour, 24 hours, 7 days and 30 days, p50 and p95 latency, error counts, the SLO target (STATUS_SLO_PUBLIC 99.5%, STATUS_SLO_ATTESTED and STATUS_SLO_UNLINKABLE 99%), the 30-day error budget and 90 daily figures, cached for 30 seconds. The public lane is summed from public-lane request outcomes; the attested and unlinkable lanes use only the noisy hourly releases of /api/v1/stats (source: dp-noised). Incidents as JSON, Atom and RSS. The operator (ADMIN_TOKEN) opens incidents with POST /status/incidents, posts updates with POST /status/incidents/:id/updates and confirms or dismisses the suggestions the router records when a lane stays below target for five minutes (an hour on the private lanes)"],
  ["GET /api/v1/commerce/stats", "Where enabled (COMMERCE_STATS_ENABLED, default false): the commerce ledger behind /commerce. Settlements per receipt kind over 24 hours, 7 days and 30 days, gross and filtered side by side: only settlements whose receipts are anchored on ReceiptAnchor, without self-dealing (same owner, round trips within 24 hours, USDG funding links). Counts, sums and medians only, cached 60 seconds. Methodology: #commerce-stats"],
  ["GET /api/v1/skills · /skills/:id · /skills/:id/download · POST /skills/import · /skills/:id/install", "Secured Skills Hub for agent skills (a folder with SKILL.md, scripts and resources). Import from a git repository (https, at a ref, one folder) or an uploaded .tar.gz, .tar or .zip (SKILLS_MAX_BYTES, SKILLS_MAX_FILES). Each skill is normalised into one canonical tar and identified by its sha256, then scanned for data exfiltration (calls to hosts outside the allowlist, secrets or env values sent out, SSH keys, keychains, browser profiles, env dumps), prompt injection (instruction overrides, hidden or zero-width characters, instructions to send secrets), obfuscation, dangerous shell commands, untrusted package indexes and binaries. The report has a score, a level (trusted, caution or dangerous) and each finding with its rule, file, line and excerpt. Only trusted and caution skills download or install (SKILLS_DOWNLOAD_LEVELS); a dangerous or revoked one returns 403 with the report. A paid install debits the key's balance and credits the author 90% and the network fee 10% (SKILLS_FEE_BPS), once per account, with an Ed25519-signed receipt. The operator revokes with POST /skills/:id/revoke; SKILLS_SOURCES lists repositories and registry indexes the mirror job pulls. SkillRegistry records hashes and levels on chain. Scanned, not guaranteed: a clean scan is not proof a skill is safe"],
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
            <a href="/whitepaper/">AnyRoute Whitepaper</a>
            <a href="#whats-new">What’s new</a><DocsFeatureLinks />
            <a href="#quickstart">Quickstart</a>
            <a href="#routing">Routing</a>
            <a href="#presets">Presets</a>
            <a href="#characters">Characters</a>
            <a href="#tracing">Tracing</a>
            <a href="#teams">Teams</a>
            <a href="#disclosure">Disclosure</a>
            <a href="#lanes">Lanes</a>
            <a href="#tor">Tor</a>
            <a href="#private">Private proxy</a>
            <a href="#private-tokens">Private tokens</a>
            <a href="#key-log">Key log</a>
            <a href="#keep">What we keep</a>
            <a href="#lane">Lane</a>
            <a href="#payments">Payments</a>
            <a href="#x402">x402</a>
            <a href="#facilitator">Facilitator</a>
            <a href="#receipts">Receipts</a>
            <a href="#what-we-saw">What we saw</a>
            <a href="#council">Council</a>
            <a href="#mcp">MCP</a>
            <a href="#claude-unlinkable">Claude Code, unlinkable</a>
            <a href="#anthropic">Anthropic</a>
            <a href="#ollama">Ollama</a>
            <a href="#responses">Responses</a>
            <a href="#rag">Private RAG</a>
            <a href="#batches">Batch API</a>
            <a href="#rerank">Rerank</a>
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
          <DocsFeatureIndex />
          <KeyProvisioningDocs /> {/* ZK6 */}
          <ZkapiDocs /> {/* ZK9 */}
          <FacilitatorDocs /> {/* v6 F */}
          <SpendingLimitsDocs /><DefaultRouteDocs /><StarterSetupsDocs /><AgentRulebookDocs /><AgentBreakersDocs /><AgentAutonomyDocs />
          <StatementDocs /> {/* V87 */}<ProofPackDocs /> {/* U100 */}
          <MakeGoodDocs /> {/* V6 R */}
          <AgentLedgerDocs /><AgreementsDocs />
          <WebhookDocs/> {/* V86. */}
          <ToolsMarketDocs /> {/* v6 T */}
          <AgentAlertDocs />
          <AgentApprovalDocs />
          <AgentGuardDocs /> {/* V98 */}
          <TradingAgentDocs /> {/* B */}
          <AgentCertificateDocs /><AgentProfileDocs /><AgentIdentityDocs /><SealedAgentDocs />
          <h2 id="quickstart">Make your first API call.</h2> {/* ON2 */}
          <FirstCallDocs /> {/* ON2 */}
          <p>
            Anyroute accepts the familiar chat-completions request. Replace the base URL and key; requests, streaming, tools, provider preferences and usage fields work unchanged. Keys are self-custodial: POST /api/v1/keys (no account) returns a key and the hash to deposit USDG to.
          </p>
          <Code>{sampleRequest}</Code>
          <h2 id="routing">Make the route explicit.</h2>
          <p>
            The provider object supports order, allow_fallbacks, only, ignore, data_collection, zdr, quantizations, sort, max_price, require_parameters and preferred latency or throughput. Model suffixes :nitro, :floor, :free and :private work
            too. :nitro puts the fastest providers first (by measured throughput) and :floor the cheapest, exactly as provider.sort throughput and price do; a suffix wins over provider.sort. They only order the providers that your other preferences and your lane already allow, so
            provider.order still goes first and a lane never falls back outside itself. GET /api/v1/models lists them per model in routing_variants. models[] lists fallback models. The private flag is an Anyroute extension: it selects only providers with a fresh TEE attestation. By default providers are weighted by 1/price² × 30-day uptime × canary quality, and a
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
          <StructuredOutputDocs /> {/* V83: opt-in JSON checking. */}
          <h2 id="presets">Presets: config as code, with versions.</h2>
          <p>
            A preset is a saved route with a version history. It holds the same fallback models, provider preferences and sampling defaults as @route/&lt;slug&gt;, plus what a route may not hold: a system_prompt (up to 16,000 characters), a
            response_format and up to 32 tool definitions with a tool_choice. PUT /api/v1/presets/&lt;name&gt; saves the whole document. Each change adds an immutable version, numbered 1, 2, 3 and identified by the SHA-256 of its canonical
            JSON; saving the same content again adds nothing. Call the latest with model &quot;@preset/&lt;name&gt;&quot;, or pin one with &quot;@preset/&lt;name&gt;@3&quot; or a hash prefix of at least 7 characters. The response carries
            preset: name, version and hash.
          </p>
          <p>
            The request wins over the preset for every parameter, provider field, models list, tools and response_format it sets. For provider.lane and provider.disclosure the stricter of the two applies, as for a saved route. The
            system prompt is added as the first message only when the request has no system or developer message; a request with its own keeps it and gets no second one. Legacy /completions has no messages, so a preset with a system
            prompt, tools or a response_format is refused there (400 preset_unsupported). GET /api/v1/presets/&lt;name&gt;/versions lists the history, /diff?from=1&amp;to=2 returns a JSON diff (JSON Pointer paths with the old and new
            value), and POST /rollback with {"{"}&quot;version&quot;: 1{"}"} adds a new version with that content, so nothing is rewritten and every pin keeps resolving until the preset is deleted. A key or agent session allowed
            &quot;@preset/&lt;name&gt;&quot; may use that preset’s models. Limits: 100 presets per account, 100 versions per preset, 64 KB per version.
          </p>
          <Code label="PUT /api/v1/presets/support">
            {JSON.stringify(
              {
                description: "Support replies in one line",
                models: ["qwen/qwen3-32b", "meta-llama/llama-3.3-70b-instruct"],
                provider: { data_collection: "deny" },
                params: { temperature: 0.2, max_tokens: 200 },
                system_prompt: "You are the support assistant. Answer in one line.",
              },
              null,
              2,
            )}
          </Code>
          <h2 id="characters">Characters: one card, any model.</h2>
          <p>
            A character is a Tavern character card kept on the router. POST /api/v1/characters takes the card as JSON (card) or as a PNG that carries it (png, base64): V1 cards with flat fields, V2 (chara_card_v2) and V3 (chara_card_v3). In a PNG
            the ccv3 text chunk wins over chara. Each character gets an id (ch_ and 24 hex characters) and a card_hash, the SHA-256 of the card as canonical JSON. GET /characters/:id/export?format=json|png&amp;spec=v2|v3 gives the card back
            in a file SillyTavern and other card tools import.
          </p>
          <p>
            Visibility is public (listed in GET /api/v1/characters, which needs no key and filters by tag and q), unlisted (readable by anyone with the id, the default) or private. A private card is encrypted on your device with sealCard
            from @anyroute/client/characters: the router stores only the ciphertext and the card_hash, and never sees the name or the text. To chat with it, your client decrypts it and sends it in card; the router checks it against the
            card_hash (409 card_hash_mismatch) and uses it for that call only.
          </p>
          <p>
            Call a character from any OpenAI client with model &quot;@character/&lt;id&gt;&quot; on /chat/completions. The card becomes the prompt; the model that answers is models[0], or the character&apos;s default model.
            POST /api/v1/characters/:id/chat does the same with more options: greeting (0 is first_mes, 1 and up the alternate greetings), regenerate, user_name for {"{{user}}"}, session_id, and memory ({"{"} summary, facts {"}"}),
            which your client decrypted and which is used in memory and never stored. Lanes, budgets and signed receipts apply as on /chat/completions. The lane defaults to attested when the model has an attested provider, else public;
            x-anyroute-character-lane says which, and x-anyroute-character-note says why when attested was not available. A lane the request asks for wins. POST /characters/group/next picks who speaks next in a group chat (round_robin or
            named).
          </p>
          <p>
            The memory ledger keeps a character&apos;s long-term memory for you without reading it. Your client seals each entry (summary, fact, lorebook or state) as arm1.&lt;iv&gt;.&lt;ciphertext&gt; and files it under a scope it
            derives, an HMAC of the character id under your viewing key, so the router cannot tell which character a memory belongs to. POST /api/v1/memory stores an entry, GET lists sizes and kinds without the sealed values, and DELETE
            ?scope= clears a scope. Search by embedding (POST /memory/search) works only on entries stored with embedding_opt_in: true, and it is off by default: a vector is derived from the memory&apos;s text and can leak its topic.
          </p>
          <p>
            The creator of a public card sees GET /characters/:id/usage: calls and cost per day. Never what was said, and never who said it.
          </p>
          <Code label="SillyTavern · API Connections">{`API:                     Chat Completion
Chat Completion Source:  Custom (OpenAI-compatible)
Custom Endpoint:         ${BASE}/api/v1
Custom API Key:          your Anyroute key (sk-ar-v1-...)
Model ID:                @character/<id>`}</Code>
          <h2 id="tracing">Tracing: your spans, in your own tools.</h2>
          <p>
            Give a key a tracing destination and every public-lane call made with it is sent there as one span that follows the OpenTelemetry GenAI semantic conventions: gen_ai.system, gen_ai.request.model, gen_ai.response.model,
            gen_ai.usage.input_tokens and output_tokens, gen_ai.request.temperature and max_tokens, gen_ai.response.finish_reasons, plus anyroute.cost_usd, anyroute.receipt_id, anyroute.lane, anyroute.provider and the server latency. Send a
            W3C traceparent header and the span joins your trace. Set it with PATCH /api/v1/keys/&lt;hash&gt; and a tracing object; tracing: null turns it off.
          </p>
          <p>
            Prompt and completion text is exported only with include_content: true; it is off by default. Calls on the attested and unlinkable lanes are never exported, whatever the key says: those lanes promise that a call’s model, timing,
            size and cost do not leave the router tied to a key. The endpoint, headers and keys are encrypted at rest and never returned; GET shows the type, the host, the header names and export counters. Leave a secret out of a later PATCH
            to keep the stored one. Export runs after the response, from a bounded queue: a full queue drops and counts, failures are retried with backoff, and a destination that keeps failing is paused for a minute. Your calls are never slowed
            or failed by it. Destinations must be public https:// addresses.
          </p>
          <Code label="Honeycomb (OTLP)">
            {JSON.stringify({ tracing: { type: "otlp", endpoint: "https://api.honeycomb.io", headers: { "x-honeycomb-team": "YOUR_INGEST_KEY" } } }, null, 2)}
          </Code>
          <Code label="Grafana Cloud Tempo (OTLP)">
            {JSON.stringify({ tracing: { type: "otlp", endpoint: "https://otlp-gateway-prod-<region>.grafana.net/otlp", headers: { authorization: "Basic <base64 of instanceId:token>" } } }, null, 2)}
          </Code>
          <Code label="Langfuse (ingestion API; host defaults to https://cloud.langfuse.com)">
            {JSON.stringify({ tracing: { type: "langfuse", public_key: "pk-lf-...", secret_key: "sk-lf-...", host: "https://us.cloud.langfuse.com", include_content: true } }, null, 2)}
          </Code>
          <Code label="Helicone (custom log API; host defaults to https://api.worker.helicone.ai)">
            {JSON.stringify({ tracing: { type: "helicone", api_key: "sk-helicone-..." } }, null, 2)}
          </Code>
          <p>
            Any OTLP/HTTP collector works: /v1/traces is added to the endpoint unless it is already there, and the body is OTLP JSON. For a self-hosted Tempo or an OpenTelemetry Collector, expose its OTLP/HTTP receiver over https and put its
            auth in headers.
          </p>
          <SanctionsSection />
          <h2 id="teams">Teams: anonymous organisations with an audit log.</h2>
          <p>
            A team is an organisation with no email and no names. Its owner is the account that made it, a wallet, or a Safe: POST /api/v1/teams/&lt;id&gt;/owner/challenge returns a one-time message, and POST /owner checks the
            signature by recovery for a wallet or by EIP-1271 for a contract wallet (isValidSignature must return 0x1626ba7e, read on chain). A team made by a wallet-signed-in account is owned by that wallet from the start. The bound
            address signs in as owner.
          </p>
          <p>
            Roles: owner, admin (members, invites, keys and budgets), dev (creates keys in the team within its org budget), viewer (reads the team, usage, receipts and the audit log) and agent (API calls only, 403 on every team route).
            An admin makes a single-use invite (POST /invites, only its SHA-256 is kept). The invitee joins with a passkey (WebAuthn, attestation none, so only the public key is stored) or a wallet signature, and signs in the same way
            later with POST /api/v1/teams/&lt;id&gt;/sign-in. A sign-in returns a key that lasts 12 hours and has a limit of 0: it manages the team within the member&apos;s role, and a dev or admin creates API keys to call models. With
            budget_usd set, every key in the team needs a limit and the limits together must fit (409 org_budget_exceeded).
          </p>
          <p>
            Every change to members, invites, the owner, keys, budgets, presets, routes and lane settings is appended to the team&apos;s audit log, never prompt text. Each entry is chained to the one before it: hash = sha256(prev_hash
            bytes, then the canonical JSON of team, seq, at, actor, action, target and detail), starting from 64 zeros, with an RFC 6962 Merkle root per hour. GET /audit pages through it, GET /audit/roots lists the hourly roots and
            GET /audit/export?format=jsonl|csv downloads the chain. Anyone holding an export can check it with Node alone: an edited, dropped or reordered entry fails.
          </p>
          <Code label="Verify an audit export offline">{`node scripts/verify-audit.mjs anyroute-audit-<team>.jsonl --head <hash you saw>
OK  team team_…  42 entries  3 hourly roots  head 9f2c…`}</Code>
          <h2 id="disclosure">Route by what a provider discloses.</h2>
          <p>
            Each provider has a disclosure profile its operator documents: retention (attested, policy or logs), jurisdiction, legal-hold status and training use, each with a source and a date. Anything undocumented reads as the conservative
            default (logs, unknown). GET /api/v1/disclosure/:providerId returns the profile and the class the provider is served under right now. It reports what was documented and, for attested, what the router verified; it is not a guarantee of a
            provider’s behaviour.
          </p>
          <p>
            Set provider.disclosure (or the X-Anyroute-Disclosure-Max header) to none, policy or any, the default. none routes only to providers whose retention is declared attested and whose TEE attestation is fresh; policy also accepts a
            documented no-retention policy with no legal hold. provider.lane (or X-Anyroute-Lane) picks a privacy lane (see below); attested and unlinkable imply none, and if body and header are both set the stricter applies. When no
            provider meets a disclosure setting the request fails with 409 disclosure_unavailable, or 503 disclosure_provider_unavailable when qualifying providers are down; a lane that no attested endpoint can serve fails with 503
            no_attested_endpoint. It is never sent to a provider that does not qualify, and nothing is charged. A request with a disclosure setting or a lane never uses the response cache.
          </p>
          <p>
            Responses carry X-Anyroute-Disclosure (attested, policy or vendor-forwarded) and X-Anyroute-Lane, and the signed receipt records disclosure and lane. On a stream the header is sent only when every reachable provider shares one class; the
            receipt always states it. A development attestation is marked attestation_simulated and is refused in production. GET /api/v1/models?lane=attested lists the models that have an attested endpoint now.
          </p>
          <h2 id="lanes">Three privacy lanes.</h2>
          <p>
            Every request is served on one lane. public, the default, may use any endpoint. attested uses only endpoints whose retention is declared attested and whose hardware attestation the router verified recently. unlinkable adds two
            things on top of attested: the request arrives through an Oblivious HTTP relay (or over Tor through the router’s onion service, where the router serves the lane that way), and it is paid with a blind token, so the router cannot tie the payer or the address to the prompt. Pick one with provider.lane or the X-Anyroute-Lane
            header. A key can carry a default (routing.provider.lane on PATCH /api/v1/keys/:hash), which a lane named in the request replaces. A saved route can pin a lane too (config.provider.lane, public or attested); there the stricter of the route and the request applies, as described below. A request that arrives through
            an independent relay with a blind token and names no lane is served on unlinkable.
          </p>
          <p>
            On attested and unlinkable there is no fallback. If no endpoint of the model has a fresh, verified attestation, the request fails with 503 no_attested_endpoint and error.metadata.reason none_attested; if attested endpoints exist but are
            all down, the reason is attested_endpoints_down and Retry-After is set. Nothing is sent to any other endpoint and nothing is charged. provider.order, only and ignore still apply inside the lane, but they cannot bring back an endpoint the
            lane excludes. On unlinkable, an API key or a wallet is refused with 403 lane_requires_anonymous_auth, because both name the payer; set provider.lane_downgrade (or X-Anyroute-Lane-Downgrade) to attested to be served on the attested lane
            instead, never on public.
          </p>
          <p>
            Within a lane the router picks among endpoints by weight: uptime times quality times attested_bonus, divided by the square of the price relative to the cheapest endpoint. attested_bonus is 1.25 on public, so an attested endpoint is
            preferred at equal price, and 1 on the other two lanes, where every endpoint is attested. Ties break by stake, then provider id. GET /api/v1/models lists lanes for each model and each endpoint, GET /api/v1/models?lane=attested keeps the
            models that can be served on that lane now, and GET /api/v1/status reports a lanes section with how many models and endpoints each lane has.
          </p>
          <p>
            Ordinary chat on attested and unlinkable terminates TLS at the router, which reads the prompt in memory before sending it to the enclave over a connection pinned to its attested key. The host outside the enclave cannot
            read it; the router can. The separate <a href="#e2ee-phala">encrypted-chat adapter</a> forwards client-encrypted content through the router to the attested gateway enclave. Direct sidecar HPKE is also available in the SDK; the ordinary chat route does not carry that format.
          </p>
          <Code label="503 · no attested endpoint">{laneRefusal}</Code>
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
            A request that carries an API key or a wallet is refused with 403 lane_requires_anonymous_auth. A direct request for the lane is refused with 403 unlinkable_requires_relay and says what to do; through the gateway without a token it
            is 401 (unlinkable_requires_token) with the token challenge, and 403 through a relay run by the router’s own operator. With no attested endpoint it is 503 no_attested_endpoint, and the token is not spent. What is hidden: the relay sees your address and an encrypted request; the router sees the request and the relay, never your address; the token’s purchase cannot be tied to its use. What is not: a relay that
            cooperates with the router can join the two, timing and message sizes can be correlated (responses are padded), and any identifier you put in the request body reaches the provider.
          </p>
          <p>
            A message/ohttp-req response is encrypted as a whole, so stream: true sent that way is refused with 400 stream_unsupported. Where the router also enables chunked Oblivious HTTP (draft-ietf-ohai-chunked-ohttp),
            GET /api/v1/relays lists gateway.chunked, and a request sent as message/ohttp-chunked-req is answered with message/ohttp-chunked-res: the response is encrypted and sent chunk by chunk as the router produces it, so a streamed
            completion arrives token by token while the relay still carries only ciphertext. The relay has to carry it too (RELAY_CHUNKED_ENABLED in relay/); it passes each chunk on as it arrives, under the same size limit and timeout. The
            last chunk is sealed as the final one, so a client can tell a response that was cut off from a complete one; the TypeScript SDK’s obliviousFetch (@anyroute/client/ohttp) decrypts each chunk as it arrives and fails with
            ohttp_truncated when the final chunk never came and ohttp_decrypt_failed when a chunk was altered or reordered. Chunk sizes and their timing stay visible to the relay.
          </p>
          <Code label="TypeScript SDK · a streamed completion on the unlinkable lane, through a relay">{sdkOblivious}</Code>
          <p>
            A router can also serve the lane over Tor instead of a relay: see <a href="#unlinkable-tor" className="inline-link">the unlinkable lane over Tor</a>. GET /api/v1/status says which paths it serves in lanes.unlinkable.via
            (&quot;ohttp&quot;, &quot;onion&quot; or both).
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
            unlinkable lane a relay, or this onion service where the router serves the lane over Tor (below). Requests that arrive over Tor have no address the router can limit, so calls without an API key (unkeyed chat and embeddings, new keys, wallet sign-in challenges) share limits with everyone else using the
            onion address, and a call with a key is limited per key as usual: use a key or a token for a quota of your own. The first request can take several seconds while Tor builds its circuit. A relay operator can also reach a gateway’s onion address through a
            SOCKS5 proxy (RELAY_SOCKS5_PROXY in relay/), so the gateway never sees the relay’s address either.
          </p>
          <h3 id="unlinkable-tor">The unlinkable lane over Tor, where the router enables it</h3>
          <p>
            Where the router serves it (GET /api/v1/status: lanes.unlinkable.available is true and lanes.unlinkable.via includes &quot;onion&quot;), lane unlinkable also works over Tor, with no relay. Four steps: take the onion address from
            onion.url in the status; buy blind tokens ahead of time with your key (buyTokens from @anyroute/client/blind, below); send each call to the onion address through Tor with Authorization: PrivateToken token=&lt;one token&gt; and the lane
            named, in provider.lane or X-Anyroute-Lane; and read X-Anyroute-Lane and the receipt, which say unlinkable. A call that names no lane is served on public, as before, so name it. Streaming works as on the clearnet, because Tor carries
            ordinary HTTP.
          </p>
          <p>
            The rules are those of the lane everywhere: attested providers only, with no fallback (503 no_attested_endpoint, and the token is not spent); an API key, a wallet or a per-call payment is refused with 403 lane_requires_anonymous_auth, unless
            you allow the downgrade to attested; no token is 401 unlinkable_requires_token. The same call to the clearnet address is refused with 403 unlinkable_requires_relay. Only the onion service can mark a call as coming over Tor: it adds a
            secret header the router checks, and removes any copy a client sends, so sending that header yourself changes nothing.
          </p>
          <Code label="Buy tokens (TypeScript SDK)">{torBuyTokens}</Code>
          <Code label="Spend them over Tor (SOCKS5 on 127.0.0.1:9050)">{torUnlinkable}</Code>
          <p>
            What is hidden: Tor takes the place of the relay. Your connection crosses three Tor relays run by volunteers before it meets the onion service, so neither the onion service nor the router ever learns your network address, and on onion
            calls the router reads no address header and keeps no per-address limit (a blind-token call counts against one bucket shared by everyone using the onion address). The token cannot be tied to its purchase. What is not: the router runs the
            onion service, sees the request in plaintext and sees its size and timing directly, as it sees the request on the relay path; an observer who can watch both your connection into Tor and the router’s side can match them by timing; calls
            sent on one circuit can be linked to each other, so give calls you want kept apart their own circuit (a different SOCKS user name, as above, or Tor Browser’s New Identity); buying tokens right before spending them links the two by
            time; and anything in the body that identifies you reaches the provider. The separate <a href="#e2ee-phala">encrypted-chat adapter</a> supports Tor with blind tokens; ordinary chat still exposes text to the router.
          </p>
          <NetworkPolicyDocs />
          <E2eeDocs />
          <PrivateProxyDocs />
          <ClaudeUnlinkableDocs />
          <h2 id="private-tokens">Private tokens from your wallet, kept on your device.</h2>
          <p>
            The <a href="/tokens/" className="inline-link">Private tokens</a> page turns a payment from your own wallet into blind tokens that stay in your browser, with no account and no long-lived key. It adds nothing on the router: it uses only the endpoints
            documented here. Every step runs in the page. It makes a one-time key (POST /api/v1/keys, no credential), keeps it in memory and in that tab&rsquo;s session storage only, and you pay it from your wallet: USDG to the key&rsquo;s hash through the Credits contract, or
            $ANYR to the escrow address. $ANYR is a payment method here, not a claim on anything: escrow credits the wallet that sent it, at the pool&rsquo;s time-weighted average price (the lower of spot and the average) minus the haircut and up to the per-deposit limit
            in GET /api/v1/status escrow.anyr, so for $ANYR the page signs you in with one signature to a fresh key on your wallet&rsquo;s account and turns only the newly credited amount into tokens. When the credit is there it blinds the tokens in the browser
            (RFC 9474, the suite the router signs with), buys them with POST /api/v1/blind/purchase, unblinds the signatures, keeps the tokens in IndexedDB, and offers them as a token file. Last, it switches the one-time key off at the router (PATCH /api/v1/keys/&lt;hash&gt; with
            disabled), overwrites the copy in memory and removes the stored copy. A purchase that is interrupted is finished by sending the same request again, which the router does not charge twice; a token is not shown as bought until its signature verifies.
          </p>
          <p>
            What stays linkable: the payment is a public transaction that names your wallet, the router records that the one-time key (or, for $ANYR, your wallet&rsquo;s account) spent an amount on tokens, and your network address and the time of purchase are visible unless you
            use the onion address. What does not: which prompts a token later paid for, because the router signs tokens blind. Tokens hide who pays, not the request: ordinary chat reads request text in router memory; the encrypted-chat adapter forwards ciphertext. A token pays for one call up to its value, the unused
            part is not returned, and it stops working after its <code>redeem_until</code>. The page works at the router&rsquo;s onion address because every request it makes is relative to the address it was opened from; a browser wallet is often missing in Tor Browser, so the USDG route
            also shows the key hash to pay from any wallet app.
          </p>
          <Code label="The token file (anyroute-tokens.json)">{tokenFileExample}</Code>
          <p>
            The file is one JSON object, the same one the <a href="#private" className="inline-link">private proxy</a> keeps at ~/.anyroute/tokens.json. <code>version</code> is 1. Each entry in <code>tokens</code> has the finished <code>token</code> (the value after <code>PrivateToken token=</code>: 354 bytes of Privacy
            Pass token type 0x0002, base64url), the <code>key_id</code> it was signed under, its size and epoch, its value and its <code>redeem_until</code>, and when it was bought (the page writes the day, not the minute). <code>unconfirmed</code> holds tokens a tool sent without ever
            learning the outcome; they are not used again. The file holds no key, wallet address or account. A reader checks each token&rsquo;s layout and that its <code>key_id</code> is the one inside the token, and refuses a version it does not know. A tool that spends a token removes
            it from the file. Keep it readable by you only (mode 0600): anyone who has the file can spend its tokens. @anyroute/client reads and writes it with no optional dependency, and <code>mergeTokenFiles</code> adds a download to a file you already have.
          </p>
          <Code label="Read the file and spend a token (TypeScript SDK)">{tokenFileSdk}</Code>
          <Code label="Merge a download and spend one token with curl (SOCKS5 on 127.0.0.1:9050)">{tokenFileMerge}</Code>
          <h2 id="key-log">A witnessed log of every key, where the router enables it.</h2>
          <p>
            Where the router runs its transparency log, every key and configuration a client encrypts to or verifies against is appended to one append-only Merkle log: receipt signing keys, Oblivious HTTP key configurations, blind-token issuer keys,
            measurement bundles once their Sigstore entry checks out, and the key bindings of each sidecar whose hardware quote the router’s quote verifiers accepted. The log uses the C2SP formats: tiles at /tlog/tile/, the newest checkpoint at
            /tlog/checkpoint as a signed note, and witnesses that cosign a checkpoint (cosignature/v1) only after checking a consistency proof from the last one they cosigned. A history shown to one user that differs from the one the witnesses saw
            cannot collect their cosignatures, unless the quorum of witnesses colludes with the log. GET /api/v1/tlog names the log, its witnesses and the quorum; scripts/tlog-witness.ts in the repository is a minimal witness anyone can run.
          </p>
          <p>
            The check is opt-in in @anyroute/client. With transparency set, a receipt verifies only if its signing key is in the log under a checkpoint cosigned by the quorum of the witnesses you pinned, and consistent with every checkpoint the
            client saw before; client.transparency.requireLogged() does the same for any other key and refuses a key that is not logged. Two checkpoints of the same size with different roots, or a newer tree that does not extend an older one, raise
            SplitViewDetected with both notes as evidence. Mirrors of the checkpoint can be added as a second path. Pin the log key and the witness keys from a source other than the log: the log’s own description of itself proves nothing.
          </p>
          <Code label="TypeScript · witnessed keys">{sdkTransparency}</Code>
          <p>
            A log can also be checked through Sigstore’s public Rekor log instead of witnesses (TLOG_REKOR_ENABLED). Each time the checkpoint changes, and at most once every ten minutes, the router records it in Rekor as a hashedrekord entry: the SHA-256
            of the checkpoint as the log signed it (the checkpoint text, a blank line and the log’s own signature line) with an ECDSA P-256 signature by a dedicated anchoring key. It verifies the entry’s inclusion proof before it serves it. GET
            /api/v1/tlog/rekor lists the anchored checkpoints with each entry’s uuid, log index, integrated time, inclusion proof and signed entry timestamp, and links each one to search.sigstore.dev; GET /api/v1/tlog/rekor/key serves the anchoring
            key. Rekor is run independently of Anyroute, so showing some users a second history needs a second entry under the anchoring key, which anyone can see there, and which the router’s own list does not explain. That detects a split view after
            the fact; unlike a witness quorum, it does not stop the log from signing a bad checkpoint before clients see it, and it helps only when clients or monitors check Rekor. In production the router starts the log only with the witness quorum
            or with anchoring on.
          </p>
          <p>
            With transparency.rekor set to the anchoring key and Rekor’s key, @anyroute/client accepts a checkpoint on a verified Rekor entry in place of cosignatures: the entry must hold the hash of exactly that checkpoint, carry the pinned anchoring
            key and a valid signature by it, and be included in Rekor under a checkpoint that Rekor’s pinned key signed. The consistency check against the last checkpoint the client accepted, and the refusal of keys that are not logged, stay the same.
            With witnesses listed as well, both must hold.
          </p>
          <Code label="TypeScript · Rekor-anchored keys">{sdkRekorAnchor}</Code>
          <h2 id="keep">What we keep, generated from the schema.</h2>
          <p>
            The <a href="/keep/">What we keep</a> page lists every table and column the router stores, each with what it holds, whether it is recorded per request, how long it lives where the code says, and, for any column whose name or type suggests request
            content or a network address, a written review. It also lists the Redis keys with their lifetimes and which ones contain a caller’s address, what the application log can carry, and every place in the source that reads a request body or a
            caller’s address. It is generated from the schema and the descriptions in src/privacy when the site is built, and the router’s suite fails when a table or column has no description, a description names something that is not there, or a column
            that looks like request content or an address has no review.
          </p>
          <p>
            GET /keep/inventory.json is the exact file the page is built from, as canonical JSON. Its SHA-256 is shown on the page with the commit the site was built from, and, where an operator sets TLOG_DATA_INVENTORY next to TLOG_ENABLED, the router
            appends it to the key log as a data_inventory entry the first time a router with that inventory starts. The page shows the log entry, and the Rekor entry of a checkpoint that includes it, when they exist. The inventory says what is kept, not who
            can read a request in flight: on every lane ordinary chat reads request text in router memory; encrypted chat forwards ciphertext to the attested gateway.
          </p>
          <Code label="Shell · check the inventory">{keepCurl}</Code>
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
          <FastCreditDocs/> {/* V97 */}
          <GetUsdgDocs/> {/* ON1 */}
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
            Per-call payment is not switched on at anyroute.tech yet: calls without a key get 401 there, and GET /api/v1/status shows per_call.configured. 
            Where the router has x402 enabled, any x402 client or agent can pay for a call in USDG on Robinhood Chain (chain id 4663) with no account and no API key. Send the request without credentials: the 402 response is an x402 v1 body
            (x402Version, error, accepts) with one exact-scheme requirement, and the same requirement as an x402 v2 PaymentRequired in the PAYMENT-REQUIRED header (base64 JSON). Sign the USDG authorization it describes, retry the identical
            request with an X-PAYMENT header (v1) or a PAYMENT-SIGNATURE header (v2), and the router verifies the signature, amount, recipient, time window and nonce, relays the transfer (it pays the gas) and serves the call. Chat,
            completions and embeddings all work this way; GET /api/v1/status reports per_call.x402.configured, and per_call.x402.versions, networks and headers say what it reads and writes.
          </p>
          <ul>
            <li>
              <b>Requirement.</b> scheme exact, asset USDG, payTo the router’s receiving address, maxAmountRequired in USDG base units (6 decimals) from the same per-call price as the CallPay quote (worst case for this request, including the 1% margin), and extra
              carrying USDG’s EIP-712 name and version plus the numeric chainId.
            </li>
            <li>
              <b>Network name.</b> x402 v1 names chains with lowercase hyphenated strings and has no Robinhood Chain entry, so the v1 requirement says robinhood-chain; the v2 header uses the CAIP-2 name eip155:4663. A payment may name either. A v1
              client that only knows built-in networks needs that name mapped to chain 4663, or a v2 client with an eip155 handler.
            </li>
            <li>
              <b>x402 v2.</b> A v2 PaymentPayload carries x402Version 2, the resource, the requirement it accepted (scheme exact, network eip155:4663, amount in USDG base units, asset, payTo) and the same EIP-3009 authorization and signature
              under payload. Send it base64-encoded in PAYMENT-SIGNATURE. The router reads X-PAYMENT and PAYMENT-SIGNATURE alike, so a v1 and a v2 client can pay the same router.
            </li>
            <li>
              <b>Response.</b> The paid response carries the settlement (base64 JSON with success, transaction, network and payer) in both X-PAYMENT-RESPONSE and PAYMENT-RESPONSE, and the signed receipt records the same transaction as payment_tx.
              Its network field names the chain the way the payment did.
            </li>
            <li>
              <b>Change.</b> The whole payment is credited to the paying wallet’s account and the call is charged from it, so anything unused stays there as credit you can spend with X-Wallet-Auth. Paying more than maxAmountRequired is allowed; nothing is refunded on-chain.
            </li>
            <li>
              <b>Rejections.</b> A payment that fails verification gets a 402 whose error is a reason such as invalid_exact_evm_payload_authorization_value (underpaid), invalid_exact_evm_payload_recipient_mismatch, invalid_exact_evm_payload_authorization_nonce_used
              (replayed) or invalid_exact_evm_payload_signature, together with fresh requirements in the body and in PAYMENT-REQUIRED. A transfer that fails on-chain is settle_exact_failed, with PAYMENT-RESPONSE success false. Nothing moves
              on-chain for a rejected payment.
            </li>
          </ul>
          <Code label="x402 client (JavaScript, viem)">{x402Example}</Code>
          <h3 id="x402-recovery">Payment recovery: a lost answer is never paid for twice</h3>
          <p>
            If a paid answer is lost on the way back (a timeout, or a 502, 503 or 504 from something between you and the router), send the identical request again with the same X-PAYMENT or PAYMENT-SIGNATURE and a PAYMENT-RECOVERY header: the
            payer&rsquo;s EIP-191 (personal_sign) signature of anyroute:x402-recovery:4663:&lt;payer&gt;:&lt;nonce&gt;, with the paying wallet&rsquo;s address and the authorization nonce in lowercase hex. The router sends the answer it kept for
            that payer and nonce again, byte for byte, with the same settlement headers, and never relays the payment a second time. It works on chat, completions, embeddings, rerank and character chat; through the Responses and Ollama
            adapters the kept chat answer is converted again. GET /api/v1/status reports per_call.x402.recovery.
          </p>
          <ul>
            <li>
              <b>Refusals.</b> A signature by anyone but the payer is a 401 invalid_payment_recovery. A different request is a 409 payment_request_mismatch. When nothing is kept, the answer is a 404 payment_recovery_not_found whose metadata.settled
              says whether the payment was settled; if it was, nothing was charged twice and what the call did not use stays as change on the wallet account. Recovery never settles a payment that was not settled.
            </li>
            <li>
              <b>What is kept, for 24 hours.</b> The answer, sealed with AES-256-GCM under a key derived from the router&rsquo;s secret, the payer, the nonce and the request&rsquo;s hash, in Redis and never in the database; and a row with the payer, the
              nonce, the SHA-256 of the request and of the answer and the name of the Redis key. The sealed answer expires in Redis after 24 hours, and an hourly expiry deletes older rows. A non-streamed paid call is finished even if you
              disconnect, so its answer can be recovered; a stream is kept only if it reached its end. Answers over 8 MiB are not kept.
            </li>
          </ul>
          <Code label="Recover a lost x402 answer (JavaScript, viem)">{x402RecoveryExample}</Code>
          <h2 id="receipts">The response is only the beginning.</h2>
          <p>
            Every generation returns normalized usage and a signed receipt with hashes of the request and response (never their content), in two encodings: v1 (JSON, Ed25519) and v2 (a COSE_Sign1 signed EdDSA with the same key, with token
            counts in buckets such as 512-1024 and no payer). A stream commits to every event as it goes: after each one comes a comment line, <span className="mono">: anyroute-chain &lt;i&gt; &lt;hash&gt;</span>, that SSE parsers skip, and the v2
            receipt signs the last hash, so a cut or altered stream shows. Receipts are rooted in hourly Merkle batches and GET /api/v1/receipts/&#123;id&#125;/proof returns the path. A root is posted to ReceiptAnchor on Robinhood Chain only
            where the router runs with a configured chain; otherwise it stays off chain and the proof says anchored: false. Signed is not the same as anchored: the dashboard and /api/v1/receipts/verify report each separately.
          </p>
          <p>
            Receipts a provider’s sidecar signs with its enclave key can be anchored per host. Where the router runs with host anchoring on, it collects each attested host’s receipt leaves once an interval (an hour by default) over
            the connection pinned to that host’s attested certificate. It takes the receipt key from the host’s boot quote only when SHA-256 of that quote is the attestation reference it verified and the quote commits to the key, keeps only
            leaves whose signature verifies under that key and that name that attestation, and roots them per host and interval. Each root is stored with the attestation reference and, where a chain is configured, posted with
            ReceiptAnchor.anchorAttested under keccak256 of the provider id; otherwise it stays off chain. GET /api/v1/host-anchors/proof/&#123;leaf&#125;, or POST /api/v1/host-anchors/proof with the receipt, returns the root, the path, the
            attestation reference, the receipt key and the status: anchored: true with the transaction, block and attested anchor index once the root is on chain, anchored: false while it is not.
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
          <p>Both GET /api/v1/models and /v1/models add provider_names and capabilities: vision (Reads images), imageOut (Makes images), audio, tools, longContext (at least 128,000 tokens), attested (Proven hardware), network (AnyRoute network) and encrypted (Encrypted chat). Network tags require a live, freshly attested host offer for its admitted model. Encrypted chat requires the separate enabled gateway path with fresh evidence and the exact model ID; ordinary Harness chat remains readable by the router. Older responses derive only the tags their fields establish.</p>
          <Code label="GET /api/v1/models (new fields)">{modelAttestation}</Code>
          <h2 id="what-we-saw">What we saw: a privacy label for every receipt.</h2>
          <p>The output facet reads usage.unit_type and usage.units: token (the default for older receipts) covers text and embeddings, image_mp images, video_sec video, audio_sec voice and audio, call tools or search, and gpu_sec computation or fine-tuning. Units describe metering, not every input modality or which operation ran. A token call can include image references. Ordinary chat reads request text in router memory on every lane; the encrypted-chat adapter forwards ciphertext. For media, generation records keep request and output hashes, not the media itself; metering does not establish retention outside that record or by a provider. A call unit alone does not prove a search query was sent, and GPU time does not prove training data or weights were deleted. Unfamiliar units report content and address handling as unrecorded. Council labels include members and the judge; RAG has separate embedding and chat receipts. The response cache keeps the encrypted reply, never the prompt itself; semantic caching keeps a hashed word vector. Batch content is kept sealed outside the database; requests are deleted when the batch finishes and answers when results expire. Failed-provider errors can retain a short sanitized fragment of a rejected request, and unexpected library errors can quote fragments in logs. See <a href="/keep/" className="inline-link">What we keep</a> for these limits.</p>
          <p>
            GET /api/v1/receipts/&#123;id&#125;/privacy reads a receipt back in plain English: who could read the prompt, who saw your network address, how the call was paid, what the router kept and what hardware answered. It is public by id, like the receipt.
            The router works it out from the receipt’s signed fields (lane, disclosure, mode, payer, nullifier, attestation and, for an attested gateway, upstream_attestation) and from what its code does for that combination. A field a receipt does not carry is
            reported as not recorded and never assumed to be favourable. GET /api/v1/receipts/&#123;id&#125; returns the same label as privacy, beside the signed payload and never inside it, so nothing that is signed changes. The MCP chat tool returns the
            summary with its result, the Telegram bot puts a one-line form above each answer’s footer, and <a href="/verify/" className="inline-link">the verify page</a> shows the label for a receipt id at /verify/?r=&lt;receipt id&gt;.
          </p>
          <ul>
            <li>
              <b>Who could read the prompt.</b> The router reads ordinary chat prompts in memory on every lane. With the encrypted-chat adapter, correctly encrypted content is decrypted in the gateway enclave; the router sees ciphertext and clear metadata. The gateway forwards restored content to the serving workload over a separate confidential channel. The label calls that an attested enclave only when the receipt shows the router had verified the provider’s hardware
              attestation and, for an attested gateway, that the gateway’s signed receipt for the exchange checked out. Otherwise it is a provider that documents a no-retention policy no hardware backs, or one that may keep the prompt under its own terms. When the router
              withheld a reply because that check failed, the label says the provider had already read the prompt.
            </li>
            <li>
              <b>Who saw your address.</b> On the unlinkable lane, nobody at AnyRoute: the lane is served only to requests that arrive over Tor (or through an independent relay), and a direct request is refused before it is served. On any other lane AnyRoute’s servers saw the
              address the request came from. Its software writes that address to no table: the record of a call has no column for it. A call with no API key (a blind token, a wallet or an x402 payment) is rate-limited per address, so for about a minute the address is the key of a
              counter; a call with a key is limited per key and uses no address. What the network provider that hosts the router logs is outside what a receipt can show, and the label says so.
            </li>
            <li>
              <b>How it was paid.</b> An API key’s balance, Stock Token pay-with, your own provider key, a blind token, a wallet or an x402 payment, and so what the receipt names: a key hash, a wallet address, or only the hash of a spent token. A blind token is signed blind,
              so the token itself cannot be matched to its purchase; the timing and size of purchases and spends can still hint at a link.
            </li>
            <li>
              <b>What was kept.</b> Token counts, cost, timing, SHA-256 fingerprints of the request and the reply, the payer as above, the providers tried and a ledger line for the charge. There is no column for a prompt, a reply or an address. The response cache is
              opt-in and holds an encrypted copy until it expires; it is never used on the attested or unlinkable lanes or with a blind token. Anyone who has a receipt’s id can read the receipt.
            </li>
            <li>
              <b>What hardware answered.</b> Attested only where the receipt says so and the check behind it passed; the TEE type comes from the router’s attestation record for the receipt’s attestation hash; GPU only where the gateway’s receipt asserted it. A
              development report is labelled as one and is never called attested.
            </li>
          </ul>
          <Code label="GET /api/v1/receipts/{id}/privacy · attested lane, paid from a key">{JSON.stringify(privacyExample, null, 2)}</Code>
          <p>
            The label reads a receipt; it does not check it. Verify the signature first (POST /api/v1/receipts/verify, the verify page or an SDK), then compute the label on your side: privacyLabel(receipt) in @anyroute/client gives the router’s label for any receipt you hold
            (pass teeKind if you know the attestation’s TEE type), and fetchPrivacyLabel(baseUrl, id) reads the router’s.
          </p>
          <h2 id="council">Ask several models, or the same one twice.</h2>
          <p>
            Two opt-in modes, available when the router enables them (the ANYROUTE_FEATURE_COUNCIL setting, off by default). Neither streams. Every call they make is routed, billed and receipted like a request of its own, and the worst case of all of
            them is held before anything is sent, so your balance and key budget bound the whole request. Your provider preferences, including a disclosure ceiling or lane, apply to every call, the judge included: a member with no provider that meets them refuses the request (409, or 503 no_attested_endpoint on a lane) instead of being dropped or downgraded. The disclosure header and the top-level receipt show the weakest class among the calls; each member’s receipt shows its own.
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
            attested provider refuses the whole request with a 503 (no_attested_endpoint, and error.metadata.council_seat says which seat); nothing is sent, held or charged. Each call’s signed receipt then has an
            attestation_ref: the hash of the attestation report the router verified for the provider that served it, and the TLS key its connection was pinned to (tls_pin is null for a provider that did not attest through a self-signed certificate).
            The response’s council field adds attested and attestation_refs (members in order, then the judge), and both are signed in the top-level receipt, so changing a reference breaks its signature. attested is true only when every call was served
            under the attested class. These are the router’s own records, the same ones behind GET /api/v1/attestation/{"{providerId}"}; they show what was running and pinned, not what it did with your prompt.
          </p>
          <Code label="Attested council request">{attestedCouncilRequest}</Code>
          <Code label="Attested council response (abridged)">{attestedCouncilResponse}</Code>
          <p>
            Dual verification with provider.lane set to attested sends the two calls to two different attested providers of the model. Both receipts carry the agreement bit, and the verification field and each receipt add attested and the two
            attestation references. If the model has fewer than two attested providers the answer is 409 verification_unavailable with one, or 503 no_attested_endpoint with none, and nothing is sent or charged. Agreement still only shows that two providers
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
            such a provider, and when none can answer the call fails (503 no_attested_endpoint) with nothing sent and nothing charged. The result reports the lane, the disclosure class the signed receipt records and, when the provider is an attested gateway,
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
          <h2 id="anthropic">Use AnyRoute from Claude Code and the Anthropic SDKs.</h2>
          <p>
            The router speaks the Anthropic Messages API: POST /v1/messages (also under /api/v1) and POST /v1/messages/count_tokens. A client written for that API, such as the Anthropic SDKs or Claude Code, works with an Anyroute key and an Anyroute
            model. The request is converted to a chat completion and sent through /api/v1/chat/completions inside the router, so the key, its balance and limits, the lane, the signed receipt and the response headers are those of a chat call. Anyroute serves open models, not
            Anthropic’s, so choose a model from GET /v1/models. This is a compatibility layer over the Messages API, not an Anthropic service: how well an agent such as Claude Code works depends on the model you choose, and it needs reliable tool calling and a long context.
          </p>
          <h3>Claude Code</h3>
          <p>
            Point ANTHROPIC_BASE_URL at the router and put your Anyroute key in ANTHROPIC_AUTH_TOKEN (sent as Authorization: Bearer) or ANTHROPIC_API_KEY (sent as x-api-key); the router accepts both. Claude Code names Anthropic models for its main, subagent and background
            calls, so set ANTHROPIC_MODEL and the ANTHROPIC_DEFAULT_SONNET_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL and ANTHROPIC_DEFAULT_HAIKU_MODEL variables (and CLAUDE_CODE_SUBAGENT_MODEL) to Anyroute model ids. Claude Code assumes a 200K context for a model it does not know;
            if your model has less, set CLAUDE_CODE_AUTO_COMPACT_WINDOW to its window. Keep the key out of a project’s committed .claude/settings.json.
          </p>
          <Code label="Claude Code · environment">{claudeCodeEnv}</Code>
          <Code label="Claude Code · ~/.claude/settings.json">{claudeCodeSettings}</Code>
          <h3>The attested lane</h3>
          <p>
            Send X-Anyroute-Lane: attested, or {`{"provider":{"lane":"attested"}}`} in the body, and the prompt goes only to a provider whose TEE attestation the router has verified and that documents no retention: the same lane, with the same meaning, as on /api/v1/chat/completions. When no
            such provider can serve the model the call is refused with 409 (503 while they are down) and nothing is sent or charged; an unrecognised lane is a 400, never public. X-Anyroute-Disclosure-Max and provider.disclosure work the same way. In Claude Code, ANTHROPIC_CUSTOM_HEADERS
            adds the header to every request (one Name: Value pair per line; in a settings file use \n between pairs). Use a model from GET /v1/models?lane=attested. Attestation shows what code is running, not what a provider does with a prompt; see the verify page for what the router checked and did not.
          </p>
          <Code label="Claude Code · every request on the attested lane">{claudeCodeAttestedEnv}</Code>
          <Code label="Python SDK · a call on the attested lane, reading the receipt headers">{anthropicPython}</Code>
          <Code label="TypeScript SDK">{anthropicTs}</Code>
          <Code label="curl">{anthropicCurl}</Code>
          <h3>Model names</h3>
          <p>
            Any model id in the catalog works as sent, and so do saved routes and a key’s own model aliases. A claude-* name is not in the catalog: unless the operator has mapped it, the call is a 404 (not_found_error) that says so and names a model to use. An operator maps names
            with ANTHROPIC_MODEL_MAP, a JSON object from a name sent by a client to a catalog model id. A name ending in * matches every name with that prefix (the longest prefix wins, and an exact name wins over a prefix), and a lone * answers any other name. A map that is not valid
            JSON stops the router starting.
          </p>
          <Code label="Router configuration">{anthropicModelMap}</Code>
          <h3>What is converted</h3>
          <ul>
            <li>
              <b>Request.</b> model; system as a string or text blocks; messages with text, image (base64 and URL), tool_use and tool_result blocks (a tool result may hold text and images), and document blocks with a text source; system-role entries inside messages stay where they are. max_tokens, temperature,
              top_p, top_k, stop_sequences and stream map directly; metadata.user_id is sent to the provider as user. top_k is dropped for a provider that does not list it, and a max_tokens above what the model can produce is lowered to its limit, since Anthropic clients ask for large values.
              thinking blocks in history are dropped.
            </li>
            <li>
              <b>Tools.</b> Custom tools become function tools with their JSON schema, and tool_choice auto, any, tool and none map to auto, required, a named function and none (disable_parallel_tool_use sets parallel_tool_calls to false). Tools hosted by Anthropic (web search, code execution, bash, text editor, computer use)
              cannot run behind a model here: they are left out of the request and named in the X-Anyroute-Ignored response header, as is a thinking request, which is accepted and not acted on. PDF documents, mcp_servers and container are refused with a 400 that names the field.
            </li>
            <li>
              <b>Reply.</b> A message object with text and tool_use blocks. stop_reason is end_turn, max_tokens, tool_use or refusal (from a content filter); stop_sequence appears only when the provider says which stop string ended the answer, otherwise an answer that hit one is end_turn. usage splits
              cached prompt tokens out of input_tokens as cache_read_input_tokens and cache_creation_input_tokens, so the three add up to the prompt. cache_control markers are accepted and do nothing.
            </li>
            <li>
              <b>Receipt.</b> The id of the message is the receipt id, and the reply carries an anyroute object with the lane, the disclosure class, the provider, the cost, the gateway’s upstream_attestation where there is one and the signed receipt. X-Receipt-Id, Inference-Id, X-Anyroute-Lane and X-Anyroute-Policy-Hash come back as
              headers, as on a chat call.
            </li>
            <li>
              <b>Streaming.</b> With stream: true the events are the API’s own: message_start, ping, then for each block content_block_start, content_block_delta (text_delta, or input_json_delta with the tool call’s arguments as they arrive) and content_block_stop, then message_delta with the billed usage and the
              anyroute object, and message_stop. message_start states an estimate of the prompt tokens; message_delta has the counted figure. A failure after output has begun ends the stream with an error event and no message_stop. A request the router refuses before any output is a real HTTP error, so an SDK can retry it.
            </li>
            <li>
              <b>Counting.</b> POST /v1/messages/count_tokens takes the same body without max_tokens and returns input_tokens. It is the router’s estimate (about one token for every three characters of text and JSON, and 1,600 per image), not a tokenizer’s count, and it costs nothing. It needs a key.
            </li>
          </ul>
          <div className="table-wrap">
            <table className="docs-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>error.type</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>400</td>
                  <td>invalid_request_error</td>
                  <td>The request is malformed or names something not supported; the message names the field. A provider that rejects the request also lands here.</td>
                </tr>
                <tr>
                  <td>401</td>
                  <td>authentication_error</td>
                  <td>No key, an unknown key, or a disabled or expired key.</td>
                </tr>
                <tr>
                  <td>402 · 403 · 404 · 413 · 429</td>
                  <td>billing_error · permission_error · not_found_error · request_too_large · rate_limit_error</td>
                  <td>Not enough balance; a key that may not do this; an unknown model; a body over 16 MB; a rate limit (with Retry-After).</td>
                </tr>
                <tr>
                  <td>409 · 501</td>
                  <td>invalid_request_error · api_error</td>
                  <td>The requested lane cannot be served, or is not run by this router. Sent with X-Should-Retry: false so an SDK does not retry it.</td>
                </tr>
                <tr>
                  <td>502 · 503 · 504</td>
                  <td>api_error · api_error · timeout_error</td>
                  <td>Every provider for the request failed (nothing is charged), or an attested reply was withheld because the gateway’s receipt did not show an attested upstream (that call is billed).</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            Every error has Anthropic’s shape, {`{"type":"error","error":{"type","message"},"request_id"}`}, plus an anyroute object with the router’s own error type, its metadata, and the receipt id when a refused call was billed. Every response has a request-id header. A browser
            can call the endpoint directly: the router allows the x-api-key, anthropic-version, anthropic-beta and anthropic-dangerous-direct-browser-access headers.
          </p>
          <h2 id="ollama">Use AnyRoute from any Ollama client.</h2>
          <p>
            The router speaks the Ollama API under /ollama: GET /ollama/api/tags, /api/version and /api/ps, and POST /api/show, /api/chat, /api/generate, /api/embed and the older /api/embeddings. Point an Ollama client (Open WebUI, Continue, the ollama Python and JavaScript libraries, LangChain’s ChatOllama, editor and
            notes plugins) at this router’s address followed by /ollama, and give it your Anyroute key. Each call is converted and sent through /api/v1/chat/completions (or /api/v1/embeddings) inside the router, so the key’s balance and limits, the lane, the signed receipt and the response headers are those of a chat call.
            The models run on hosted providers: nothing is downloaded and nothing runs on your machine.
          </p>
          <h3>The key</h3>
          <p>
            Send the key as Authorization: Bearer, which most Ollama clients set from an API key or headers setting. There is no ?key= query parameter, so a key never ends up in a URL or a log line. The ollama command line tool sends no key: with OLLAMA_HOST set it lists (ollama list) and describes (ollama show) the
            catalog, which are public, and a chat needs a client that sends the header.
          </p>
          <Code label="ollama CLI · OLLAMA_HOST">{ollamaHost}</Code>
          <Code label="Python · the ollama library, on the attested lane">{ollamaPython}</Code>
          <Code label="Open WebUI">{ollamaOpenWebUi}</Code>
          <Code label="Continue">{ollamaContinue}</Code>
          <Code label="LangChain · ChatOllama">{ollamaLangChain}</Code>
          <Code label="curl">{ollamaCurl}</Code>
          <h3>What is converted</h3>
          <ul>
            <li>
              <b>Models.</b> GET /ollama/api/tags lists the live catalog. Each name is a catalog id with Ollama’s :latest tag, and a routing suffix works as a tag too (:free, :nitro, :private). size is 0, since there are no local weights, and digest is the SHA-256 of the id; details has the family, the parameter size
              and the precision, read from the name and the live endpoints. With X-Anyroute-Lane: attested the list holds only the models that lane can serve now. POST /api/show adds capabilities (completion, tools, vision, thinking, or embedding) and the context length in model_info. A pull of a listed model succeeds
              at once; create, copy, push, delete and blob uploads are 501s; /api/ps is always empty.
            </li>
            <li>
              <b>Requests.</b> /api/chat messages (system, user, assistant, tool) map to chat messages, and images (base64, with the media type read from the bytes) become image parts. /api/generate sends system and prompt as a system and a user message. format "json" is JSON mode and a JSON schema is structured
              output. options temperature, top_p, top_k, min_p, seed, stop, frequency_penalty and presence_penalty map directly, repeat_penalty becomes repetition_penalty and num_predict becomes max_tokens (-1 and -2 set no limit). Options that tune a local runtime (num_ctx, num_gpu, num_thread and the like), suffix,
              template, raw and context are accepted and named in the X-Anyroute-Ignored header; keep_alive is ignored. A request with no messages or no prompt loads the model as Ollama does: done_reason load (unload with keep_alive 0), with no call and no charge.
            </li>
            <li>
              <b>Tools.</b> tools are function tools, and the model’s calls come back in message.tool_calls with the arguments as an object. A tool message answers the call it names with tool_call_id, else the earlier call with the same tool_name, else the next call without an answer.
            </li>
            <li>
              <b>Streaming.</b> Ollama streams unless stream is false. The reply is NDJSON (application/x-ndjson): one object per line with done false and a piece of message.content (response for /api/generate), tool calls whole in one line, then a closing line with done true, done_reason (stop or length),
              total_duration, load_duration (0), prompt_eval_count, prompt_eval_duration, eval_count and eval_duration in nanoseconds, and an anyroute object with the receipt id, the lane, the disclosure class, the provider and the cost. Reasoning the provider returns comes back as thinking unless think is false.
            </li>
            <li>
              <b>Embeddings.</b> /api/embed takes input as a string or a list and returns embeddings, in order; /api/embeddings takes prompt and returns one embedding. dimensions is passed on.
            </li>
            <li>
              <b>Receipt and lane.</b> X-Anyroute-Lane, X-Anyroute-Disclosure-Max and provider in the body work as on a chat call, and X-Receipt-Id, Inference-Id, X-Anyroute-Lane and X-Anyroute-Policy-Hash come back as headers.
            </li>
          </ul>
          <Code label="A streamed /api/chat reply">{ollamaStream}</Code>
          <p>
            Every error is Ollama’s {`{"error":"..."}`} with the router’s status: 400 for a bad field (the message names it), 401 or 402 without a usable key, 404 for an unknown model (the message names one to use), 409 or 503 when the requested lane cannot be served, and 429 with Retry-After. A request every
            provider fails before any output is an HTTP error; a failure after output has begun ends the stream with an {`{"error"}`} line and no closing line.
          </p>
          <h2 id="responses">Use AnyRoute with the OpenAI Agents SDK and Codex.</h2>
          <p>
            POST /v1/responses (also /api/v1/responses) is the OpenAI Responses API, so the OpenAI Agents SDK, the Codex CLI and other Responses clients work with a change of base URL and key. The base URL is this router’s address followed by /v1 (or /api/v1: the two are the same), and the key is the
            one you use for chat completions. The endpoint is an adapter: it sends your request to /api/v1/chat/completions inside the router with your credentials and your routing headers, so balance, limits, disclosure ceilings, lanes and signed receipts are exactly those of a chat call, and the answer comes back as a Response object,
            or as the Responses event stream when stream is true (response.created, response.in_progress, response.output_item.added, response.content_part.added, response.output_text.delta, response.output_text.done, response.content_part.done, response.function_call_arguments.delta and .done, response.output_item.done, then
            response.completed, or response.incomplete when the answer was cut off by max_output_tokens; a failure after the stream has started is an error event followed by response.failed).
          </p>
          <Code label="OpenAI Agents SDK (Python)">{agentsSdk}</Code>
          <Code label="Codex CLI · ~/.codex/config.toml">{codexConfig}</Code>
          <Code label="Check it with curl">{responsesCurl}</Code>
          <h3>Keep a prompt with proven enclaves</h3>
          <p>
            Set the lane the same way as for chat: the X-Anyroute-Lane: attested header (the Agents SDK example above and the Codex config send it on every call) or {'provider: {"lane": "attested"}'} in the request body; when both are given the stricter applies. On the attested lane the prompt goes only to a provider whose TEE attestation the router
            verified itself and that documents no retention. If none can answer, the call is refused with 503 no_attested_endpoint (error.metadata.reason none_attested, or attested_endpoints_down with Retry-After while they are down), nothing is sent to any provider and nothing is charged; the router does not fall back to a public provider. Attestation shows what code is running, not what a provider does with a prompt; see
            the verify page for what is and is not checked. The response carries the receipt and lane headers of a chat call (X-Receipt-Id, Inference-Id, X-Anyroute-Lane and, where the serving endpoint attested one, X-Anyroute-Policy-Hash), and its metadata has anyroute_receipt_id, anyroute_lane and anyroute_disclosure taken from the same signed receipt.
            The response id is resp_ followed by the receipt id. Models that can serve the attested lane are listed at GET /api/v1/models?lane=attested.
          </p>
          <Code label="Response (abridged)">{responsesResult}</Code>
          <h3>Stateless by design</h3>
          <p>
            AnyRoute keeps no conversation or response on the server, so there is nothing to continue from or fetch back. Send the whole conversation in input on every request, including the function_call and function_call_output items of a tool round trip; the Agents SDK and Codex already do this. store defaults to false and store: true is refused with a 400, as are previous_response_id,
            conversation, background, stored prompts and references to stored items or files. GET, DELETE and cancel under /v1/responses/:id answer 404 and say why. A call’s signed receipt, which holds no prompt or answer, is at GET /api/v1/receipts/:id with the id from X-Receipt-Id.
          </p>
          <Code label="A refusal">{responsesRefusal}</Code>
          <h3>What is supported</h3>
          <p>
            Request: model, instructions, input (text, or message items with input_text and input_image, function_call and function_call_output items, custom_tool_call and custom_tool_call_output items; earlier reasoning items are ignored), function and custom tools with tool_choice and parallel_tool_calls, max_output_tokens, temperature, top_p, text.format (text, json_object or json_schema, which
            needs a model and provider that support it), reasoning.effort, metadata (echoed back, never sent to a provider), user, and provider for routing. Other options, such as include, truncation and service_tier, are accepted and ignored. Response: a message with output_text and one function_call or custom_tool_call item per tool call, and usage with
            input_tokens, output_tokens and total_tokens (plus cost in USD). Tools that run on the API provider’s servers (web_search, file_search, code_interpreter, computer_use, image_generation, hosted mcp) are refused with a 400 that names the tool, because AnyRoute hosts none: give the model a function tool and run the work in your own code, and switch off
            any client feature, such as web search in Codex, that depends on one. File inputs are also refused.
          </p>
          <h3>Codex and apply_patch: custom tools</h3>
          <p>
            The Codex CLI offers apply_patch as a custom tool: freeform text, not JSON fields, with an optional grammar. AnyRoute passes a custom tool to the model as a function with one string argument, input, and puts the tool’s description, a line saying the tool takes freeform text, and the grammar if there is one into the function’s description. The grammar
            is guidance for the model only: nothing checks or enforces it, and a model can still produce input that does not follow it, which the client then reports as a failed call. When the model calls the function, the call comes back as a custom_tool_call item with the text as input (in a stream, response.custom_tool_call_input.delta as it is generated and response.custom_tool_call_input.done with
            the whole text), and the custom_tool_call_output item you send on the next turn goes back to the model as the tool result. Models differ in how well they follow a tool description, so how reliably apply_patch works depends on the model you choose. Codex’s shell and plan tools are ordinary function tools.
          </p>
          <h2 id="rag">Answer from your documents without storing them.</h2>
          <p>
            POST /api/v1/rag (also /v1/rag) answers a question from documents you send with it. The router cuts them into overlapping chunks, embeds the chunks and the question through /api/v1/embeddings, ranks the chunks by cosine similarity in memory, and asks a chat model,
            through /api/v1/chat/completions, to answer from the best top_k of them, citing them by number. Each of those is an ordinary call with your key: billed to it, limited by it, routed by lane and signed as a receipt, and the response lists every receipt. It needs a
            prepaid API key; per-call payment and blind tokens are not accepted.
          </p>
          <Code label="Ask a question of two documents, on the attested lane">{ragCurl}</Code>
          <p>
            There is a page for it too: <a href="/ask/">Ask your files</a> reads .txt, .md, .csv, .json, .html, .docx and .pdf files in your browser (a PDF for its text layer, page by page; scanned pages are not read) and sends the text to this endpoint with your question.
          </p>
          <p>
            <b>Request.</b> documents is a list of strings, or of objects with an id and a text; an id defaults to doc-1, doc-2 and so on, and ids must be unique. By default one request may carry 200 documents, 2 MiB of text, 2,000 chunks and 64 embeddings calls; above any of them it is
            refused with 413 before anything is sent (the router’s RAG_MAX_DOCUMENTS, RAG_MAX_BYTES, RAG_MAX_CHUNKS and RAG_MAX_EMBEDDING_CALLS settings). chunk.size (100 to 8,000 characters, default 1,000) and chunk.overlap (default 15% of the size, at most half of it) set the
            chunking, and a chunk ends at a paragraph, line or sentence boundary where it can. top_k (1 to 20, default 4) is how many chunks go into the prompt; a request whose largest possible prompt would not fit the chat model’s context is refused (400 context_too_small) before
            anything is embedded. embedding_model defaults to qwen/qwen3-embedding-8b when the catalog serves it, else the cheapest embedding model, considering models with an attested endpoint first. max_tokens and temperature go to the chat call. Unknown fields are refused, so a misspelt
            option is never silently ignored.
          </p>
          <p>
            <b>Response.</b> The answer, and sources in rank order: each names its document, the chunk’s position, its cosine score and where the chunk lies in the document (start and end). The text of a source is returned only if you send include_excerpts as true. receipts has one entry
            for every embeddings call and one for the chat call, each with its lane, the disclosure class its signed receipt records and, when the provider is an attested gateway, upstream_attestation: attested, gpu_attested and receipt_verified, what the router checked in the gateway’s receipt for
            that call. Then the totals. The headers are the chat call’s (X-Receipt-Id and the others), X-Anyroute-Lane is the lane every call used, X-Anyroute-Disclosure is the weakest class among all the calls, and X-Anyroute-Policy-Hash is sent only when every call reported the same one.
            The answer is a model’s output grounded in the sources you were shown, not a proof; the prompt asks for numbered citations so you can check them.
          </p>
          <Code label="Response (abridged)">{ragResponse}</Code>
          <h3>Lane, and what a refusal looks like</h3>
          <p>
            Send provider.lane (public or attested), provider.disclosure (none, policy or any), X-Anyroute-Lane or X-Anyroute-Disclosure-Max, and every call runs under exactly that. So does a lane pinned on your key (its routing.provider), which applies to the embeddings step as well as the chat step.
            If a step cannot be served under it, whether there is no attested embedding model, the chat model has no attested endpoint, or the attested endpoints are down, the request is refused with that step’s own error (on the attested lane 503 no_attested_endpoint, with error.metadata.reason none_attested or attested_endpoints_down;
            with only a disclosure ceiling 409 disclosure_unavailable or 503 disclosure_provider_unavailable), and it is never sent on a weaker lane. error.metadata.step says which step stopped, and error.metadata.receipts lists the calls already made, which are billed. If an attested gateway’s
            receipt for a call does not show an upstream it verified inside a TEE, that call’s output (the vectors, or the answer) is withheld, the call is billed, and the error is 502 upstream_not_attested with the receipt listed and marked withheld. The unlinkable lane is not available here.
            A model the router resolves itself (a saved route, an alias of your key, a router model such as anyroute/council) can pin a lane of its own, so a request naming one must state provider.lane (400 lane_required).
          </p>
          <Code label="A chat model without an attested endpoint, on the attested lane (abridged)">{ragRefusal}</Code>
          <p>
            Send none of them and the router chooses: the attested lane when the chat model and the embedding model both have an attested endpoint right now, and otherwise the router’s ordinary public lane. The response says which (lane, and lane_source: request or default) and, when it is
            public, why (lane_note). Setting provider.lane to attested yourself is how you make the request refuse instead of falling back.
          </p>
          <h3>Streaming</h3>
          <p>
            With stream set to true the embeddings run first, and a refusal up to the start of the answer is an ordinary JSON error. The stream then sends a chat.completion.chunk event with empty choices and rag.object rag.sources (the sources and the embeddings receipts), the chat
            stream exactly as /api/v1/chat/completions sends it (on the attested lane an attested gateway’s text is held back until its receipt has been checked), a last chunk with rag.object rag.summary (every receipt, the totals, and error if the answer was refused after the stream
            began), and data: [DONE].
          </p>
          <h3>What is kept, and what is not</h3>
          <p>
            <b>Nothing of your documents is stored.</b> The documents, their chunks and vectors, the question and the answer exist in the memory of the request that carries them. The endpoint writes none of them to a database, cache or file, does not log them, and never uses the response
            cache (it sends no cache option to the calls it makes and ignores X-Anyroute-Cache). When the request ends the router lets go of them and the runtime reclaims the memory. The router does not overwrite freed memory, so this is not a claim about what someone with access to the
            running process could recover while a request is in flight or soon after.
          </p>
          <p>
            <b>What is recorded.</b> Each embeddings call and the chat call is a generation of your key, exactly as if you had made it yourself: a record and a signed receipt holding ids, model, provider, lane, token counts, cost, timing, the disclosure class, any gateway attestation
            check, and the SHA-256 of the request and of the response. The hashes do not reveal text, but whoever holds an exact guess of a request can confirm it against one, and a receipt can be read by its id.
          </p>
          <p>
            <b>What leaves the router.</b> The text has to reach models to be used. The chunks and the question go to the embedding model’s provider; the question and the best chunks go to the chat model’s provider. What that provider sees and keeps depends on the lane. On the attested lane
            the router sends them only to a provider whose retention is declared attested and whose hardware attestation it verified itself and holds fresh, and for an attested gateway it checks the gateway’s receipt for each call. That shows what code is running, not what it does with your
            text; GET /api/v1/attestation/:providerId lists what the router does not check. On the public lane a provider’s documented policy applies (GET /api/v1/disclosure/:providerId).
          </p>
          <p>
            <b>Untrusted text.</b> Documents are treated as untrusted. The prompt tells the model to use only the numbered sources and to ignore instructions inside them, and a source cannot close its own tag. That lowers, and does not remove, the chance that a document steers the answer.
            The cost of a request is the sum of its calls; each holds its worst case before it is sent, so your balance bounds every step, and a refusal partway leaves the earlier calls billed.
          </p>
          <h2 id="batches">Run many calls at half the price.</h2>
          <p>
            POST /api/v1/batches (also /v1/batches) is the OpenAI Batch API without files. Send many chat completions or embeddings requests in one call and the router runs them in the background, in spare capacity, at 50% of the normal price. A batch can take minutes,
            and lines not run within the 24-hour completion window expire and are not charged. It needs a prepaid key (Authorization: Bearer). Each line is billed, budgeted, rate-limited and routed exactly like a normal call of that key, so lanes, provider preferences, key budgets and
            key rate limits apply to every line; a failed line is not charged, and every answered line has its own signed receipt. In the dashboard, Batch Studio can send a batch this way (Run on the server).
          </p>
          <Code label="Send a batch inline, then read the results">{batchCurl}</Code>
          <p>
            <b>Request.</b> Send requests, a list of lines, or input_jsonl, the same lines as JSONL text, with completion_window 24h. Each line has a custom_id (unique, at most 64 characters), method POST, a url of /v1/chat/completions or /v1/embeddings, and the body of that request.
            endpoint, if you send it, must match every line’s url. There is no files endpoint, so input_file_id is refused with 400: send the lines inline. stream: true, council mode (anyroute/council) and verify are refused in a batch. A batch with an invalid line is not created: the 400
            invalid_request lists each problem in error.metadata.errors with its line (counted from 1), code and message.
          </p>
          <p>
            <b>Progress and results.</b> The response is a Batch object with its id (batch_…). GET /api/v1/batches/:id returns it again: status (validating, in_progress, then completed, failed or expired; cancelling, then cancelled, after a cancel), request_counts (total, completed,
            failed) and cost (usd, the discounted cost so far, and list_usd, what the same calls cost at the normal price). GET /api/v1/batches?limit=20&amp;after=&lt;batch id&gt; lists your batches, newest first. POST /api/v1/batches/:id/cancel stops a batch: lines already running finish
            and are billed, lines not started are never run or billed. GET /api/v1/batches/:id/output returns one JSONL line per answered request, with the normal response body (usage.cost and the receipt included), and GET /api/v1/batches/:id/errors one per failed or unrun request.
          </p>
          <Code label="A line of the output file, and one of the errors file (abridged)">{batchOutputLine}</Code>
          <p>
            <b>Limits.</b> By default a batch holds up to 1,000 lines and 8 MiB of input, and a key can have 2 unfinished batches at a time; one more is refused with 429 batch_limit. The operator sets these with BATCH_MAX_LINES, BATCH_MAX_BYTES and BATCH_MAX_ACTIVE. Results are kept for
            24 hours after the batch finishes (BATCH_RESULTS_TTL) and then deleted; after that the output and errors routes answer 410 batch_results_expired.
          </p>
          <p>
            <b>What is kept.</b> The request lines and the answers are never written to the database. Until the results expire they are kept sealed (AES-256-GCM, with a key derived from the router’s secret) in Redis, or in the router’s memory where there is no Redis, and then deleted.
            The seal protects them from someone who can read Redis without the router’s secret; the router itself can open them, which it does to return your results. The database keeps only each batch’s counts, costs and statuses and the generation id of each answered line, and every
            answered line has the generation record and signed receipt of a normal call.
          </p>
          <h2 id="rerank">Rerank documents against a query.</h2>
          <p>
            POST /api/v1/rerank (also /v1/rerank) takes the Cohere and Jina request: a model, a query, documents as strings or objects with a text, and optionally top_n and return_documents. It answers with results best first, each with the index of a document you sent and its
            relevance_score (and the document’s text when return_documents is true), usage with total_tokens and search_units, the cost, and a signed receipt. The scores are the provider’s own: an answer that is not a valid ranking of the documents sent counts as a failed attempt, the
            next provider is tried, and if none answers the call fails with 502 and nothing is charged. One request may carry 1,000 documents; a long document is truncated or split by the provider.
          </p>
          <Code label="Rerank three documents, cheapest provider first">{rerankCurl}</Code>
          <Code label="Response (abridged)">{rerankResponse}</Code>
          <p>
            Only models whose architecture.output_modalities include rerank serve it; GET /api/v1/models?output_modalities=rerank lists them. Any other model, or a router where no provider lists a rerank model yet, answers 404 model_not_found. A rerank model is priced per token
            (pricing.prompt) and per search unit (pricing.request: one query over up to 100 documents, each split into chunks of 500 tokens), from what the provider reports; when it reports nothing, from the router’s estimate, and usage.estimated says so. Keys, budgets, per-call payment,
            blind tokens, lanes, the disclosure ceiling, provider preferences and the :nitro and :floor suffixes work as they do for embeddings. The Oblivious HTTP gateway does not carry rerank calls yet.
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
            verifyHostAnchor checks such a receipt against its host root in the same order: the signature (under the key verifyProvider bound, when you pass it), the path to the root and, with a reader for ReceiptAnchor
            (readAttestedAnchor over any RPC endpoint you choose), the root, provider and attestation on chain. A root kept off chain is reported as off chain, never as anchored.
          </p>
          <Code label="TypeScript · receipts, disclosure and lane">{sdkReceipt}</Code>
          <p>
            privacyLabel(receipt) turns a receipt you have verified into the plain-English label the router serves at GET /api/v1/receipts/:id/privacy (see What we saw above), computed on your side from the signed fields alone; fetchPrivacyLabel(baseUrl, receiptId) reads the router’s.
          </p>
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
            shows what the router has recorded for a provider (/verify/?p=&lt;provider id&gt;), the privacy label of a receipt id (/verify/?r=&lt;receipt id&gt;) and checks a pasted receipt in your browser. It reads the router’s record only; use an SDK to check the provider itself.
          </p>
          <HostsDocs /><NetworkHostsDocs /><HostBondsDocs />
          <NetworkStatsDocs />
          <CommerceStatsDocs /> {/* v6 L */}
          <RouteExplanationDocs /> {/* V84 */}
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
          <RouterLimits /> {/* HD1 */}
          <h2>Limits and guarantees.</h2>
          <p>
            Each call holds its worst-case cost before routing and settles the metered usage after, so a key never goes past its balance or budget. Keys have a per-minute request limit, and optional token-per-minute limits; n and best_of are capped at 16. If every
            provider fails, nothing is charged. A cancelled stream is billed only for what was generated.
          </p>
          <p>
            The router stores key hashes, balances and receipt metadata. It never stores prompts or responses; the optional response cache is encrypted, per-workspace and expires, and a <a href="#batches" className="inline-link">Batch API</a> batch keeps its lines and answers sealed, outside the database, only until its results expire. Provider data policies are listed per provider.
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
      <NetworkPayoutDocs />
      </main>
    </PageFrame>
  );
}
