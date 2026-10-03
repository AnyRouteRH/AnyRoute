import { Code } from "./UI";

// V6 R: make-good refunds (src/services/makegood.ts).
const rules = [
  ["upstream_failure", "A per-call payment (x402 or CallPay) bought a request that no provider served: every attempt failed, at least one with an upstream 5xx, timeout, connection failure or broken stream, and none rejected the request itself.", "100% of that payment, sent back on-chain."],
  ["fallback_price", "The first provider tried for the model failed, and the call went to a provider that costs more for the same tokens (route_explain.reason is fallback).", "The price difference for the tokens of the call."],
  ["truncated_stream", "The upstream stream ended or broke before any finish_reason. A client that hangs up is not made good.", "The price of the billed output tokens that were never delivered. A stream billed only for what it delivered has nothing to refund."],
  ["structured_output", "With anyroute.json_check repair, the repair answer still does not parse as JSON. Valid JSON that misses the schema does not count.", "100% of the repair call. The first call stays charged."],
  ["unattested_lane", "An attested-lane (or :private, or disclosure none) call settled without a fresh attestation, or with an attested gateway receipt that does not show an attested upstream. Routing already fails closed; this is the second check.", "100%, plus a strike against the host."],
];

const receipt = {
  v: 1,
  kind: "refund",
  id: "rf_…",
  issued: "2026-10-02T12:00:00.000Z",
  router: "https://anyroute.tech",
  original_receipt_id: "gen-…",
  generation_id: "gen-…",
  rule: "fallback_price",
  amount: "0.000184",
  charged: "0.000412",
  settlement: "credit",
  provider: "provider-id",
  strike: false,
  evidence: { served_provider: "…", planned_provider: "provider-id", planned_error: "http_5xx", served_cost: "0.000412", planned_cost: "0.000228" },
};

export default function MakeGoodDocs() {
  return <section id="make-good-refunds">
    <h2>Make-good refunds when a call fails you.</h2>
    <p>Not switched on at anyroute.tech yet. Self-hosted routers can enable <code>MAKEGOOD_ENABLED</code> (default <code>false</code>). While it is off, nothing on this page happens and billing is unchanged; <code>GET /api/v1/status</code> reports <code>makegood.enabled</code> either way.</p>
    <p>Each rule is decided from facts the router records when it serves (or fails) the call: error classes, token counts, prices, the lane and the attestation result. There is no claim form and no judgement call. A call meets at most one rule; the largest refund wins.</p>
    <table>
      <thead><tr><th>Rule</th><th>When</th><th>Refund</th></tr></thead>
      <tbody>{rules.map(([rule, when, refund]) => <tr key={rule}><td><code>{rule}</code></td><td>{when}</td><td>{refund}</td></tr>)}</tbody>
    </table>
    <p>The hourly settlement job issues a refund about a minute or more after the call. It writes a ledger line of kind <code>refund</code> linked to the generation, signs a refund receipt of kind <code>refund</code> that names the original receipt (<code>original_receipt_id</code>), and queues a <code>refund.issued</code> webhook (reference: the refund id, status: the rule) for destinations that subscribe to it. The refund appears in Activity as &quot;Make-good refund&quot; with its receipt, in the refunds total of the monthly statement, and in <code>GET /api/v1/refunds</code>. <code>GET /api/v1/receipts/rf_…</code> returns the signed receipt; check it with <code>POST /api/v1/receipts/verify</code> or on /verify.</p>
    <Code label="A refund receipt payload">{JSON.stringify(receipt, null, 2)}</Code>
    <p>A refund is never more than the ledger charged for that call (for an unserved paid request: the payment still unspent on the wallet account), and a call is refunded at most once. One refund record exists per call or payment, it is decided once under a row lock, and its ledger references are unique, so a retried or concurrent settlement run changes nothing.</p>
    <p>Calls paid on-chain per call (x402 or CallPay) are refunded on-chain. A served call&apos;s refund is credited and moved, in the same transaction, into an obligation to the paying wallet (an unserved paid request&apos;s unspent payment is moved the same way); the <code>makegood-payouts</code> worker job sends each wallet one USDG transfer per hour for all it is owed, from the treasury key <code>MAKEGOOD_REFUND_PRIVATE_KEY</code>. Only whole USDG units go on-chain; any remainder below one unit stays as wallet change. Each transfer is signed and stored before it is broadcast and is only ever resent as the same transaction, so a crash cannot send it twice. Without the key the job refuses to run and the refunds stay owed: <code>makegood.onchain</code> in the status and <code>onchain.status</code> in <code>GET /api/v1/refunds</code> show what is owed and what has been sent. With sanctions screening on, a listed wallet is held, not sent.</p>
    <p>A refund caused by a network host is recorded as host slashing evidence for review when host bonds are on; it is never proposed automatically. An attested-lane refund also counts as a host strike in the status.</p>
    <p>Limits: blind-token calls name no account, so they are not refunded. Encrypted chat (E2EE) is not covered, because the router does not see its tokens. A failover price difference is not computed when either provider uses your own key, or when the first-choice provider is no longer listed. Refunds do not restore a key&apos;s spending budget. Refund receipts are v1 (Ed25519 over canonical JSON) and are not yet anchored on-chain.</p>
  </section>;
}
