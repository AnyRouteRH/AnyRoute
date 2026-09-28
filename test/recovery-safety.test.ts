import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../scripts/restore-db.sh");

function restoreFixture(options: { decryptFails?: boolean; archiveFails?: boolean; objects?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anyroute-recovery-test-"));
  const bin = join(dir, "bin");
  const scratch = join(dir, "scratch");
  mkdirSync(bin); mkdirSync(scratch);
  const command = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o700 });
  // Model an authenticated streaming decryptor that emits plaintext before rejecting its final tag.
  command("age", 'printf fixture-archive; if [ "$DECRYPT_FAILS" = 1 ]; then exit 1; fi');
  command("pg_restore", `
if [ "$1" = --list ]; then
  [ "$ARCHIVE_FAILS" = 0 ]
  [ "$(cat "$2")" = fixture-archive ]
else
  printf '%s\\n' "$@" > "$FIXTURE_DIR/restore-args"
fi`);
  command("psql", 'touch "$FIXTURE_DIR/db-contacted"; printf "%s\\n" "$OBJECT_COUNT"');
  try {
    const result = Bun.spawnSync(["bash", script, join(dir, "fixture.age")], {
      env: {
        PATH: `${bin}:${process.env.PATH}`, TMPDIR: scratch,
        PGDATABASE: "isolated_fixture", RESTORE_ACK: "isolated-empty-database", AGE_IDENTITY_FILE: join(dir, "fixture-identity"),
        FIXTURE_DIR: dir, DECRYPT_FAILS: options.decryptFails ? "1" : "0",
        ARCHIVE_FAILS: options.archiveFails ? "1" : "0", OBJECT_COUNT: String(options.objects ?? 0),
      },
    });
    return {
      code: result.exitCode,
      contacted: existsSync(join(dir, "db-contacted")),
      restored: existsSync(join(dir, "restore-args")),
      args: existsSync(join(dir, "restore-args")) ? readFileSync(join(dir, "restore-args"), "utf8") : "",
      leftovers: readdirSync(scratch),
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("encrypted restore safety", () => {
  test("late authentication failure never contacts or changes the destination", () => {
    const r = restoreFixture({ decryptFails: true });
    expect(r.code).not.toBe(0);
    expect(r.contacted).toBe(false);
    expect(r.restored).toBe(false);
    expect(r.leftovers).toEqual([]);
  });
  test("invalid authenticated archives are rejected before contacting the destination", () => {
    const r = restoreFixture({ archiveFails: true });
    expect(r.code).not.toBe(0);
    expect(r.contacted).toBe(false);
    expect(r.restored).toBe(false);
    expect(r.leftovers).toEqual([]);
  });
  test("existing database objects prevent restore and scratch plaintext is cleaned", () => {
    const r = restoreFixture({ objects: 1 });
    expect(r.code).not.toBe(0);
    expect(r.contacted).toBe(true);
    expect(r.restored).toBe(false);
    expect(r.leftovers).toEqual([]);
  });
  test("successful restore uses the authenticated file in one transaction", () => {
    const r = restoreFixture();
    expect(r.code).toBe(0);
    expect(r.restored).toBe(true);
    expect(r.args).toContain("--single-transaction");
    expect(r.args).toContain("--exit-on-error");
    expect(r.args).toContain("snapshot.dump");
    expect(r.leftovers).toEqual([]);
  });
});
