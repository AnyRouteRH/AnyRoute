# Invariants and executable evidence

This map accounts for 35 retained single-contract, 6 cross-contract and 3 economic candidates in the historical audit x-ray. I-1–I-4 were retired with the unused token allocation contract; their numbers are preserved for the remaining historical references. Candidates are not automatically true invariants: I-5 and I-15 require the qualifications below; I-11–I-13/E-2 and X-3 contain off-chain/deployment assumptions. Test references identify exercised behavior, not formal proofs or complete input coverage.

| Candidate | Rule / qualification | Executable evidence |
|---|---|---|
| I-5 | Qualification: charges respect the cap at authorization/execution; lowering a session cap can leave historical spend above the new cap. The unqualified x-ray hypothesis is not adopted. | [invariant_chargesWithinTheirBounds](../contracts/test/PayWithStockInvariants.t.sol) |
| I-6 | maxSlipCapBps <= HARD_MAX_SLIP_BPS (1000). | [test_slippageAboveCapReverts](../contracts/test/PayWithStock.t.sol) |
| I-7 | A charge nonce and a nonzero usage commitment are consumable once per key, including across authorization epochs. | [test_payCallRevokedEpoch](../contracts/test/PayWithStock.t.sol) |
| I-8 | Recorded allowance spend never exceeds its registered maxRawTotal. | [testFuzz_allowanceLimits](../contracts/test/PayWithStock.t.sol) |
| I-9 | totalSwept <= spentRoot[latestEpoch].totalSpent. | [invariant_balanceIdentity](../contracts/test/Credits.t.sol) |
| I-10 | withdrawn[keyHash] <= deposited[keyHash]. | [invariant_solventAndBounded](../contracts/test/Credits.t.sol) |
| I-11 | Settlement cumulativeSpent must never exceed the key deposited-minus-withdrawn amount, including absence-proof exits. | [invariant_settlementBearsOmissions](../contracts/test/Credits.t.sol) |
| I-12 | The router stops serving or reserves the pending amount after WithdrawalRequested until finalization/cancellation. | [test/payments.test.ts](../test/payments.test.ts) |
| I-13 | Every posted spent-root leaf remains available to construct withdrawal proofs. | [test/contract-path-guards.test.ts](../test/contract-path-guards.test.ts) |
| I-14 | Withdrawal finalization uses latest root with asOf >= request time or waits at least ESCAPE_DELAY (7 days), while retaining proof verification. | [invariant_solventAndBounded](../contracts/test/Credits.t.sol) |
| I-15 | Qualification: new/top-up bonds meet the minimum. Legitimate slashes can leave a nonzero bond below the minimum; routing uses active eligibility. The unqualified hypothesis is not adopted. | [test_bond_topUpAfterSlashMustReachMinimum](../contracts/test/ProviderBond.t.sol) |
| I-16 | Provider pendingSlashes tracks Pending proposal count; Pending proposals become Cancelled or Executed once. | [invariant_bondsAndSanctionsConserveAllFunds](../contracts/test/BondConservation.invariant.t.sol) |
| I-17 | Host pendingSlashes tracks Pending proposal count; Pending proposals become Cancelled or Executed once. | [invariant_bondsAndSanctionsConserveAllFunds](../contracts/test/BondConservation.invariant.t.sol) |
| I-18 | HostBond.minBond remains between MIN_BOND_FLOOR (5000e6) and MIN_BOND_CEILING (100000e6). | [testFuzz_setMinBondBounds](../contracts/test/seal/HostBond.t.sol) |
| I-19 | Slash execution is no earlier than proposal timestamp+72 hours and requires current independent approval. | [testFuzz_executeRespectsDisputeWindow](../contracts/test/seal/HostBond.t.sol) |
| I-20 | Bond withdrawals wait 14 days after the most recent request and require no pending slashes at payout. | [test_withdraw_revertsSlashPending_thenCancelledUnblocks](../contracts/test/ProviderBond.t.sol) |
| I-21 | CapacityCommit.discountBps is in [1,10000]; snapshots retain the discount/cap at posting. | [test_post_discountIsFixedAtPostTime](../contracts/test/CapacityCommit.t.sol) |
| I-22 | CapacityCommit.reportGrace is between 1 hour and 30 days. | [test_admin_setters](../contracts/test/CapacityCommit.t.sol) |
| I-23 | Each commitment has deliveredUnits <= tokensPerDay*durationDays and mintedApiu <= capApiu. | [invariant_openCapacityIsTheSumOfOpenCaps](../contracts/test/CapacityCommitInvariants.t.sol) |
| I-24 | Commit lifecycle is Open → Finalized → Closed, with no reverse path. | [test_lifecycle](../contracts/test/CapacityCommit.t.sol) |
| I-25 | APIU.minter can be assigned once and cannot be changed through authored APIs. | [test_setMinter_onlyOnce](../contracts/test/APIU.t.sol) |
| I-26 | Router anchors have nonempty ordered half-open windows that do not overlap the previous anchor and do not end in the future. | [testFuzz_anchor_sequence](../contracts/test/ReceiptAnchor.t.sol) |
| I-27 | Receipt signing-key public bytes are never overwritten; revocation is one way. | [test_revokedKeyCannotBeReRegistered](../contracts/test/ReceiptAnchor.t.sol) |
| I-28 | Blind issuer epoch commitment is one-shot; key IDs are globally unique and revocation is irreversible. | [test_revokedEpochCannotBeCommittedAgain](../contracts/test/BlindIssuer.t.sol) |
| I-29 | MeasurementRegistry records are once-only per provider/image, and revocation is irreversible. | [test_register_revokedRecordCannotBeReRegistered](../contracts/test/MeasurementRegistry.t.sol) |
| I-30 | SEAL manifests are once-only per imageDigest and cannot be restored after revocation. | [test_revocationIsPermanent](../contracts/test/seal/SealMeasurementRegistry.t.sol) |
| I-31 | Skill publication and revocation are one way per skillHash; live trustLevel stays in [1,3]. | [contracts/test/seal/SkillRegistry.t.sol](../contracts/test/seal/SkillRegistry.t.sol) |
| I-32 | Published PolicyRegistry acceptedTcbStatuses uses only defined nonzero status bits and excludes TCB_REVOKED. | [testFuzz_revokedBitAlwaysRejected](../contracts/test/seal/PolicyRegistry.t.sol) |
| I-33 | Milestones cannot leave Settled and settle only via their authorized Funded/Delivered/Disputed exit. | [invariant_everyFundedUnitIsPaidOrHasAReachableExit](../contracts/test/agents/AgreementLiveness.invariant.t.sol) |
| I-34 | Each escrow settlement splits the fixed milestone amount, with payee=floor(amount*bps/10000) and payer=remainder; stale recovery gives payer=floor(amount/2), payee=remainder. | [testFuzzStaleSplitConservesEveryBaseUnit](../contracts/test/agents/Agreements.t.sol) |
| I-35 | Escrow oracle ruling is accepted strictly before dispute expiry; stale resolution is available at or after the same expiry. | [testExpiredJuryAndDirectRulingsRefusedBeforeRecovery](../contracts/test/agents/Agreements.t.sol) |
| I-36 | A ruling record follows None → Jury or PanelPending → Panel; completed rulings are not overwritten. | [testEachJuryRulingKind](../contracts/test/agents/Agreements.t.sol) |
| I-37 | Jury size is 1..32, threshold is a strict majority and <= signer count, and panel is outside the unique nonzero signer set. | [testOwnershipAndJuryBounds](../contracts/test/agents/Agreements.t.sol) |
| I-38 | AnyrPaymaster sender usage.day never moves backwards; reconciliation only changes the currently matching reservation bucket. | [test_bucketNeverMovesBackwards](../contracts/test/AnyrPaymaster.t.sol) |
| I-39 | NetworkFeeBurn operation ID is recorded once and its burn flag is one-way. | [test_swapThenBurnAndDuplicateRefusal](../contracts/test/NetworkFeeBurn.t.sol) |
| X-1 | When APIU.minter is the scoped CapacityCommit, totalSupply <= openCapacityApiu across all authored supply/capacity writers. | [invariant_supplyNeverExceedsOpenCapacity](../contracts/test/CapacityCommitInvariants.t.sol) |
| X-2 | With TwapBuybackPriceOracle selected, NetworkFeeBurn accepts only the oracle's pinned adapter and canonical single-hop pool route. | [test_pausedOrReroutedOracleStopsBuybacks](../contracts/test/TwapBuybackPriceOracle.t.sol) |
| X-3 | PayWithStock credits.credit uses the same immutable USDG token that PayWithStock swaps and approves. | [test/deployment-verification.test.ts](../test/deployment-verification.test.ts) |
| X-4 | DisputeOracle signed votes bind the immutable parties/terms/value and current delivery/dispute evidence from the targeted escrow, while final payout remains limited by escrow lifecycle. | [testDomainAndJuryVersionPreventReplay](../contracts/test/agents/Agreements.t.sol) |
| X-5 | CapacityCommit counts delivery only against an existing matching router receipt anchor overlapping the commitment term. | [test_recordDelivery_anchorMustExistAndMatch](../contracts/test/CapacityCommit.t.sol) |
| X-6 | NetworkFeeBurn enforces its own keeper/adapter/oracle/cap settings, and cap changes preserve current-day usage. | [test_dailyCapAndKeeperRestriction](../contracts/test/NetworkFeeBurn.t.sol) |
| E-1 | With the scoped one-shot minter binding, aggregate prepaid APIU supply is bounded by remaining recorded commitment capacity across mint, redeem and close paths. This is recorded capacity backing, not proof that inference is delivered. | [invariant_supplyNeverExceedsOpenCapacity](../contracts/test/CapacityCommitInvariants.t.sol) |
| E-2 | USDG credit exit and settlement solvency additionally require truthful covered spend, pending-withdrawal reservation and durable leaf availability. | [test/contract-path-guards.test.ts](../test/contract-path-guards.test.ts) |
| E-3 | Every properly funded milestone has one terminal payout split conserving its recorded base units, and an expired dispute has a fixed 50/50 exit independent of oracle/jury cooperation. Token transfer restrictions can still cause payout attempts to revert. | [invariant_everyFundedUnitIsPaidOrHasAReachableExit](../contracts/test/agents/AgreementLiveness.invariant.t.sol) |

