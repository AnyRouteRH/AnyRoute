import type { Evidence, ExternalDoc, RedisFamily, TableDoc } from "./types.ts";
import { CREATED, JSON_FIELDS, KEPT } from "./tables/common.ts";

// Pay another agent (src/agents/pay.ts). The money never passes through Anyroute: the paying wallet sends USDG on
// Robinhood Chain straight to the recipient, and the router records only its decision, the transfer it then found on
// chain and the receipt it signed.
const ev = (file: string, contains: string): Evidence => ({ file, contains });
const windowTtl = (s: number) => `${(s + 1).toLocaleString("en-US")} seconds (the ${s.toLocaleString("en-US")}-second window plus one second)`;

export const agentPayTables: Record<string, TableDoc> = {
  agent_payments: {
    category: "chain",
    request: "yes",
    purpose: "One row per allowed pay.agent decision: who asked, the recipient wallet and amount Agent Guard allowed, and, once confirmed, the USDG transfer found on Robinhood Chain and the signed payment receipt. Anyroute never holds or moves this money; no balance changes. Disabled unless AGENT_PAY_ENABLED.",
    retention: KEPT + " The status changes from seen to final at the chain's finality point, or to reversed if the transfer leaves the canonical chain within ESCROW_REORG_HORIZON_BLOCKS.",
    notes: ["Recipient and payer wallets and the transaction are public on chain and can be correlated with the agent key that asked. Paying a public profile id also stores that profile and its key hash, so the recipient's owner sees the payment in their inbox. An optional memo is accepted only as a SHA-256 digest; the memo itself is never sent to the router."],
    columns: {
      decision_id: "The Agent Guard decision (agent_action_decisions.id) this payment belongs to; random, not a credential.",
      key_hash: "Hash of the paying agent key; only that key confirms the payment.",
      account_id: "Account of the paying key, whose linked wallets may send the transfer.",
      policy_sha256: "Digest of the rulebook (or sorted rulebook digests) the decision was made under.",
      recipient_profile: "Public profile id that was paid, or that publishes the paid wallet; null for a wallet with no single profile.",
      recipient_key_hash: "Key hash behind that profile, used only to show the payment in its owner's inbox; never returned publicly.",
      recipient_wallet: "Lowercase 0x wallet that receives the USDG.",
      amount_units: "Allowed amount in USDG base units (6 decimals).",
      memo_sha256: "Optional SHA-256 digest of the payer's memo; the memo is not stored.",
      status: "awaiting_transfer, seen (waiting for finality), final or reversed.",
      status_at: "When the status last changed.",
      created_at: CREATED,
      tx_hash: "The confirming Robinhood Chain transaction (public); unique with its log index.",
      log_index: "Log index of the USDG Transfer that pays the decision.",
      block_number: "Block of that transfer.",
      block_hash: "Canonical hash of that block when last checked.",
      payer_wallet: "Linked wallet the USDG was sent from.",
      paid_units: "USDG base units actually transferred; counted against the daily action limit.",
      verified_at: "When the router first verified the transfer.",
      checked_at: "When it was last re-verified.",
      reason: "Fixed reason text when a payment is reversed.",
      receipt: { purpose: "The signed payment receipt payload (anyroute.agent.payment.v1): decision, rulebook digest, payer, recipient, amounts, chain, transaction, block and status.", review: JSON_FIELDS("Canonical JSON built by src/agents/pay.ts from the fields of this row; wallets, hashes, amounts and fixed codes only, no request or answer text.") },
      receipt_sig: "Ed25519 signature over the canonical receipt, by the router's receipt key; re-signed on each status change.",
      receipt_key_id: "Id of the receipt key that signed it.",
    },
  },
};

export const agentPayRateFamily: RedisFamily = {
  key: "rl:agent-pay:<key hash>:<window start>",
  purpose: "Payment confirmations and reads per minute for one agent key (60); each can read the chain.",
  holds: "key-hash", limiterPrefix: "agent-pay:", windowSeconds: 60, ttl: windowTtl(60),
  evidence: [ev("src/api/agent-pay.ts", "await ctx.limiter.take(`agent-pay:${key.keyHash}`"), ev("src/lib/ratelimit.ts", "const k = `rl:${key}:${start}`;"), ev("src/lib/ratelimit.ts", "await this.redis.pexpire(k, windowMs + 1000);")],
};

export const agentPayBodyReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/api/agent-pay.ts", carries: "settings",
  reads: "A recipient (public profile id or 0x wallet), a decimal USD amount, an optional memo digest and approval id; or a transaction hash to confirm.",
  then: "Authenticates the agent key, decides with its rulebook through Agent Guard (action pay.agent), and returns unsigned USDG transfer instructions for the payer's own wallet. A confirmation reads that transaction's receipt, Transfer logs and block hash from Robinhood Chain and signs a receipt. The router never signs or sends the payment.",
  kept: "agent_payments and the existing Agent Guard decision, outcome and decision-chain records. One new rate-limit family; no caller-address reader or log field.",
  evidence: [ev("src/api/agent-pay.ts", "payInput.parse(await readJson(c))"), ev("src/api/agent-pay.ts", "confirmInput.parse(await readJson(c))")],
};
