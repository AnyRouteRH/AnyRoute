import { Code } from './UI';

export const toolCallExample = `curl -s https://anyroute.tech/api/v1/tools/call \\
  -H "Authorization: Bearer $ANYROUTE_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"resource":"https://tool.example/quote?symbol=NVDA","max_price":0.02}'
# data.response holds the tool's answer (untrusted), data.receipt the signed tool.call receipt.`;

export const toolRulebook = `{
  "version": 1, "models": {}, "caps": { "per_day_usd": 5 }, "on_breach": "deny",
  "tools": {
    "allow": ["https://tool.example/*", "*.data.example"],
    "max_price_per_call": 0.05,
    "daily_budget": 1,
    "pass_to_models": false
  }
}`;

export const toolListing = `POST /api/v1/tools/listings
{ "name": "Quotes", "summary": "Delayed stock quotes.",
  "resource": "https://tool.example/quote", "method": "GET",
  "canary": { "query": "symbol=NVDA", "expect": { "contains": "\\"symbol\\":\\"NVDA\\"" } } }`;

export default function ToolsMarketDocs() {
  return <section id="paid-tools"><h3>Pay x402 tools from your balance</h3>
    <p><code>TOOLS_MARKET_ENABLED</code> defaults to false and is not switched on at anyroute.tech yet. A paid call also needs the operator's buyer wallet, <code>TOOLS_BUYER_PRIVATE_KEY</code>, a dedicated key holding USDG; <code>/api/v1/status</code> reports <code>tools.ready</code> only when both are set.</p>
    <p><code>POST /api/v1/tools/call</code> takes <code>resource</code> (an https address, with its query arguments), <code>method</code> (GET or POST), an optional JSON <code>body</code> of up to 64 KiB and <code>max_price</code> in USD. The router asks the tool unpaid and reads its 402 in either x402 version: a v1 JSON body with <code>accepts</code> or a v2 <code>PAYMENT-REQUIRED</code> header. It pays only scheme exact in USDG on Robinhood Chain. A quote above <code>max_price</code> (the price plus the router's take, <code>TOOLS_TAKE_BPS</code>, 300 by default), above the router's per-call ceiling or outside your rulebook is refused before anything is held or paid.</p>
    <p>Otherwise it holds the price plus the take on your key, signs an EIP-3009 authorization from its own wallet to the seller's payTo, and retries with <code>X-PAYMENT</code> or <code>PAYMENT-SIGNATURE</code>. A 2xx JSON or plain-text answer of at most 2 MB is charged once and returned as untrusted data with a <code>tool.call</code> receipt: a COSE_Sign1 under the receipt key carrying the seller, the address without its query, the price, the answer's SHA-256 and the settlement transaction from the seller's payment response. <code>POST /api/v1/receipts/verify</code> checks it. Any other answer is refused and not charged; its hold is released once the authorization expires unused. If the seller collects the authorization anyway, the call is charged, so the buyer wallet cannot be drained by failing on purpose.</p>
    <p>Rulebooks gain a tool price dimension: <code>tools.allow</code> and <code>tools.deny</code> match a paid tool by exact address, address prefix ending in *, host, *.host, seller wallet or listing id; <code>tools.max_price_per_call</code> and <code>tools.daily_budget</code> are in USD; spending caps and approvals cover tool spend too. A tool's answer reaches a model only when <code>tools.pass_to_models</code> is true and the call adds <code>then: {"{ model, prompt }"}</code>; the answer is then wrapped as data the model is told not to obey.</p>
    <Code label="Call a tool">{toolCallExample}</Code>
    <Code label="Rulebook with tool limits">{toolRulebook}</Code>
    <p>Sellers list a tool with <code>POST /api/v1/tools/listings</code> and a known-answer canary. The router checks the address answers 402 with a payable offer and records its payTo; later calls are refused if the payTo changes. Each listed tool gets a paid probe every day; three failures in a row delist it, and the state shows on <a href="/tools/">the tool catalog</a> and <code>GET /api/v1/tools</code>. A Skills Hub skill's paid invocation is a listing that names the skill; installing works as before. Sellers who list through the Robinhood Chain facilitator appear in search without a canary. With <code>TOOLS_PUBLIC_CATALOG_URL</code> set, search also covers that public catalog.</p>
    <Code label="List a tool">{toolListing}</Code>
    <p>Over MCP, <code>anyroute_tools_search</code> finds tools and <code>anyroute_tools_call</code> pays one with the connection's key, under the same rulebook. Egress uses the provider egress guard: public https destinations only, DNS pinned, no redirects. The router's buyer wallet authorizes at most <code>TOOLS_DAILY_LIMIT_USD</code> per day across all keys.</p>
  </section>;
}
