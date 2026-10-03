# Dune: the commerce ledger from chain data alone

[`commerce.sql`](commerce.sql) is a DuneSQL query that recomputes the on-chain part of Anyroute's commerce ledger
(`GET /api/v1/commerce/stats`, the `/commerce` page) from public Robinhood Chain data, without asking the router. It has
not been published as a Dune dashboard yet.

The methodology is on the site at `/docs/#commerce-stats`. This file lists what the query assumes and where its
numbers can differ from the router's.

## Run it

1. Open a new query on Dune and paste `commerce.sql`.
2. Fill in `params` and the four address lists from the router you are checking:

   | In the query | Where to read it |
   | --- | --- |
   | `usdg` | `data.chain.usdg` in `GET /api/v1/status` (`0x5fc5…d168` on Robinhood Chain) |
   | `pay_to` | the x402 `payTo` in any `402 Payment Required` response from the router (`X402_PAY_TO`) |
   | `receipt_anchor` | `data.chain.contracts.receiptAnchor` in `GET /api/v1/status` |
   | `from_block`, `min_units`, `hub_fanout` | `data.filters.funding` in `GET /api/v1/commerce/stats` |
   | `router_signers` | `data.chain.signers.router` in `GET /api/v1/status` |
   | `facilitator_relayers` | the facilitator's relay wallets (`COMMERCE_RELAYER_ADDRESSES`) |
   | `operators` | `pay_to`, every address in `data.chain.signers`, treasuries (`COMMERCE_OPERATOR_ADDRESSES`) |
   | `extra_hubs` | every address in `data.chain.contracts`, plus `COMMERCE_HUB_ADDRESSES` |

3. Run it. Each row is a window (`24h`, `7d`, `30d`) and a kind (`model.call`, `facilitator.settle`, `all`), with the
   gross and filtered figures side by side and the count excluded by each rule.

## Assumptions

- **Chain tables.** The query reads `robinhood_chain.logs` with Dune's standard EVM columns (`block_time`,
  `block_number`, `tx_hash`, `index`, `tx_from`, `contract_address`, `topic0` to `topic2`, `data`). If Dune names the
  Robinhood Chain (chain id 4663) dataset differently, or does not index it, change the table name or run the same SQL
  on any copy of the chain's raw logs.
- **What a settlement is.** A USDG `Transfer` in a transaction that also has `AuthorizationUsed` by the sender (an
  EIP-3009 authorization the payer signed), sent to `pay_to` (a model call paid with x402) or relayed by a
  `facilitator_relayers` wallet (a facilitator settlement). Transfers the router relays to CallPay are not counted.
- **Amounts** are read from the low 8 bytes of the value word, which holds any USDG amount below about 9.2 trillion
  USDG.
- **Anchored.** ReceiptAnchor windows are contiguous and half-open, so a settlement counts as anchored when it happened
  before the end (`toTs`) of the newest `Anchored` window. The router checks each receipt's own anchor instead.
- **Funding links** use 2 hops, the router's default (`COMMERCE_FUNDING_HOPS`). Edges are transfers of at least
  `min_units` between two different wallets that are not settlements as defined above. A hub (the zero address, USDG,
  `extra_hubs`, any wallet that funded more than `hub_fanout` distinct wallets) is never a shared funder or a stop on
  a path.
- **Round trips** are a settlement back from payee to payer, or any plain USDG transfer back, within 24 hours either
  side of the settlement.
- **Medians** are exact: the middle amount, or the floor of the mean of the two middle amounts.

## Where the router and Dune can differ

- **Receipts.** The router excludes a payment whose call produced no receipt, and a receipt anchored later than the
  next window. Dune cannot see receipts, only anchor windows.
- **Time.** The router times a settlement when it records the payment; Dune uses the block time. A settlement a few
  seconds from a window edge can fall on different sides.
- **Off-chain data.** Refunds, owner keys, and settlements paid from prepaid balances (tool calls, for example) are not
  on chain. The router uses them; Dune shows no refund rate and only the on-chain kinds.
- **Index lag.** The router's funding filter reads its own copy of USDG transfers up to `indexed_block`
  (`data.filters.funding`); transfers after that block are not yet considered.
- **Lanes.** Neither side splits by privacy lane: the chain has no lanes, and the router never publishes them here.
