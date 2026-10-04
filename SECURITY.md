# Security reporting and privileged operations

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/AnyRouteRH/AnyRoute/security/advisories/new). Include affected components, a local reproduction and expected impact. Use test keys and test funds. Keep credentials, customer prompts and personal information out of reports and alert channels.

Only the current main branch is maintained. Three app contracts are published; the full core deployment and production image/TEE/KMS provenance remain unverified. There is no production security certification or response-time guarantee. Real-funds expansion requires the release and governance gates below.

## Accepted-risk register

**No audit findings have been accepted as risks.** The incomplete audit reported no confirmed findings in completed coverage; missing review is not acceptance. New exceptions require a public issue containing affected releases, impact, owner role, mitigation, expiry and independent review. Critical or High findings block release.

Known trust boundaries remain: hardware/vendor attestation, issuer/keeper reporting truth, stock-feed and liquidity availability, jury/panel discretion, and settlement proof availability. Pending bond slashes can block exits until independent governance resolves them. No permissionless expiry, staking redesign, allocation change or new economic cap is introduced by this remediation. These boundaries remain review obligations.

## Authority and holder inventory

“Planned lock” means the production deployment intent: a reviewed Safe proposes/executes a TimelockController with at least a 24-hour delay. A transfer request does not prove acceptance. All 24 owned modules expose inherited transferOwnership/acceptOwnership and, where permitted by their overrides, renounceOwnership. Review those inherited entry points with every administrative function. Deployer ownership is temporary; ordinary workers must not control approval or governance roles.

| Module / operations | Guard and operational holder | Owner/deploy holder | Bounds / events |
|---|---|---|---|
| APIU: setMinter, mint | owner; configured one-time minter | Standalone: timelock required by the plan below | Nonzero one-time minter; supply conservation; events |
| Credits: postSpentRoot, sweep; approveSpentRoot/approveSweep/revokeApprovals; setSettlement/setCreditor | SETTLEMENT; owner | Planned lock | Root/sweep approvals, amount/address checks; helper revocation emits event |
| CallPay: setTreasury | owner | Planned lock | Nonzero treasury, event |
| ProviderBond: proposeSlash/executeSlash/cancelSlash; approveSlash/revokeSlashApprovals; setSlasher/setRefundPool | SLASHER_SAFE; owner; cancellation by owner or slasher | Planned lock | Delay/dispute/approval checks; nonzero role addresses; helper events |
| AnyrStaking: notifyMargin/executeBuyback; oracle/keeper/opsWallet/adapter/maxDaily setters | configured royalty/KEEPER; owner | Planned lock | Address checks, limits; maxDaily has no upper bound; events |
| PayWithStock: token registration and router/oracle/slip setters, rescue; forceCloseSession/payCall/payCallWithAllowance | owner; ROUTER | Planned lock | bps/address/route checks and events; rescue relies on transfer event |
| AnyrPaymaster: signer/daily-cap settings, inherited EntryPoint deposit/stake withdrawals | owner; verifying signer for user operations | Planned lock | Signer nonzero; daily cap unsigned without upper bound; events |
| ReceiptAnchor: anchor/anchorAttested; signing-key registration/revocation; setAnchorer | ANCHORER or owner | Planned lock | Key/date/address checks; events |
| Royalty: register/stream; setRegistrar/setSettlement | REGISTRAR; SETTLEMENT; owner | Planned lock | Creator/weight/amount/address checks; events |
| UniswapV3Adapter: setCaller/setPath/rescue; swapExactIn/Out | owner; allow-listed callers | Planned lock | Path/address checks, rescue limits; events |
| UniswapV4Adapter: setCaller/setRoute/rescue; swapExactIn/Out; unlockCallback | owner; allow-listed callers; PoolManager callback | Planned lock | Route/address checks, callback validation; events |
| ChainlinkStockOracle: feed/multiplier/sequencer/guardian setters, pause/unpause | owner; GUARDIAN may pause | Planned lock | Feed/decimal/staleness checks; sequencer grace configurable; events |
| TwapBuybackPriceOracle: setGuardian, pause/unpause | owner; GUARDIAN may pause | Separate planned lock | Immutable oracle policy; zero guardian disables role; events |
| CapacityCommit: mint/recordDelivery; keeper/slashRecipient/discount/bondRate/reportGrace/mintPause/providerBond setters | provider operator; keeper; owner | Standalone: timelock required by the plan below | bps/grace/address checks; bond rate unsigned; events |
| IPXFeed: update; keeper/thinThreshold/maxStaleness setters | keeper; owner | Standalone: timelock required by the plan below | Round freshness/increasing timestamp; threshold unsigned; events |
| BlindIssuer: commitEpoch/recordIssuance/revokeEpoch; setIssuer | issuer or owner; owner | Standalone: timelock required by the plan below | Epoch/key/commitment checks; events |
| MeasurementRegistry: register/revoke/setAttestor | attestor or owner; owner | Standalone: timelock required by the plan below | Evidence/address checks; events |
| DisputeOracle: setJury/setPanel; postPanelRuling | owner; panel | Historical live EOA; OWNER must be the reviewed timelock | 1–32 unique jury signers, strict majority, non-overlap panel, 0–10000 bps; helper events |
| HostBond: proposeSlash/executeSlash/cancelSlash; approveSlash/revokeSlashApprovals; minBond/slasher/refundPool setters | slasher; owner; cancellation by owner or slasher | Historical live EOA; main deploy planned lock | Delay/dispute approvals; minBond/address bounds; helper events |
| SealMeasurementRegistry: publish/revoke/publisher/guardian settings | SEAL_PUBLISHER, GUARDIAN; owner | Planned lock | Manifest/validity/address checks; events |
| PolicyRegistry: publish/deprecate/publisher/guardian settings | SEAL_PUBLISHER, GUARDIAN; owner | Planned lock | TCB/version/grace/address checks; events |
| SkillRegistry: publish/setTrustLevel/revoke/publisher/guardian settings | SEAL_PUBLISHER, GUARDIAN; owner | Planned lock | Hash/trust-level/address checks; events |
| CreditMintEvents: recordPurchase/publishKeyset/setMintSigner | MINT_SIGNER; owner | Planned lock | Nonzero IDs/address, duplicates forbidden; events |
| KmsGovernance: image/compose/KMS allow-list add/remove, setKmsRoot/bumpEpoch | owner | Planned lock | Set uniqueness, root/transcript checks; events |

