-- Anyroute commerce ledger: the on-chain-visible part, from public chain data alone (DuneSQL).
--
-- Reproduces GET /api/v1/commerce/stats for the settlements that move USDG on Robinhood Chain (chain id 4663):
-- model.call (x402 payments to the router's payTo) and facilitator.settle (EIP-3009 transfers relayed by the
-- facilitator). Read integrations/dune/README.md for every assumption and for what the router sees that the chain
-- does not (receipts per settlement, refunds, owner keys, settlements paid from prepaid balances).
--
-- Before running, set the values in `params` and the lists in `router_signers`, `facilitator_relayers`, `operators`
-- and `extra_hubs` to the router's (GET /api/v1/status: data.per_call, data.chain; and its COMMERCE_* settings).
-- The placeholder zero address in a list is harmless: it never sends a transaction, never pays and is always a hub.
--
-- One row per window (24h, 7d, 30d) and kind (model.call, facilitator.settle, all). Amounts are USDG base units
-- (6 decimals). gross_* counts every settlement; filtered_* counts only those that pass every rule; excluded_* says
-- which rule removed the others (the first that fails, in this order: unanchored, same_owner, round_trip,
-- funding_link). Refund rate is not on chain, so it is not here.

with params as (
  select
    0x5fc5360d0400a0fd4f2af552add042d716f1d168 as usdg,           -- USDG_ADDRESS
    0x0000000000000000000000000000000000000000 as pay_to,         -- X402_PAY_TO: payee of model calls
    0x0000000000000000000000000000000000000000 as receipt_anchor, -- RECEIPT_ANCHOR_ADDRESS
    cast(0 as bigint) as from_block,                              -- COMMERCE_FUNDING_FROM_BLOCK
    cast(1000000 as bigint) as min_units,                         -- COMMERCE_FUNDING_MIN_UNITS (1 USDG)
    cast(25 as bigint) as hub_fanout,                             -- COMMERCE_HUB_FANOUT
    now() as as_of
),

-- The router's relaying signer (data.chain.signers.router). It relays x402 payments to payTo, and CallPay payments that
-- the ledger does not count; neither is ever funding.
router_signers (address) as (values (0x0000000000000000000000000000000000000000)),
-- COMMERCE_RELAYER_ADDRESSES: the facilitator's relay wallets. What they relay is a facilitator settlement.
facilitator_relayers (address) as (values (0x0000000000000000000000000000000000000000)),
-- Wallets the operator controls: payTo, the router's signers, treasuries and COMMERCE_OPERATOR_ADDRESSES.
operators (address) as (values (0x0000000000000000000000000000000000000000)),
-- The router's contracts (data.chain.contracts) and COMMERCE_HUB_ADDRESSES. Zero and USDG are added below.
extra_hubs (address) as (values (0x0000000000000000000000000000000000000000)),

-- Every USDG Transfer since from_block. Topics hold 32-byte words; an address is the last 20 bytes. USDG amounts fit in
-- the low 8 bytes of the value word (more than 9.2 trillion USDG would not).
transfers as (
  select
    l.block_time,
    l.block_number,
    l.tx_hash,
    l.index as log_index,
    l.tx_from,
    bytearray_substring(l.topic1, 13, 20) as sender,
    bytearray_substring(l.topic2, 13, 20) as recipient,
    bytearray_to_bigint(bytearray_substring(l.data, 25, 8)) as units
  from robinhood_chain.logs l
  cross join params p
  where l.contract_address = p.usdg
    and l.topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef -- Transfer(address,address,uint256)
    and l.block_number >= p.from_block
),

-- EIP-3009: AuthorizationUsed(authorizer, nonce) in the same transaction marks a transfer the payer signed for.
authorizations as (
  select distinct l.tx_hash, bytearray_substring(l.topic1, 13, 20) as authorizer
  from robinhood_chain.logs l
  cross join params p
  where l.contract_address = p.usdg
    and l.topic0 = 0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5 -- AuthorizationUsed(address,bytes32)
    and l.block_number >= p.from_block
),

-- Authorized transfers to payTo or relayed by the router or a facilitator relay wallet, at any time. Never funding.
settled as (
  select t.*
  from transfers t
  cross join params p
  join authorizations a on a.tx_hash = t.tx_hash and a.authorizer = t.sender
  where t.recipient = p.pay_to
     or t.tx_from in (select address from router_signers)
     or t.tx_from in (select address from facilitator_relayers)
),

-- The settlements the windows count: the last 31 days (30 days, plus 24 hours to see a round trip across the start).
settlements as (
  select
    s.block_time as settled_at,
    s.tx_hash,
    s.sender as payer,
    s.recipient as payee,
    s.units as amount,
    case when s.recipient = p.pay_to then 'model.call' else 'facilitator.settle' end as kind
  from settled s
  cross join params p
  where s.block_time > p.as_of - interval '31' day and s.block_time <= p.as_of
    and (s.recipient = p.pay_to or s.tx_from in (select address from facilitator_relayers))
),

-- ReceiptAnchor windows are contiguous and half-open, [fromTs, toTs). A settlement counts as anchored when it happened
-- before the end of the newest anchored window (toTs is the third data word of Anchored).
anchored_until as (
  select max(from_unixtime(cast(bytearray_to_bigint(bytearray_substring(l.data, 89, 8)) as double))) as t
  from robinhood_chain.logs l
  cross join params p
  where l.contract_address = p.receipt_anchor
    and l.topic0 = 0xb9b0177c34d68a59f08b83778108259e846c10e55942e3e6aaff4419c505dd28 -- Anchored(uint256,bytes32,uint64,uint64,uint32)
),

