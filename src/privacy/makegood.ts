import type { ExternalDoc, TableDoc } from "./types.ts";
import { JSON_FIELDS, KEPT } from "./tables/common.ts";

// V6 R: make-good refunds (src/services/makegood.ts).
export const makegoodTables: Record<string, TableDoc> = {
  makegood_refunds: {
    category: "billing",
    purpose: "One row per call (or per unserved per-call payment) that met a make-good refund rule: the rule, the capped refund, the signed refund receipt and, for calls paid on-chain per call, the on-chain refund still owed or paid. Disabled unless MAKEGOOD_ENABLED.",
    request: "yes",
    retention: KEPT + " At most one row per source: the source id is unique, so a call is never refunded twice.",
    columns: {
      id: "Refund id, also the id of its signed refund receipt (GET /api/v1/receipts/{id}).",
      source_id: "What is refunded: the generation id, or payment:<transaction hash> for a per-call payment no provider served. Unique.",
      generation_id: "The refunded generation, whose id is also its original receipt id. Null for an unserved paid call.",
      account_id: "Account credited (or whose per-call wallet is refunded on-chain).",
      key_hash: "Hash of the API key that made the call, copied from the generation; null for a per-call wallet payer.",
      rule: "Fixed rule name: upstream_failure, fallback_price, truncated_stream, structured_output or unattested_lane.",
      status: "pending until the settlement job decides it, then issued, or void when nothing charged is left to refund.",
      amount: "Refund in pico-USD: the rule's amount capped by what the ledger charged (or, for an unserved paid call, by the payment still unspent).",
      charged: "What the ledger charged for the call, or what the unserved per-call payment was, in pico-USD.",
      evidence: { purpose: "Fixed facts behind the rule: error class counts, provider ids, token counts, costs, lane and disclosure class, a payment transaction hash or the first call id of a JSON repair.", review: JSON_FIELDS("Written only by the make-good hooks from numbers, fixed codes, provider ids, generation ids and transaction hashes; never request or answer text, headers or caller addresses.") },
      provider_id: "Provider whose failure caused the refund, when one did; null when no provider is responsible (a JSON answer that does not parse).",
      strike: "Whether the refund is also a strike against that provider (an attested-lane call served without a fresh attestation).",
      payer: "Wallet address that paid the call on-chain per call, refunded on-chain; null for credits to a prepaid balance.",
      onchain_usdg: "USDG base units owed on-chain for this refund (whole units; any remainder below one unit stays as balance).",
      payout_status: "none, owed, batched (in a signed transfer) or paid.",
      payout_id: "The makegood_payouts transfer that pays this refund.",
      receipt: { purpose: "The signed refund receipt payload (kind refund): ids, rule, amounts, settlement, provider and the evidence above.", review: JSON_FIELDS("Canonical JSON built by issueRefund from the fields of this row and the original generation id; it carries amounts, fixed codes and hashes, no request or answer text.") },
      receipt_sig: "Ed25519 signature over the canonical refund receipt, by the router's receipt key.",
      receipt_key_id: "Id of the receipt key that signed it.",
      receipt_leaf: "Hash of the signed receipt in the form receipt anchoring uses; refund receipts are not yet anchored.",
      detected_at: "When the rule was met (the call settled or failed).",
      issued_at: "When the settlement job issued or voided the refund.",
    },
  },
  makegood_payouts: {
    category: "chain",
    purpose: "On-chain make-good refund transfers: one USDG transfer from the refund treasury per payer per batch, signed and stored before it is broadcast so a retry resends the same transfer and never pays twice.",
    request: "aggregate",
    retention: KEPT,
    columns: {
      id: "Transfer id.",
      payer: "Wallet address the refund is sent to.",
      usdg: "Amount in USDG base units: the sum of that payer's owed refunds in the batch.",
      status: "signed (stored, possibly broadcast), paid (mined successfully) or failed (reverted; its refunds are owed again).",
      tx_hash: "Hash of the signed transfer transaction.",
      signed_tx_enc: "The signed transaction bytes encrypted under APP_SECRET, kept to rebroadcast the identical transfer; never the treasury key.",
      created_at: "When the transfer was signed.",
      settled_at: "When it was seen mined or reverted.",
    },
  },
};

export const makegoodStores: ExternalDoc["otherStores"] = [{
  id: "makegood-refunds", name: "Make-good refund decisions",
  purpose: "With MAKEGOOD_ENABLED (off by default), the call finaliser, the all-providers-failed path and the JSON repair check record a pending candidate when a call meets a refund rule; the hourly settlement job issues it as a ledger line linked to the generation, a signed refund receipt naming the original receipt, a refund.issued webhook reference and, for a network host that caused it, review-only host slashing evidence. Calls paid on-chain per call are refunded by the makegood-payouts job from MAKEGOOD_REFUND_PRIVATE_KEY, which refuses to run without that key.",
  holds: "Rule decisions use token counts, prices, provider ids, error classes, lane and attestation results already in router memory. The JSON rule parses the repair answer in memory only to decide whether it is JSON; the text is not stored. Refund rows keep amounts, fixed codes, ids, transaction hashes and the payer wallet address for on-chain refunds. The treasury key stays in worker memory and is never logged or stored; signed transfers are stored encrypted.",
  ttl: "Refund rows and transfers are kept with the ledger (no automatic deletion). Webhook references follow the webhook delivery retention. No new Redis family or log field carries request text or a caller address.",
  requestText: "none",
  evidence: [{ file: "src/services/makegood.ts", contains: "export async function noteServedCall" }, { file: "src/services/makegood.ts", contains: "export async function issueRefund" }, { file: "src/services/makegood.ts", contains: "export async function runMakegoodPayouts" }],
}];
