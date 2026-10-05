import { Code } from './UI';
const ask = `curl "$ANYROUTE_URL/api/v1/agents/pay" \\
  -H "Authorization: Bearer $AGENT_KEY" -H 'Content-Type: application/json' \\
  -d '{"to":"<profile id or 0x wallet>","amount_usd":"20.00"}'`;
const confirm = `curl "$ANYROUTE_URL/api/v1/agents/pay/$DECISION_ID/confirm" \\
  -H "Authorization: Bearer $AGENT_KEY" -H 'Content-Type: application/json' \\
  -d '{"tx_hash":"0x…"}'`;
const sdk = `const asked = await client.agent.pay({ to: profileIdOrWallet, amount_usd: "20" });
if (asked.decision === "allow" && asked.payment) {
  const txHash = await sendFromYourWallet(asked.payment.transfer_call); // your wallet signs and sends
  const paid = await client.agent.confirmPay(asked.decision_id, txHash); // Python: client.agent.confirm_pay(...)
}`;
// Pay another agent, next to Agent Guard: the rulebook decides, the payer's own wallet sends, Anyroute checks and signs.
export default function AgentPayDocs() {
  return <section id="agent-pay"><h2>Pay another agent</h2>
    <p>Paying another agent is switched on at anyroute.tech. Self-hosted routers turn it on with AGENT_PAY_ENABLED (default false), which requires AGENT_GUARD_ENABLED. While it is off, the pay routes return 404 with the message that it is not switched on, and /api/v1/status reports agent_pay.enabled: false.</p>
    <p><strong>Anyroute never holds the money.</strong> The paying agent’s own wallet sends USDG on Robinhood Chain straight to the recipient’s wallet. Anyroute does three things only: it decides with the payer’s rulebook through Agent Guard, it checks the transfer on chain afterwards, and it signs a receipt that links the decision to the transfer. No balance moves inside Anyroute, there is no escrow, and nothing is sent through Anyroute.</p>
    <h3>Recipient</h3>
    <p>An agent can add an optional payout_wallet (a 0x address) to its opt-in public profile, so others can pay it by profile id. Paying a raw 0x wallet works too. When exactly one live profile publishes that wallet, the payment is linked to that agent as well.</p>
    <h3>1. Ask the rulebook</h3>
    <Code label="Ask before paying (where enabled)">{ask}</Code>
    <p>POST /api/v1/agents/pay takes the payer agent’s key and {'{'}to, amount_usd, memo_sha256?, approval_id?{'}'}. It runs the payer’s rulebook through Agent Guard as action pay.agent, with the target set to the recipient’s profile id or wallet, so the actions section’s allow and deny lists, targets, per_action_usd, per_day_usd, approval_above_usd and max_per_hour all apply. The answer is Agent Guard’s own: allow, deny or approval_required, with decision_id, reasons, policy_sha256 and the signed decision. On approval_required, poll the approval, then ask again with the same fields plus approval_id. An optional memo is sent only as memo_sha256, the SHA-256 of your memo.</p>
    <h3>2. Send it from your wallet</h3>
    <p>Only on allow, the answer adds payment: the USDG contract, the recipient wallet, the exact amount in base units (6 decimals), the chain id, a short reference, the wallets linked to the account that may send it, and transfer_call, an unsigned ERC-20 transfer for your own wallet to sign and send. Anyroute never signs or sends a payment transaction. A wallet is linked to the account when the account was created by wallet sign-in with it, or when it is the verified owner wallet of an organisation the account owns.</p>
    <h3>3. Confirm with the transaction</h3>
    <Code label="Confirm the transfer (where enabled)">{confirm}</Code>
    <p>POST /api/v1/agents/pay/:decision_id/confirm with the same agent key reads that transaction from Robinhood Chain and accepts it only when: the router’s node reports the configured chain id; the transaction receipt is successful; its block is the canonical block at that height; and it holds a USDG Transfer log from a wallet linked to the payer’s account, to the recipient wallet, for at least the allowed amount. A transfer from an unlinked wallet is refused with pay_wallet_not_linked. Other refusals are pay_tx_not_found (not mined yet, try again), pay_tx_failed, pay_transfer_not_found, pay_amount_short and pay_transfer_used (that transfer already confirms another payment). The amount actually paid is reported to the Guard decision as its executed outcome, so per_day_usd counts the real amount.</p>
    <p>A confirmed payment is seen, waiting for finality, until its block reaches the chain’s finality point (ESCROW_FINALITY, with CHAIN_CONFIRMATIONS as a floor), then final. If the transfer leaves the canonical chain within ESCROW_REORG_HORIZON_BLOCKS, the payment and its receipt become reversed; a reversed payment still counts toward the daily limit. Re-checks happen when the payment is read (GET /api/v1/agents/pay/:decision_id, or the same confirm again) and every minute in the agent-pay-verify job.</p>
    <h3>The receipt</h3>
    <p>Each confirmation answers with a receipt whose payload has type anyroute.agent.payment.v1: status, decision_id, policy_sha256, the payer’s account, agent key hash and wallet, the recipient wallet and profile id, the allowed and paid amounts, chain id, tx_hash, log index, block number and hash, and verified_at. Check it with POST /api/v1/receipts/verify and {'{'}payload, sig, key_id{'}'}, like other signed receipts. The receipt is signed again whenever the status changes. It is the router’s statement of what it read on chain; the transaction itself is the proof of payment.</p>
    <p>The payer’s account and, when the recipient is an Anyroute agent, the recipient’s owner each get an inbox item, which the header bell shows. On /agents, the Pay another agent section walks through the same steps: pick a recipient from the directory or enter a wallet, enter an amount, see the rulebook’s decision and the instructions, send from a connected wallet or paste the transaction hash, then confirm and check the receipt.</p>
    <Code label="TypeScript SDK">{sdk}</Code>
  </section>;
}
