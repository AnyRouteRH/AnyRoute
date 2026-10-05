# Circuit breaker contract

Optional rulebook v1 `breakers` fields:

- `max_spend_usd_per_minute`: positive USD, at most 1,000,000.
- `max_requests_per_minute`: positive safe integer.
- `max_denials_per_10min`: positive safe integer.
- `max_distinct_models_per_hour`: positive safe integer.

No defaults are inserted. Omission preserves existing canonical JSON, SHA-256 and
policy behavior. The existing `AGENT_POLICY_ENABLED` flag defaults to false.

State extends the cap state with `breakers: { spent_minute_pico,
requests_minute, denials_10min, distinct_models_hour }`. Evaluation is deterministic
and requires this state when nonempty breaker limits are supplied. No state is
read or recorded for existing rulebooks without breakers.

Reason codes are `breaker:max_spend_usd_per_minute`,
`breaker:max_requests_per_minute`, `breaker:max_denials_per_10min` and
`breaker:max_distinct_models_per_hour`. A recorded value at or above its limit
refuses the next admission. Rolling intervals exclude the lower boundary and
include the evaluation time. Spend uses negative usage ledger entries from the
last minute plus all open usage holds. Parent rulebooks include session spend.

Each admission batch with breakers records one `breaker_request` event before
its per-intent decision events. It uses only the existing Intent projection,
including an `intents` array for multiple models. Requests include allowed,
denied, approval-required and already-killed attempts. Denials count batches
with decision `deny`. Distinct models include denied/approval-required intents.
Legacy decision events without a batch marker count individually; a multi-model
legacy batch can contribute several request observations. An MCP tool admission
and a subsequent routed inference admission count separately. Session admissions
are recorded under every applicable rulebook, including their parent's.

Account locking serializes counter reads, event writes, kill state and spend
reservations across replicas. A trip commits the existing kill switch with the
first breaker reason (spend, requests, denials, models order), records the denied
intent and a killed event, and returns HTTP 403 `agent_killed`. No reservation or
charge is made for that refused request. Breakers kill even with `on_breach: deny`
and always restrict, never authorize. Principal approval cannot bypass a trip.

Resume remains principal-only. Its existing `resumed` event resets breaker
observations by event ID and resets the spend window to that timestamp; earlier
holds are excluded from breaker spend after resume. Budget-cap state is unchanged.
In-flight work can complete and later charges can cause another trip. Policy
updates preserve kill state and do not reset counters. Dry runs record nothing
and do not change kill state.

Breakers also refuse estimates that would exceed the minute spend limit and
model sets that would exceed the distinct-model limit, before any reservation.
Equality is permitted for a new estimate or model set; the next admission trips
at the recorded threshold. Final charges may exceed estimates. Per-request and
rolling caps remain independent. Event counters depend on retained events; the
existing retention worker keeps events for 90 days. No additional tables, Redis
families, logs, prompt fields or response fields are introduced.

Enforcement is by Anyroute's router for requests through Anyroute only, with no
on-chain enforcement. Ordinary inference paths still read request text in router
memory and at the answering provider. Breaker events never store that text.
