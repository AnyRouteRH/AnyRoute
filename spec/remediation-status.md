# Audit remediation status — 2026-10-02

Publication uses the existing private-source release checks and organization-bot mirror. The integrated source includes private main through `2d7837cb669fb15034dd2ffedecf978f62b0a473`; the current source list contains 662 files. Recorded local test counts and the 603-file coverage diagnostic describe the earlier verified snapshot. They do not attest the newly integrated features; current release checks must pass before the bot publishes this candidate.

The changes are prepared as local commits in the attached **audit-remediation** worktree, based on audited public commit `8e93eafb261ce007147ebd275202fb45c95e006b` and integrating public main through `ffe2919d09bc6ad8649fe9184c74bbad894fafae`. The older original checkout is preserved on a local branch. The initial write-access failure was resolved by selecting the authorized publishing account in local Git configuration. Publication and remote execution are tracked in the [public commit history](https://github.com/AnyRouteRH/AnyRoute/commits/main/) and [GitHub workflows](https://github.com/AnyRouteRH/AnyRoute/actions). Nothing was deployed, signed or broadcast. The historical provisional 6.0 grade has not been recalculated. This remediation is not the missing independent audit.

The user selected preservation of the current economics. Token allocations, administrative economic limits and pending-slash expiry policy were therefore retained. The owner subsequently approved retiring the unused token allocation contract and its margin-transfer job; the planned 5% network-fee burn remains separate and disabled, with its own executor settings. The capacity fix rejects values outside the accounting representation and saturates delivery safely; it does not change representable commitments' economics.

## Changes

- Fixed the shared client CryptoKeyPair type error and made manifest BOM handling explicit.
- Removed PGlite transaction deadlocks in webhook/activity reads and agreement key preparation. Added caller-owned database support for shared-instance tests. Made the signup-limiter test clock deterministic and the deliberately slow payment test's timeout realistic without changing its assertions.
- Added fail-closed paymaster account identity checks: explicit reviewed sender/runtime pairs, exact runtime matching at one block, and rejection of counterfactual, delegated and ERC-1967 proxy accounts. An empty `PAYMASTER_ACCOUNT_RUNTIMES` list denies sponsorship. Production enablement needs an independently reviewed inventory of immutable execution semantics; a code hash alone cannot prove custom delegate-dispatch safety.
- Rejected capacity commitments above uint128 accounting limits and avoided overflow/truncation when delivery reports are oversized. Added boundary regressions and an adapter reentrancy regression for the existing fee-burn mutex.
- Added deployment build/input binding, exact runtime and immutable verification, and rejection of presence-only startup proof. A release build record requires a clean reviewed commit, expected immutable values and reviewed external-runtime inputs.
- Added package locks, exact runtime/build pins, frozen installs, disabled install scripts, a seven-day dependency release cooldown, a patched Redis fixture, package security CI and sanitized Gitleaks scanning. CI actions and downloaded scanner artifacts are pinned.
- Added authority/pause/outflow/keeper-balance monitoring, alert fixtures, a role-based incident runbook, the authority and accepted-risk registers, the source scope and invariant/test map.
- Removed the vulnerable legacy esbuild dependency from Drizzle tooling with an exact patched override, verified schema generation, and added JavaScript/Python/Go advisory gates. Local scans report no known dependency advisories.
- Added persistent fund-liability conservation handlers for provider/host bonds, royalties, fee buybacks and real EntryPoint sponsorship. Removed weaker inline invariant-depth overrides and repaired capacity handler arithmetic.

## Report checklist disposition

| Item | Status and remaining proof |
|---|---|
| 1 — suites/builds | Local configured PostgreSQL/Redis and PGlite suites pass with the skips below; package tests/typechecks/builds and service images pass. The full encrypted recovery drill passes in a disposable container; host-tool-dependent unit cases remain skipped. |
| 2 — live verification/governance | Mismatch-failing build verifier and handoff plans implemented. Fresh complete live manifests, image/TEE/KMS provenance, operator-reviewed build inputs and actual multisig/timelock ownership acceptance remain open. |
| 3 — secrets/BOM | Local sanitized Gitleaks history/tree gate passes; exact-span toy-fixture exceptions and mutation rejection tested. Explicit BOM escape implemented. Remote execution results are recorded in GitHub workflow checks. |
| 4 — authorities/risks | Documented 24 owner modules, fixed infrastructure roles and explicit empty accepted-finding register. Live role inventory still needs reconciliation. Unknown review coverage is not accepted risk. |
| 5 — package/security CI | All ten core package gates configured, with Slither, CodeQL and JavaScript/Python/Go advisory gates. Local Slither fail-high gate and workflow lint pass. Consult the matching GitHub workflow revision for remote CI and CodeQL execution results. |
| 6 — scope/build/invariant docs | Explicit 603-file source scope, 48 candidate invariant mappings and historical three-contract build/source evidence recorded. Frozen reviewed release commit and full live-artifact records remain open. |
| 7 — installs/pins | Bun/Python package locks, frozen/locked controls, exact tool/build pins, deterministic Solidity metadata and Redis 8.0.4 fixture implemented. Go SDK has no third-party module dependencies. |
| 8 — combined coverage | Collector implemented with deduplication and revision/success checks. 92.07% over measured files, 94 scoped files unmeasured; incomplete. No 95% core coverage claim. |
| 9 — negative census | New security boundary tests pass. The manually verified function-to-unauthorized/invalid-input census across all ten packages is still open; no 90% claim. |
| 10 — operations | Read-only collector, alert rules, synthetic incident/recovery tests and runbook implemented. Operator policy inventory, supervised scraping, alert delivery and a live response drill remain open. |
| 11 — setter bounds | Existing economic policies preserved by user instruction. Units, controls and review obligations documented; new policy ranges were not invented. The rubric threshold is not claimed. |
| 12 — deep invariants | 21 invariant functions pass at 131,072 actual calls each across nine persistent-liability module groups. Transient forwarding paths retain unit/fuzz coverage. Module classification and completeness still need independent review. |

## Local verification evidence

Retained logs, exit records and diagnostic coverage are in the remediation worktree's `.audit-grade/remediation/`. Early failing iterations remain there for diagnosis; use the named successful evidence below, not an older file simply because its name contains “final.” The pre-integration `candidate-files.json` binds the earlier handoff tree by file hashes; it is not a release attestation. The committed evidence summary identifies the integrated source revision and follow-up checks.

| Check | Result | Evidence |
|---|---|---|
| PostgreSQL + Redis backend | 2,401 pass, 20 skip, 0 fail | `release-backend-pg-ready.log` |
| PGlite backend | 2,398 pass, 23 skip, 0 fail | `release-backend-pglite.log` |
| Production-compiler stateless Solidity | 910 pass, 0 fail, including fork integrations | `contracts-full.log` |
| Deep invariants | All 21 functions pass together, each at 1,024 × 128 actual calls and zero handler reverts | `publish-invariants.log` |
| Real EntryPoint lifecycle regression | 1 additional stateless test passes | `paymaster-deep.log` |
| Anvil end-to-end | 10 pass, 0 fail | `release-anvil-e2e.log` |
| Sidecar / relay / client / private / TypeScript SDK | 300 / 45 / 109 / 77 / 17 pass respectively; package typechecks and shipped builds pass | package logs; private success is `packages-private-coverage.log` |
| Python client / SDK | 79 / 49 pass; source distributions and wheels build | `packages-client-py.log`, `sdks-python.log`; refreshed metadata builds recorded in `handoff-checks.json` |
| Go SDK | Tests and vet pass | `sdks-go.log` |
| Security and configuration checks | Root typecheck, Slither fail-high, sanitized Gitleaks, actionlint and Prometheus rule fixtures pass | retained tool logs and `handoff-checks.json` |
| Service images / container smoke | Integrated API and backup images build locally; sidecar/relay prior builds remain valid; API/worker smoke passes | `release-api-image.log`, `publish-backup-image.log`, `release-container-smoke.log` |
| New coverage guard and secret-exception tests | 3 pass; revision mismatch, failed-run artifacts, changed fixture bytes and outside paths rejected | `handoff-checks.json` |

The integrated full backend runs include the coverage-helper tests. Expected skips include standalone Anvil cases and unavailable host recovery tooling; the PGlite run also skips PostgreSQL/Redis-specific cases. The separate Anvil run supplies its own passing evidence. The container recovery drill verifies encryption, corruption rejection, empty-target protection, restoration, ledger/hold reconciliation and encrypted fixture data. It does not exercise external off-site storage delivery.

The initial deep run exposed four capacity handler arithmetic failures. After repair, the integrated candidate ran all 21 invariant functions together successfully. Final backend, typecheck, API-image and smoke gates used the application/test sources at `16e67db1b7bdfea4872d567f368b3512169ff1a1`, including the subsequently published x402 payment recovery changes. The deep invariant gate used `333f983dc05699005a78fb01f6039773fe00808b`; contract and sibling-package files are unchanged between those revisions, so their earlier verification remains valid. Subsequent edits are documentation only. The esbuild development-tool override also passed frozen installation and schema generation checks. See `spec/remediation-evidence.json` for a portable result summary.

## Open work and limits

The first integrated release run exposed a PostgreSQL timestamp-serialization error in newer facilitator listing updates. The comparison now uses the schema-aware Drizzle operator, retaining the atomic stale-signature check; the full facilitator suite passes against PostgreSQL. Follow-up CodeQL findings led to heartbeat symlink protection and parsing regressions. See [automated analysis review](codeql-review.md) for source-bound findings and remaining independent review obligations.

Solidity coverage was stopped after two materially different attempts: the normal layout failed dependency resolution; an isolated dependency layout compiled and reached 886 passing tests but failed two permit/signature tests under the coverage compiler configuration. Production-compiler tests pass. Failed-run Solidity LCOV was excluded. The next step is a compatible instrumented compiler/Foundry configuration, followed by a complete source-denominator measurement; the Go block-to-line approximation also needs resolution for a strict line metric. See `spec/core-coverage.md`.

The original audit's missing contract specialties, independent off-chain/TEE/agent/RWA lanes and fresh checker remain unperformed. Complete these on a reviewed frozen candidate before rescoring. Complete the negative-test census and live proof/governance work above. Mutation/formal measurements and portfolio policy evidence remain follow-ups. Pending-slash exit liveness still depends on privileged adjudication; the runbook adds escalation, not permissionless expiry.

Production configuration must supply reviewed sponsorship accounts, reviewed deployment build inputs and the chain-monitor policy/alert delivery. None was populated with guessed approvals or copied live values. Temporary task databases and containers are removed after verification; built images and retained evidence remain local. See the matching GitHub workflow revision for remote execution results.
