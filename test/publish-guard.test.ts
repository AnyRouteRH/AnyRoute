import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const guard = resolve(import.meta.dir, "../.githooks/publish-guard.sh");
test("publication guard pins both identities and rejects co-author attribution and merged history", () => {
  const dir = mkdtempSync(join(tmpdir(), "anyroute-identity-"));
  const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, TZ: "UTC", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Anyroute Contributor", GIT_AUTHOR_EMAIL: "contributor@anyroute.invalid", GIT_COMMITTER_NAME: "Anyroute Contributor", GIT_COMMITTER_EMAIL: "contributor@anyroute.invalid" };
  const run = (cmd: string[], overrides = {}) => Bun.spawnSync(cmd, { cwd: dir, env: { ...env, ...overrides }, stdout: "pipe", stderr: "pipe" }).exitCode;
  try {
    expect(run(["git", "init", "-q"])).toBe(0);
    mkdirSync(join(dir, ".githooks")); writeFileSync(join(dir, ".githooks/public-hex-allowlist.txt"), "");
    writeFileSync(join(dir, "safe.txt"), "safe fixture\n");
    expect(run(["git", "add", "."])).toBe(0);
    expect(run(["bash", guard, "staged"])).toBe(0);
    for (const override of [{ GIT_AUTHOR_NAME: "Wrong Name" }, { GIT_COMMITTER_NAME: "Wrong Name" }, { GIT_AUTHOR_EMAIL: "account@users.noreply.github.com" }, { GIT_COMMITTER_EMAIL: "account@users.noreply.github.com" }, { GIT_AUTHOR_DATE: "2026-01-01T00:00:00-0500" }])
      expect(run(["bash", guard, "staged"], override)).not.toBe(0);
    writeFileSync(join(dir, "message"), "Update\n\nCo-authored-by: Wrong Name <account@users.noreply.github.com>\n");
    expect(run(["bash", guard, "message", "message"])).not.toBe(0);
    expect(run(["git", "commit", "-qm", "Safe fixture"])).toBe(0);
    expect(run(["bash", guard, "range", "HEAD"])).toBe(0);
    expect(run(["git", "checkout", "-qb", "wrong"])).toBe(0);
    expect(run(["git", "commit", "--allow-empty", "-qm", "Wrong identity"], { GIT_AUTHOR_NAME: "Wrong Name" })).toBe(0);
    expect(run(["git", "checkout", "-"])).toBe(0);
    expect(run(["git", "merge", "--no-ff", "wrong", "-m", "Merge fixture"])).toBe(0);
    expect(run(["bash", guard, "range", "HEAD"], { ANYROUTE_ALLOWED_EMAIL_RE: ".*" })).not.toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const kind of ["private-path", "private-content"]) {
  test(`publication guard rejects ${kind} introduced only by a merge resolution`, () => {
    const dir = mkdtempSync(join(tmpdir(), "anyroute-merge-guard-"));
    const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, TZ: "UTC", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Anyroute Contributor", GIT_AUTHOR_EMAIL: "contributor@anyroute.invalid", GIT_COMMITTER_NAME: "Anyroute Contributor", GIT_COMMITTER_EMAIL: "contributor@anyroute.invalid" };
    const run = (cmd: string[]) => Bun.spawnSync(cmd, { cwd: dir, env, stdout: "pipe", stderr: "pipe" }).exitCode;
    try {
      expect(run(["git", "init", "-q", "-b", "main"])).toBe(0);
      mkdirSync(join(dir, ".githooks")); writeFileSync(join(dir, ".githooks/public-hex-allowlist.txt"), "");
      writeFileSync(join(dir, ".git/info/publish-denylist"), "fixture-private-marker\n");
      writeFileSync(join(dir, "base.txt"), "safe\n");
      expect(run(["git", "add", "."])).toBe(0);
      expect(run(["git", "commit", "-qm", "Base"])).toBe(0);
      expect(run(["git", "switch", "-qc", "feature"])).toBe(0);
      writeFileSync(join(dir, "feature.txt"), "safe feature\n");
      expect(run(["git", "add", "."])).toBe(0);
      expect(run(["git", "commit", "-qm", "Feature"])).toBe(0);
      expect(run(["git", "switch", "-q", "main"])).toBe(0);
      writeFileSync(join(dir, "main.txt"), "safe main\n");
      expect(run(["git", "add", "."])).toBe(0);
      expect(run(["git", "commit", "-qm", "Main"])).toBe(0);
      expect(run(["git", "merge", "--no-commit", "--no-ff", "feature"])).toBe(0);
      writeFileSync(join(dir, kind === "private-path" ? ".env" : "base.txt"), kind === "private-path" ? "fixture only\n" : "fixture-private-marker\n");
      expect(run(["git", "add", "."])).toBe(0);
      expect(run(["git", "commit", "-qm", "Resolve merge"])).toBe(0);
      expect(run(["bash", guard, "range", "HEAD^..HEAD"])).not.toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