-- Funding edges: material transfers between two different wallets that are not settlements.
edges as (
  select t.sender, t.recipient
  from transfers t
  cross join params p
  where t.units >= p.min_units
    and t.sender <> t.recipient
    and t.block_time <= p.as_of
    and not exists (select 1 from settled s where s.tx_hash = t.tx_hash and s.log_index = t.log_index)
  group by 1, 2
),

hubs as (
  select e.sender as address from edges e cross join params p group by e.sender, p.hub_fanout having count(distinct e.recipient) > p.hub_fanout
  union select address from extra_hubs
  union select 0x0000000000000000000000000000000000000000
  union select usdg from params
),

-- Plain transfers back from a payee to a payer (any positive value), for the round-trip rule.
plain as (
  select t.sender, t.recipient, t.block_time
  from transfers t
  cross join params p
  where t.units > 0
    and t.block_time > p.as_of - interval '32' day
    and not exists (select 1 from settled s where s.tx_hash = t.tx_hash and s.log_index = t.log_index)
),

-- Funding links within 2 hops (the router's default COMMERCE_FUNDING_HOPS): one side funded the other directly or
-- through one non-hub wallet, or one non-hub wallet funded both.
links as (
  select distinct s.payer, s.payee
  from settlements s
  where exists (select 1 from edges e where e.sender = s.payee and e.recipient = s.payer)
     or exists (select 1 from edges e where e.sender = s.payer and e.recipient = s.payee)
     or exists (
       select 1 from edges e1 join edges e2 on e2.sender = e1.recipient
       where e1.sender = s.payee and e2.recipient = s.payer and e1.recipient not in (select address from hubs))
     or exists (
       select 1 from edges e1 join edges e2 on e2.sender = e1.recipient
       where e1.sender = s.payer and e2.recipient = s.payee and e1.recipient not in (select address from hubs))
     or exists (
       select 1 from edges e1 join edges e2 on e2.sender = e1.sender
       where e1.recipient = s.payer and e2.recipient = s.payee and e1.sender not in (select address from hubs))
),

classified as (
  select
    s.*,
    case
      when u.t is null or s.settled_at >= u.t then 'unanchored'
      when s.payer = s.payee
        or (s.payer in (select address from operators) and s.payee in (select address from operators)) then 'same_owner'
      when exists (select 1 from settlements r where r.payer = s.payee and r.payee = s.payer and abs(to_unixtime(r.settled_at) - to_unixtime(s.settled_at)) <= 86400)
        or exists (select 1 from plain b where b.sender = s.payee and b.recipient = s.payer and abs(to_unixtime(b.block_time) - to_unixtime(s.settled_at)) <= 86400) then 'round_trip'
      when exists (select 1 from links k where k.payer = s.payer and k.payee = s.payee) then 'funding_link'
    end as excluded
  from settlements s
  cross join anchored_until u
),

windows (name, days) as (values ('24h', 1), ('7d', 7), ('30d', 30)),

scoped as (
  select w.name as window_name, w.days, c.kind, c.payer, c.payee, c.amount, c.excluded
  from classified c
  cross join windows w
  cross join params p
  where c.settled_at > p.as_of - w.days * interval '1' day
  union all
  select w.name, w.days, 'all', c.payer, c.payee, c.amount, c.excluded
  from classified c
  cross join windows w
  cross join params p
  where c.settled_at > p.as_of - w.days * interval '1' day
),

-- Exact medians: the middle amount, or the floor of the mean of the two middle amounts.
ranked as (
  select
    window_name, kind, amount, excluded,
    row_number() over (partition by window_name, kind order by amount) as gross_rank,
    count(*) over (partition by window_name, kind) as gross_n,
    case when excluded is null then row_number() over (partition by window_name, kind, excluded is null order by amount) end as filtered_rank,
    count(case when excluded is null then 1 end) over (partition by window_name, kind) as filtered_n
  from scoped
),

medians as (
  select
    window_name, kind,
    floor(avg(case when gross_rank in ((gross_n + 1) / 2, (gross_n + 2) / 2) then amount end)) as gross_median,
    floor(avg(case when filtered_rank in ((filtered_n + 1) / 2, (filtered_n + 2) / 2) then amount end)) as filtered_median
  from ranked
  group by 1, 2
)

select
  s.window_name,
  s.kind,
  count(*) as gross_settlements,
  count(case when s.excluded is null then 1 end) as filtered_settlements,
  count(distinct s.payer) as gross_payers,
  count(distinct case when s.excluded is null then s.payer end) as filtered_payers,
  count(distinct s.payee) as gross_payees,
  count(distinct case when s.excluded is null then s.payee end) as filtered_payees,
  sum(s.amount) as gross_volume_units,
  coalesce(sum(case when s.excluded is null then s.amount end), 0) as filtered_volume_units,
  max(m.gross_median) as gross_median_units,
  max(m.filtered_median) as filtered_median_units,
  count(case when s.excluded = 'unanchored' then 1 end) as excluded_unanchored,
  count(case when s.excluded = 'same_owner' then 1 end) as excluded_same_owner,
  count(case when s.excluded = 'round_trip' then 1 end) as excluded_round_trip,
  count(case when s.excluded = 'funding_link' then 1 end) as excluded_funding_link
from scoped s
join medians m on m.window_name = s.window_name and m.kind = s.kind
group by 1, 2
order by min(s.days), 2