## Stateful money-module coverage

| Fund/accounting module | Suite and checked accounting |
|---|---|
| Credits | Credits.t.sol: balance identity, exit bounds, omitted-root/top-up obligations |
| APIU / CapacityCommit | CapacityCommitInvariants.t.sol: supply/capacity, minted-minus-redeemed, exact bond custody |
| PayWithStock | PayWithStockInvariants.t.sol: authorized spend, nonce/allowance/cap bounds and credit custody |
| AgreementEscrow | AgreementLiveness.invariant.t.sol: every funded unit is paid or retains its tested exit |
| ProviderBond / HostBond | BondConservation.invariant.t.sol: bonded liabilities, deposits, exits, sanctions, refund-pool receipts and pending counts |
| Royalty | RoyaltyConservation.invariant.t.sol: creator claims remain backed across registration/transfer and conserve streams |
| NetworkFeeBurn | NetworkFeeConservation.invariant.t.sol: USDG input and held/dead-address output reconcile with unique operations |
| AnyrPaymaster / EntryPoint | PaymasterConservation.invariant.t.sol: deposits minus withdrawals and actual gas charges equal EntryPoint custody; beneficiaries/recipients reconcile |

```sh
FOUNDRY_PROFILE=audit forge test --root contracts --match-test invariant_
```

