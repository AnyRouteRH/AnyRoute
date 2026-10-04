import type { TableDoc } from "../types.ts";
import { CREATED, JSON_FIELDS, KEPT, rv } from "./common.ts";

// Billing: money in pico-USD (1e-12 USD) unless a column says USDG base units. Nothing here refers to what a call said.

export const billingTables: Record<string, TableDoc> = {
  accounts: {
    category: "billing",
    purpose: "One row per billing account: an API-key account or a wallet account, with its settled balance and the amount held for calls in flight.",
    request: "no",
    retention: "No automatic deletion. The ledger refers to accounts and is append-only, so an account row stays.",
    columns: {
      id: "The account id. For a wallet account it is derived from the wallet address.",
      inference_keys_default: "Whether newly provisioned child keys default to inference-only access. Management keys can explicitly select account scope.", // ZK6
      kind: "key for an API-key account, wallet for a wallet account.",
      wallet: "The wallet address of a wallet account. Empty for a key account.",
      balance: { purpose: "The spendable balance, including provisional deposit credits: the sum of the account's ledger lines, in pico-USD. A database trigger keeps it equal to that sum.", request: "aggregate" },
      held: { purpose: "The amount reserved by open holds for calls in flight, in pico-USD.", request: "aggregate" },
      created_at: CREATED,
    },
  },

  ledger: {
    category: "billing",
    purpose:
      "The append-only money ledger: deposits, credits, usage charges, refunds, withdrawals and adjustments. A usage line names the generation it paid for; it does not say what the call was about.",
    request: "yes",
    retention: "The database refuses every update and delete on this table (trigger ledger_no_update), so lines are kept permanently.",
    columns: {
      id: "Ledger line id.",
      account_id: "The account the line applies to.",
      key_hash: "The key hash the line came from, when there is one.",
      amount: "The signed amount in pico-USD: positive adds to the balance, negative takes from it.",
      kind: "What the line is: provisional (early escrow credit), deposit, credit, usage, refund, paywith, change, adjustment, withdrawal_lock, withdrawal, blind_purchase, tool_call (a paid x402 tool), data_tool (a market-data tool call) and similar.",
      ref: "A unique idempotency reference, such as usage:<generation id> or escrow:<transaction>:<log index>, so a line can never be posted twice.",
      generation_id: { purpose: "For a usage line, the generation it paid for.", request: "yes" },
      description: {
        purpose: "A short line written by the router, such as \"<model> via <provider>\", \"USDG deposit <transaction hash>\" or \"Model usage\". Never text from a request.",
        review: rv(["name:content"], "no-request-content", "Every description is built in code from model ids, provider ids, transaction hashes and fixed phrases (ledger.ts, escrow.ts, indexer.ts); no caller-supplied string is used."),
      },
      created_at: CREATED,
    },
  },

  holds: {
    category: "billing",
    purpose: "A reservation of balance made before a call runs, settled to the real cost afterwards or released. One hold per call.",
    request: "yes",
    retention: "The database refuses to delete holds (trigger holds_apply_held), so they are kept permanently.",
    columns: {
      id: "Hold id; for a chat call it is the generation id.",
      account_id: "The account the amount is reserved on.",
      key_hash: "The key hash that made the call, when there is one.",
      amount: "The reserved amount in pico-USD; it cannot change after creation.",
      status: "held, settled or released.",
      kind: "What the hold was for; usage for a call, tool_call for a paid x402 tool, data_tool for a market-data tool call.",
      result: {
        purpose: "How the hold ended: the amount charged and any uncovered amount, as strings in pico-USD, and expired: true when the hold timed out.",
        review: JSON_FIELDS("Written only by settle() and release() in ledger.ts as { charged, uncovered, expired } amounts."),
      },
      created_at: CREATED,
      expires_at: "When an unsettled hold is released automatically (the holds-expire job).",
    },
  },

  quotes: {
    category: "billing",
    purpose: "A price quoted for one pay-per-call request (HTTP 402 and x402), so a payment can be matched to exactly the request it was for.",
    request: "yes",
    retention: KEPT,
    columns: {
      nonce: "The quote id (32 bytes hex). For an x402 payment claim it is x402:<payer wallet>:<authorization nonce>.",
      price_usdg: "The quoted price in USDG base units (1e-6).",
      price_pico: "The same price in pico-USD.",
      request_sha256: {
        purpose: "SHA-256 of the request the quote is for. It binds the quote to that one request; the request cannot be recovered from it.",
        review: rv(["name:content"], "digest-only", "A hash of the request body, used to check that a payment belongs to the request it quoted."),
      },
      model_id: "The model the quote is for.",
      expires_at: "When the quote stops being payable.",
      status: "open, paid, used, expired or failed.",
      payer: "The wallet address that paid, once a payment is seen.",
      tx_hash: "The payment transaction.",
      account_id: "The account the payment was credited to.",
      created_at: CREATED,
    },
  },

  settlements: {
    category: "billing",
    purpose: "What one provider is owed for one UTC hour: token totals, request count, upstream cost, the router's fee and the USDG owed. Network hosts use only confirmed per-host receipts and the configured network fee; their period is the accrual hour.",
    request: "aggregate",
    retention: KEPT,
    columns: {
      provider_id: "The provider owed.",
      period: "The UTC hour, such as 2026-09-26T13.",
      tokens: "Total tokens invoiced in the hour; network hosts include only newly eligible anchored work.",
      requests: "Number of calls invoiced in the hour; network hosts include only newly eligible anchored work.",
      upstream: "Upstream cost for the hour, in pico-USD.",
      fee: "The router's fee for the hour, in pico-USD.",
      usdg_owed: "USDG base units owed to the provider for the hour.",
      payout_id: "The payout that included the hour, once paid.",
      paid_tx: "The transaction that paid it.",
      created_at: CREATED,
    },
  },

  payouts: {
    category: "billing",
    purpose: "A payout to a provider: the amount in USDG, where it went and its status.",
    request: "no",
    retention: KEPT,
    columns: {
      id: "Payout id.",
      provider_id: "The provider paid.",
      usdg: "Amount in USDG base units.",
      to: "The destination address for the payout.",
      status: "pending, submitted, paid or invoice.",
      tx: "The payment transaction.",
      created_at: CREATED,
    },
  },

  royalties: {
    category: "billing",
    purpose: "The royalty a model's creator earned in one period, and whether it was claimed.",
    request: "aggregate",
    retention: KEPT,
    columns: {
      model_id: "The model.",
      period: "The settlement period.",
      amount: "Royalty in pico-USD.",
      usdg: "Royalty in USDG base units.",
      creator: "The creator's payout address, when one is known.",
      stream_tx: "The transaction that streamed the royalty.",
      claimed: "Whether the creator claimed it.",
    },
  },
};
