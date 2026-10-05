import { Code } from './UI';
// B: decision tags. Built and not switched on at anyroute.tech yet: the copy says what happens when it is switched on.
const curl = `# The order, written as canonical JSON: keys sorted, no spaces, prices and quantities as strings.
ORDER='{"client_order_id":"7f3c","limit_price":"180.00","quantity":"2","side":"buy","symbol":"STOCK_A"}'
TAG="sha256:$(printf '%s' "$ORDER" | shasum -a 256 | cut -d' ' -f1)"   # sha256sum on most Linux systems

curl "$ANYROUTE_URL/api/v1/chat/completions" \\
  -H "Authorization: Bearer $AGENT_KEY" -H 'Content-Type: application/json' \\
  -H "X-Anyroute-Decision-Tag: $TAG" \\
  -d '{"model":"<model>","messages":[{"role":"user","content":"Buy STOCK_A now or wait?"}]}'
# Keep the reply's receipt with the order: receipt.payload.decision_tag is $TAG.

# Before placing the order, ask Agent Guard with the same hash (where Agent Guard is enabled).
curl "$ANYROUTE_URL/api/v1/guard/decide" \\
  -H "Authorization: Bearer $AGENT_KEY" -H 'Content-Type: application/json' \\
  -d "{\\"action\\":\\"trade.order\\",\\"target\\":\\"STOCK_A\\",\\"amount_usd\\":\\"360.00\\",\\"details_sha256\\":\\"$TAG\\"}"
# data.informed_by names the call above: its generation id, receipt id, model and provider.

# Later, check the receipt and the order hash together. Only the hash is sent.
curl "$ANYROUTE_URL/api/v1/receipts/verify" -H 'Content-Type: application/json' \\
  -d "{\\"payload\\":$PAYLOAD,\\"sig\\":\\"$SIG\\",\\"key_id\\":\\"$KEY_ID\\",\\"decision_tag\\":\\"$TAG\\"}"
# data.valid is true only when the signature verifies and data.decision_tag_valid is true.`;

const ts = `import OpenAI from "openai";
import { AnyRoute, checkDecisionTag, decisionTag, withDecisionTag } from "@anyroute/client"; // packages/client

const order = { symbol: "STOCK_A", side: "buy", quantity: "2", limit_price: "180.00", client_order_id: "7f3c" };

// With the Anyroute client, which also verifies the receipt's signature:
const client = new AnyRoute({ baseUrl: process.env.ANYROUTE_URL!, apiKey: process.env.AGENT_KEY });
const reply = await client.chat.completions.create({ model, messages }, await withDecisionTag(order));
console.log(reply.anyroute.receiptVerification?.valid, (await checkDecisionTag(reply.receipt, order)).matches);

// Or with the OpenAI SDK: the same options object carries the header.
const openai = new OpenAI({ baseURL: \`\${process.env.ANYROUTE_URL}/api/v1\`, apiKey: process.env.AGENT_KEY });
await openai.chat.completions.create({ model, messages }, await withDecisionTag(order));

// details_sha256 for Agent Guard is the same hash.
const details_sha256 = await decisionTag(order);`;

const py = `import os
from openai import OpenAI
from anyroute_client import AnyRoute, check_decision_tag, decision_tag, with_decision_tag  # packages/client-py

order = {"symbol": "STOCK_A", "side": "buy", "quantity": "2", "limit_price": "180.00", "client_order_id": "7f3c"}

# With the Anyroute client, which also verifies the receipt's signature:
with AnyRoute(os.environ["ANYROUTE_URL"], os.environ["AGENT_KEY"]) as client:
    reply = client.chat({"model": model, "messages": messages}, headers=with_decision_tag(order))
    print(reply["anyroute"]["receipt_verification"].valid, check_decision_tag(reply["receipt"], order)["matches"])

# Or with the OpenAI SDK:
openai = OpenAI(base_url=os.environ["ANYROUTE_URL"] + "/api/v1", api_key=os.environ["AGENT_KEY"])
openai.chat.completions.create(model=model, messages=messages, extra_headers=with_decision_tag(order))

# details_sha256 for Agent Guard is the same hash.
details_sha256 = decision_tag(order)`;

