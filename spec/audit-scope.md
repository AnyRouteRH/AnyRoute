# Frozen audit scope and evidence

Publication uses the existing private-source release checks and organization-bot mirror. The integrated source includes private main through `2d7837cb669fb15034dd2ffedecf978f62b0a473`; the current source list contains 661 files. Recorded local test counts and the 603-file coverage diagnostic describe the earlier verified snapshot. They do not attest the newly integrated features; current release checks must pass before the bot publishes this candidate.

The historical audit targeted public revision `8e93eafb261ce007147ebd275202fb45c95e006b` and recorded `full-incomplete`. This remediation starts from that revision and integrates public main through `ffe2919d09bc6ad8649fe9184c74bbad894fafae`. It is not a fresh independent security review. Before a rescore, bind release evidence to the reviewed candidate commit; do not label a committed remediation as a completed audit.

Ten core packages: root/backend, contracts, sidecar, relay, packages/client, packages/private, packages/client-py, sdks/typescript, sdks/python and sdks/go. [Explicit source file list](audit-scope-files.txt) freezes the source denominator for this remediation. Tests and build/configuration manifests are supporting evidence. UI and framework wrappers that delegate security verification are excluded. Bundled private-client code remains a shipped core artifact even when served by the UI.

Run root suites on both PGlite and PostgreSQL/Redis; sibling package suites do not run through root bun test. The core-security workflow covers all remaining package suites and retains security/deep-invariant evidence. Existing release checks cover backend, contracts, local-chain E2E and service builds. Test success is separate from remote CI execution, live verification and audit completion.

Complete the missing independent contract specialties and backend/TEE/agent/RWA lanes, then a fresh independent checker. Combined line coverage, the external-function negative-test census, mutation score and formal checks remain separate measurements. No aggregate 95% claim may reuse backend-only coverage. Missing live images, TDX/KMS policies, governance acceptance and sibling-deployment evidence remain release obligations.

See [security/governance](../SECURITY.md), [invariant test map](invariants-tests.md), [combined coverage](core-coverage.md) and [deployment build records](deployment-builds.md).
