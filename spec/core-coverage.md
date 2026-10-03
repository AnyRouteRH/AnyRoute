# Combined core coverage

Publication uses the existing private-source release checks and organization-bot mirror. The integrated source includes private main through `2d7837cb669fb15034dd2ffedecf978f62b0a473`; the current source list contains 661 files. Recorded local test counts and the 603-file coverage diagnostic describe the earlier verified snapshot. They do not attest the newly integrated features; current release checks must pass before the bot publishes this candidate.

`scripts/core-coverage.py` merges line evidence against [the scoped source list](audit-scope-files.txt). Shared source lines count once; a hit in either instrumented suite covers that line. Missing source files remain explicit and make the result incomplete. Go block ranges are a line approximation and cannot establish a strict line-coverage pass.

Download the coverage artifacts from one successful CI revision. Keep each artifact's `source-revision.txt` and `test-outcome.txt` beside its coverage file. Use the checked-out revision as `--require-revision`; mismatched revisions or unsuccessful outcomes fail before aggregation. Local remediation evidence is diagnostic; earlier package coverage is reused only for unchanged instrumented source. It is not relabeled as remote CI evidence.

```sh
python3 scripts/core-coverage.py \
  --scope spec/audit-scope-files.txt \
  --lcov .:release-evidence/backend/lcov.info \
  --lcov sidecar:release-evidence/sidecar/lcov.info \
  --python packages/client-py:release-evidence/client-py/coverage.json \
  --go release-evidence/go/coverage.out \
  --require-revision "$(git rev-parse HEAD)" \
  --minimum 95 > release-evidence/combined-coverage.json
```

This abbreviated command illustrates the formats; supply every scoped package's evidence, including Solidity and the remaining JavaScript/Python packages, before expecting completeness. Use each JavaScript artifact's package-prefix.txt to resolve relative LCOV paths. Absolute instrumented paths must resolve within the current checkout; artifacts from another filesystem layout need an explicit, reviewed path conversion before aggregation.

The pre-integration remediation snapshot measured 51,070 of 55,429 instrumented lines (92.14%), with 505 of 599 scoped files measured and 94 unmeasured. This is a measured-files percentage, not total core coverage. The final integrated source scope contains 603 files, including the new public-main hosting/configuration and payment recovery modules; current aggregation must use that expanded denominator. The Solidity instrumentation attempts did not pass: the original layout failed dependency resolution, and an isolated dependency-layout attempt reached 886 passing tests but failed two permit/signature tests under the instrumentation compiler configuration. Failed-run Solidity output was excluded. Production-compiler contract tests passed separately. A compatible Solidity coverage configuration and coverage of the remaining CLI/operations files are required before a complete measurement or a 95% claim.

The final integrated candidate aggregation measures 51,792 of 56,251 instrumented lines (92.07%), with 509 of 603 source files measured and 94 unmeasured. It remains incomplete, and failed-run Solidity output remains excluded.
