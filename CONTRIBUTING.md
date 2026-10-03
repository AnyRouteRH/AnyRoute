# Contributing to Anyroute

Start with an issue describing the behavior you want to improve and a small
reproduction where relevant. Keep changes focused and include a test for a
behavioral fix. See [Run it locally](README.md#run-it-locally) for local setup.

## Project attribution

This repository publishes commits through the shared project identity:

```bash
git config --local user.name "Anyroute Contributor"
git config --local user.email contributor@anyroute.invalid
git config --local user.useConfigOnly true
bash scripts/install-hooks.sh
```

Commit with `TZ=UTC git commit`. The publication guard pins both author and
committer, checks co-author trailers, scans outgoing history, and rejects
secret-like values and local-only files. Keep private deny rules in
`.git/info/publish-denylist` and `.git/info/publish-denypaths`.

Maintainers integrate external work through a reviewed squash commit under
the project identity. Account names may still appear in issues, pull requests,
reviews and GitHub activity. Never bypass the hooks to publish a change.

## Checks

Run checks relevant to your change before submitting it:

```bash
bun run typecheck
bun test                                 # in-process database, no services
bun run services:up && bun run test:pg   # the same suite on local Postgres and Redis, as CI runs it
bun run test:e2e
bun run test:contracts --no-match-path 'test/fork/*'
cd web && pnpm test && pnpm build
```

The release workflow also exercises PostgreSQL, Redis and the container image.
Passing local tests is not a claim of production or real-funds readiness.

## License and security

Review [LICENSE](LICENSE) and [NOTICE](NOTICE) before contributing; separately
licensed files keep their own terms. Submit only material you are authorized
to contribute. Report vulnerabilities through [the private reporting process](SECURITY.md),
not a public issue.