AgreementEscrow is ownerless: its payer, payee and selected dispute oracle are per-agreement capabilities; these are not administrative ownership roles. AnyrToken is fixed supply and ownerless. NetworkFeeBurn has fixed infrastructure/callback authorities, without mutable administration.

## Governance completion plan

1. Freeze the candidate revision, chain ID, all contract addresses, current/pending owners, Safe singleton/owners/threshold, timelock proposer/executor/admin memberships and each operational role. Record public addresses only; never record signing material.
2. Main Deploy.s.sol supplies ownership batches. Apply the same governance requirement to standalone APIU, BlindIssuer, CapacityCommit, MeasurementRegistry, IPXFeed, DisputeOracle and the separately deployed TWAP oracle. Set constructor OWNER to the reviewed timelock or prepare an explicit two-step transfer; no standalone EOA exception is approved here.
3. For historical live HostBond and DisputeOracle, independently verify current owners and propose transferOwnership(timelock) through the authorized existing authority. Schedule acceptOwnership through the timelock, wait the configured delay, then execute. Do not renounce first. Bond owner and slasher remain independent.
4. Re-read owner()==timelock and pendingOwner()==zero at a finalized block. Verify Safe and timelock policy, revoke obsolete approvals and remove deployer admin membership only after every required acceptance. Retain transactions, block hash and the passing verifier report.
5. Keep new contract mode and privileged jobs disabled until exact runtime/immutable proofs and configuration checks pass. Live transfers, external account changes and broadcasts require operator authorization; this repository change performs none.

## Administrative parameter policy

Address setters require nonzero recipients where source enforces them; code-bearing dependencies also need reviewed runtime proofs. Guardian zero values that explicitly disable a role remain allowed. Bps/quorum/TCB/validity settings retain source bounds. Host minimum bond is 5,000–100,000 USDG; CapacityCommit discount is 1–10,000 bps and report grace is 1 hour–30 days; royalty bps is 0–2,000; PayWithStock slippage cap is at most 1,000 bps. Check source constants and boundary tests for the exact deployed version.

These settings have no hard-coded maximum; they are owner-only and every change emits an event: paymaster daily cap (native base units), staking daily buyback (USDG base units), capacity bond per million units (USDG base units), and IPX thin-volume threshold (USDG base units). A governance proposal must specify old/new values, units, treasury/liquidity exposure and a rollback value. Zero may disable a lane where supported; never interpret it as an unlimited default. No new protocol upper bounds are approved. The audit's meaningful-policy-bound criterion remains open pending an economic decision.

## Emergency response

Role contacts are the security triage role (private GitHub reports), operations on-call (private alert receiver), and governance Safe quorum (authorized transaction review). Populate their private escalation routing in deployment operations; no personal contacts belong in this repository.

1. Operations on-call records finalized block/hash, affected release, readiness failures and public transaction IDs. Disable new routing/sponsorship and the affected worker job through the release configuration; preserve evidence and durable retry records.
2. The configured oracle guardian may pause unsafe pricing. Governance can set CapacityCommit mintingPaused(true), revoke pending root/sweep/slash approvals, rotate compromised operational roles and stop new settlement approvals. Follow the normal timelock; no bypass privilege is implied.
3. Preserve exits: do not pause credits withdrawals, bond exits with resolved sanctions, staking unstake/claim, APIU redemption or ownerless escrow timeout recovery. Supply the latest verified root and durable proofs. Do not delete pending signed transactions or escrow journals.
4. A pending slash is independently reviewed before cancellation/execution. Escalate unresolved proposals at 72 hours and again every day; document the adjudication result. This operational escalation cannot guarantee permissionless exit or replace an on-chain expiry policy.
5. Before resuming, reconcile balances/roots and pending submissions, verify canonical state, re-run deployment code/config checks, exercise a synthetic alert, and have governance approve the release. Review receipts/attestations and rotate credentials through private operator procedures as applicable.

Unit tests exercise pause/exit, stale-price refusal, approval revocation, invariant conservation and alert state. A live incident drill and external alert-delivery proof are still required before relying on this runbook.

## Sponsorship account semantics

Parsed execute calldata alone does not establish how an arbitrary smart account executes it. Sponsorship now requires an explicit sender/runtime-hash entry in PAYMASTER_ACCOUNT_RUNTIMES, matching deployed code at one observed block. Empty policy disables sponsorship. Counterfactual factories, EIP-7702 delegation and populated ERC-1967 proxy slots are refused; RPC failures fail closed.

Before adding an entry, independently review the account source, constructor/EntryPoint bindings and immutable execution semantics. A bytecode hash is an identity check, not a proof against custom mutable delegate dispatch. Never approve a custom upgradeable account or derive the policy solely from caller-supplied code. Existing full-operation signatures and on-chain gas caps remain unchanged. An immutable reviewed-account implementation/factory inventory is still needed before production sponsorship is enabled.