The audit profile uses 1,024 runs × 128 depth. Count **actual** calls from successful logs; a configured depth, discarded/reverted call or failed suite is not qualifying evidence. Source-level run/depth overrides were removed. Handler edge arithmetic is bounded before addition; invalid business operations are preconditioned/no-ops or expected rejections without weakening the conservation assertions. Lifecycle regressions ensure new handlers exercise real deposits, exits, claims and gas charges.

CallPay and swap adapters are transient forwarding paths rather than persistent user-liability ledgers; their transfer/refund/reentrancy/fuzz tests remain in their unit suites. AnyrToken is fixed supply, APIU is included through capacity accounting, and oracle/registry modules do not hold user funds. This classification does not exclude rescue and external-token behavior from security review.

[Chain incident drill](../test/chain-monitor.test.ts), [compiled runtime proof](../test/runtime-proof.test.ts), [build input binding](../test/deployment-build.test.ts), [sponsorship account identity](../test/paymaster-account-policy.test.ts), and [PGlite/PostgreSQL jury retry](../test/agreements.test.ts) cover the additional remediation boundaries.

Pending work remains: fresh independent review, a manually verified external-mutator negative-test census across all ten packages, combined complete-source coverage, and formal/mutation measurements. Do not infer a 90% negative-test score or 95% coverage from this map.