export default function DecisionTagDocs() {
  return <section id="decision-tags"><h2>Decision tags</h2>
    <p>A decision tag ties an order to the model call that informed it. Your agent sends the SHA-256 of the order with the call, and the router signs that hash into the call&apos;s receipt next to the model, provider and the hashes of the request and the answer. Later, the order and the receipt together show which model answered before the decision. The router only ever sees the hash, never the order.</p>
    <p>Decision tags are not switched on at anyroute.tech yet. Self-hosted routers switch them on with <code>DECISION_TAGS_ENABLED</code> (default <code>false</code>), and <code>GET /api/v1/status</code> reports <code>decision_tags.enabled</code>. While it is off the header is ignored and no receipt carries a tag, so check the first receipt you store; the <a href="/labs/">Labs</a> page reads the same field.</p>
    <h3>Send a tag</h3>
    <p>Send <code>X-Anyroute-Decision-Tag: sha256:&lt;64 hex&gt;</code> on <code>POST /api/v1/chat/completions</code>, <code>/completions</code>, <code>/responses</code>, <code>/v1/messages</code> or the Ollama-compatible chat and generate routes. When tags are switched on, the router signs it into the v1 receipt as <code>payload.decision_tag</code> and into the v2 claims as <code>claims.decision_tag</code>; a streamed call carries it in its closing receipt. The hash is SHA-256 of the order&apos;s canonical JSON: keys sorted, no spaces. Write prices and quantities as strings so every language hashes the same bytes. The SDKs and the helpers in <code>integrations/robinhood-agents</code> all compute it the same way; the order <code>{'{"symbol":"STOCK_A","side":"buy","quantity":"2","limit_price":"180.00","client_order_id":"7f3c"}'}</code> hashes to <code>sha256:c6a5490500b12be3787fadaa8d87982c369b158af7f5cdfdc8643b5177477c8d</code>.</p>
    <Code label="curl">{curl}</Code>
    <Code label="TypeScript">{ts}</Code>
    <Code label="Python">{py}</Code>
    <p>Plain OpenAI clients can use <code>decisionHeaders(intent)</code> and <code>verifyDecisionReceipt(receipt, intent)</code> from <code>integrations/robinhood-agents/decision-receipt.ts</code>, or <code>decision_headers</code> and <code>verify_decision_receipt</code> from <code>decision_receipt.py</code>, without the SDKs.</p>
    <h3>Link it to an Agent Guard decision</h3>
    <p>Give <a href="#agent-guard">Agent Guard</a> the same hash as <code>details_sha256</code>. When tags are switched on, the decision&apos;s response adds <code>informed_by</code>: up to five calls from the preceding 24 hours whose signed receipt carries that hash, newest first, each with <code>generation_id</code>, <code>receipt_id</code>, <code>model</code>, <code>provider</code>, <code>at</code>, <code>receipt_url</code> and <code>verify_url</code>. Only calls made with the deciding key, the key it is an agent session of, or its own agent sessions count; other keys in the account are never linked. <code>informed_by</code> is read from the stored receipts when the decision is made and is not part of the decision&apos;s signed payload; each linked receipt carries its own signature.</p>
    <p>The reverse: <code>GET /api/v1/guard/decisions?receipt=&lt;receipt id&gt;</code> (or <code>?details_sha256=sha256:&lt;64 hex&gt;</code>) lists the decisions made with that hash, newest first, up to 20, each with its action, target, amount, decision, reported outcome and the calls that informed it. Management and owner/admin keys read the account; other keys read their own decisions and those of their agent sessions. It needs Agent Guard (404 when it is off), and nothing new is stored for either direction.</p>
    <h3>Check a tag</h3>
    <p>Paste a receipt into <a href="/verify/">Verify</a> (or open <code>/verify/?r=&lt;receipt id&gt;</code>, which fills it in) to see its decision tag, then paste the order. The page hashes the order in your browser and compares the two hashes; the order is not sent anywhere. <code>POST /api/v1/receipts/verify</code> takes an optional <code>decision_tag</code> with a v1 or v2 receipt: the result reports <code>decision_tag</code> (the signed tag, or null) and <code>decision_tag_valid</code>, and <code>valid</code> is false when they differ.</p>
    <p>A <a href="#proof-pack">proof pack</a> lists every tagged call in <code>decision_tags</code>, inside its signed manifest. <code>scripts/verify-proof-pack.mjs</code> checks the list against each signed receipt, and with <code>--intent order.json</code> names the call behind an order.</p>
    <h3>What a tag shows, and what it does not</h3>
    <ul>
      <li>It shows the caller attached this order&apos;s hash to this model call, and the router signed that with the call&apos;s model, provider and request and answer hashes. It does not show the agent followed the answer, that the order was placed, or at what price.</li>
      <li>The unlinkable lane refuses a tag with 400 <code>decision_tag_unlinkable</code>, because a reused tag joins calls together. A malformed tag returns 400 <code>invalid_decision_tag</code> before anything is charged. Batch lines carry no tag.</li>
      <li>Anyone who knows the order can compute its hash, so a tag is not a secret. Add your own order id or a timestamp to the order if the same order could repeat.</li>
    </ul>
  </section>;
}
