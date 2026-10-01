# Agreement contracts

The agreement contracts are not switched on yet. They are an ERC-8183-shaped job and milestone escrow, not an implementation of that standard's ABI. This package adds no agreement HTTP endpoints, chain indexer, model-jury service or automatic transaction sender.

## Funds and lifecycle

`AgreementEscrow` has an immutable IERC20 USDG address, review window and `DISPUTE_TIMEOUT` (7–180 days). Amounts are token base units; USDG uses six decimals, so 1 USDG is 1,000,000 units. The payer approves the escrow and calls `createAgreement(payee, termsHash, amounts, deadline, disputeOracle)`. There must be 1–64 positive milestone amounts, a future deadline, a different nonzero payee and an oracle contract. The whole amount is transferred from the payer in that transaction. Funding must increase the escrow balance by exactly that amount; fee-on-transfer and rebasing assets are unsupported. Select the canonical USDG contract before deployment.

Each milestone progresses independently:

- **Funded:** only the payee may submit a nonzero delivery digest, through the deadline inclusively. Delivery is a claim by the payee, not proof of satisfactory work. After the deadline, only the payer may refund an undelivered milestone with `refundAfterDeadline(id, milestone)`.
- **Delivered:** only the payer may call `release`. Either party may call `openDispute` with a nonzero evidence digest through `submittedAt + reviewWindow` inclusively. The payee may call `claimAfterTimeout` strictly after that time. Delivery at the deadline still receives the full review window. The agreement deadline cannot refund delivered work.
- **Disputed:** releases, review-timeout claims and deadline refunds are blocked for this milestone. Its recorded oracle may call `rule(id, milestone, payeeBps)` strictly before `disputedAt + DISPUTE_TIMEOUT`. At or after that timestamp, rulings are refused and anyone may call `resolveStaleDispute(id, milestone)`. This neutral default splits the milestone 50/50: the payer receives floor(amount / 2) and the payee receives the rounding remainder. The clock starts when the dispute opens, and a hung tally or authority change cannot extend it.
- **Settled:** cannot be settled or disputed again. A 10,000 bps ruling pays the payee, 0 refunds the payer, and intermediate values split. Payee units round down; the remainder goes to the payer, conserving the full amount.

Events expose creation, milestone funding, delivery, release, timeout claim, deadline refund, dispute, oracle ruling, stale-dispute recovery (`StaleDisputeResolved`) and both payout amounts. Effects precede token transfers and mutating paths have a reentrancy guard. A failed token transfer rolls the entire settlement back. There is no owner, administrator withdrawal, upgrade mechanism, pause or arbitrary payout recipient in the escrow. Direct token donations are not assigned to agreements and cannot be withdrawn through an administrative recovery function.

## Jury and panel

`DisputeOracle` uses two-step ownership. Its owner manages 1–32 distinct nonzero jury signer addresses, a strict-majority threshold θ of M, and a nonzero panel address outside that signer set. Jury membership changes increment a version and invalidate old signatures. Changes apply to unresolved disputes: agreement parties must trust the oracle owner to manage keys and the panel responsibly. Ownership transfer takes effect only when the nominated owner accepts.

Any relayer may submit a complete tally containing exactly one ECDSA signature from every current jury key. Each EIP-712 verdict binds the chain id, oracle, escrow address, agreement id, milestone index, immutable parties and terms, amount, delivery digest, opening evidence digest, evidence root, jury version and exact payee bps. The domain is `AnyRouteAgreementJury`, version `1`; `voteDigest` exposes the digest for the current dispute. Duplicate, unknown, stale and mismatched signatures are refused. Signer order determines bitmap bit positions, least significant bit first.

At least θ signatures must agree on the exact bps value, including the split ratio. A consensus executes the escrow ruling immediately. The record contains the evidence root, jury version, participation bitmap, consensus bitmap, tally digest, ruling path, verdict and final bps; the complete signatures and individual verdicts remain in public transaction calldata. A valid full tally without consensus records `PanelPending`. Only the configured panel may then post a ruling, using the same evidence root and any bps in 0–10,000. The panel cannot bypass a jury consensus or act before a hung tally. Its separate final verdict does not change the recorded jury tally. A final ruling is accepted only once before dispute expiry, and execution failure rolls back the oracle record so the correct transaction can be retried within that window. After expiry, new jury tallies and panel rulings are refused even if nobody has called recovery yet. A panel-pending tally remains as historical metadata after recovery; the escrow settlement and recovery events record the payouts.

## Trust and availability

The intended jury is run by AnyRoute's router on the attested lane, with a separate panel as fallback. That jury service is outside this package and is not switched on yet. The contracts verify signer authorization, not that a particular model ran, that models are independent, that evidence is correct, or that hardware attestation was checked. A majority of compromised or dishonest keys can choose an incorrect settlement. A panel can choose any split after a hung jury. Neither can pay a third party or settle another oracle's agreement. The router reads ordinary request text in memory; this package adds no prompt encryption.

A full tally requires all M signers. Missing signers or an unavailable panel can delay a ruling, but cannot remove the expiry recovery path. After the immutable timeout, any caller can settle the disputed milestone using the neutral 50/50 default, without signatures or owner cooperation. Funded undelivered milestones remain refundable by the payer after their deadline; delivered undisputed milestones remain claimable by the payee after review; ruled and expired milestones are settled once. These are callable exits, not automatic transactions: someone must submit them. USDG's own transfer restrictions or issuer controls can still prevent payouts; a failed transfer rolls back settlement and leaves the exit retryable when transfers are allowed. Direct token donations remain outside funded agreements. Parties should review the chosen token and oracle before funding.

All addresses, amounts, deadlines, review windows, dispute timeouts and opening timestamps, delivery times, digests, signatures, evidence roots, tallies, verdicts and events are public and permanent on chain. Digests are not encryption and can disclose guessable content; callers can encode arbitrary bytes in a digest field. Keep raw evidence off chain with a separately disclosed retention policy. This package adds no router database, Redis or request-body storage. The privacy inventory includes the contract state and calldata.

## Deployment controls

`AGENT_AGREEMENTS_ENABLED` defaults to false in both the router configuration loader and deployment script. The router service requires configured AGREEMENT_ESCROW_ADDRESS and DISPUTE_ORACLE_ADDRESS as well as the flag. AGENT_AGREEMENTS_RULINGS_ENABLED defaults to false; posting requires an isolated worker, funded model-call API key, logged statement key and complete authorized jury signer keys. See /docs/#agreements for the service and trust model. Contracts and service are not deployed at anyroute.tech yet. The production configuration loader accepts it while preserving all existing dependency and authority guards.

`contracts/script/DeployAgreements.s.sol` reads these environment values:

| Name | Default / requirement |
| --- | --- |
| `AGENT_AGREEMENTS_ENABLED` | false; must be true to construct contracts |
| `AGREEMENTS_BROADCAST` | false; records deployment transactions only when explicitly true |
| `OWNER` | required; initial oracle owner |
| `JURY_SIGNERS` | required; comma-separated signer addresses |
| `PANEL` | required; separate panel address |
| `USDG` | required; deployed IERC20 contract address |
| `JURY_THRESHOLD` | floor(M / 2) + 1 |
| `AGREEMENT_REVIEW_WINDOW` | 259,200 seconds (three days); allowed range 1 second–30 days |
| `DISPUTE_TIMEOUT_DAYS` | 30 days; integer range 7–180; converted to seconds for immutable `DISPUTE_TIMEOUT` |

A normal script run constructs both contracts without broadcasting and prints their addresses. Actual deployment requires the owner's explicit choice of network and sender, `AGENT_AGREEMENTS_ENABLED=true`, `AGREEMENTS_BROADCAST=true`, and Foundry's `--broadcast` option. No deployment is performed by this package's verification flow. Once deployed, the environment flag does not disable withdrawals or existing agreements and cannot pause the escrow. The review window, dispute timeout and USDG address cannot be changed. The owner must publish the selected addresses and operate the jury and panel before agreements can be offered as an active service.
