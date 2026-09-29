import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_KV_KEY as SCRIPT_KEY, checkAgeHeader, majorOf, parseBackupEnv, pgEnv, redactDetail, runBackup, s3Store, spawnExec,
  type Exec, type ObjectStore,
} from "../scripts/backup-offsite.ts";
import { kv } from "../src/db/schema.ts";
import { BACKUP_KV_KEY, backupRecordFresh } from "../src/services/backup.ts";
import { readiness } from "../src/services/readiness.ts";
import { startRouter, type Harness } from "./helpers.ts";

// Public example recipient from the age documentation; no private identity appears in these tests.
const RECIPIENT = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";
const ENV = {
  DATABASE_URL: "postgres://anyroute_runtime:fixture%2Fpass-word@db.fixture.invalid:6543/app?sslmode=require",
  BACKUP_AGE_RECIPIENTS: `${RECIPIENT}, ${RECIPIENT}`,
  BACKUP_S3_ENDPOINT: "https://s3.fixture.invalid",
  BACKUP_S3_BUCKET: "fixture-bucket",
  BACKUP_S3_ACCESS_KEY_ID: "fixture-access-key-id",
  BACKUP_S3_SECRET_ACCESS_KEY: "fixture-secret-access-key",
};

function memoryStore(tamper = false) {
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    async put(key, path) { objects.set(key, new Uint8Array(await Bun.file(path).arrayBuffer())); },
    async putText(key, text) { objects.set(key, new TextEncoder().encode(text)); },
    async size(key) { return objects.get(key)!.byteLength; },
    async sha256(key) { const b = objects.get(key)!.slice(); if (tamper) b[b.length - 1] ^= 1; return new Bun.CryptoHasher("sha256").update(b).digest("hex"); },
  };
  return { objects, store };
}

/** Stands in for pg_dump/psql/backup-db.sh; records every call and the environment it received. */
function fakeExec(opts: { pgDump?: string; server?: string } = {}) {
  const calls: { cmd: string[]; env: Record<string, string>; stdin?: string }[] = [];
  const exec: Exec = async (cmd, env, stdin) => {
    calls.push({ cmd, env, stdin });
    if (cmd[0] === "pg_dump") return { code: 0, stdout: `pg_dump (PostgreSQL) ${opts.pgDump ?? "16.15"}\n`, stderr: "" };
    if (cmd[0] === "psql" && cmd.includes("show server_version_num")) return { code: 0, stdout: `${opts.server ?? "160015"}\n`, stderr: "" };
    if (cmd[0] === "bash") {
      const file = cmd[2];
      const body = new TextEncoder().encode(`age-encryption.org/v1\n-> X25519 a\nb\n-> X25519 c\nd\n--- mac\n${"x".repeat(100)}`);
      writeFileSync(file, body);
      writeFileSync(`${file}.sha256`, `${new Bun.CryptoHasher("sha256").update(body).digest("hex")}  ${file}\n`);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd[0] === "psql") return { code: 0, stdout: "", stderr: "" };
    return { code: 127, stdout: "", stderr: "unknown" };
  };
  return { calls, exec };
}

describe("off-host backup configuration", () => {
  test("accepts public recipients and S3 settings with safe defaults", () => {
    const cfg = parseBackupEnv(ENV);
    expect(cfg.recipients).toEqual([RECIPIENT, RECIPIENT]);
    expect(cfg.s3).toMatchObject({ region: "auto", prefix: "anyroute/postgres", bucket: "fixture-bucket", virtualHostedStyle: false });
    expect(pgEnv(cfg.database)).toMatchObject({ PGHOST: "db.fixture.invalid", PGPORT: "6543", PGUSER: "anyroute_runtime", PGPASSWORD: "fixture/pass-word", PGDATABASE: "app", PGSSLMODE: "require" });
  });

  test("refuses a private identity, missing settings, insecure endpoints and path tricks", () => {
    const bad: Record<string, string>[] = [
      { SOME_VAR: "AGE-SECRET-KEY-1FIXTURE" },
      { BACKUP_AGE_RECIPIENTS: "" },
      { BACKUP_AGE_RECIPIENTS: "ssh-ed25519 AAAAfixture" },
      { BACKUP_S3_ENDPOINT: "http://s3.fixture.invalid" },
      { BACKUP_S3_ENDPOINT: "https://user:pass@s3.fixture.invalid" },
      { BACKUP_S3_BUCKET: "" },
      { BACKUP_S3_SECRET_ACCESS_KEY: "" },
      { BACKUP_S3_PREFIX: "../escape" },
      { DATABASE_URL: "mysql://x@y/z" },
    ];
    for (const change of bad) expect(() => parseBackupEnv({ ...ENV, ...change })).toThrow();
    try { parseBackupEnv({ ...ENV, SOME_VAR: "AGE-SECRET-KEY-1FIXTURE" }); } catch (e) { expect((e as Error).message).not.toContain("FIXTURE"); }
  });

  test("age header, version parsing and log redaction", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(checkAgeHeader(enc("age-encryption.org/v1\n-> X25519 a\nb\n--- m\n"), 1)).toBe(true);
    expect(checkAgeHeader(enc("age-encryption.org/v1\n-> X25519 a\nb\n--- m\n"), 2)).toBe(false);
    expect(checkAgeHeader(enc("age-encryption.org/v1\n-> scrypt a 10\nb\n--- m\n"), 1)).toBe(false);
    expect(checkAgeHeader(enc("PGDMP plaintext dump"), 1)).toBe(false);
    expect(majorOf("pg_dump (PostgreSQL) 16.15 (Debian 16.15-1.pgdg120+1)")).toBe(16);
    expect(majorOf("psql (PostgreSQL) 18.0")).toBe(18);
    const detail = redactDetail('connection to "postgres://u:hunter22@db/x" failed; password hunter22; key fixture-secret-access-key', ["hunter22", "fixture-secret-access-key"]);
    expect(detail).not.toMatch(/hunter22|fixture-secret-access-key/);
  });
});

describe("off-host backup run", () => {
  test("uploads, re-reads and verifies before recording metadata without secrets", async () => {
    const { calls, exec } = fakeExec();
    const { objects, store } = memoryStore();
    const record = await runBackup(ENV, { exec, store, now: () => Date.parse("2026-09-28T03:17:00.000Z"), baseEnv: { PATH: "/usr/bin" } });
    expect(record.object_key).toMatch(/^anyroute\/postgres\/anyroute-20260928T031700Z-[0-9a-f]{8}\.dump\.age$/);
    expect(record).toMatchObject({ pg_dump_major: 16, server_major: 16, recipients: 2, format: "pg_dump-custom+age" });
    expect(objects.has(record.object_key)).toBe(true);
    expect(new TextDecoder().decode(objects.get(`${record.object_key}.sha256`)!)).toStartWith(record.sha256);
    const recordCall = calls.at(-1)!;
    expect(recordCall.cmd).toContain(`record_key=${SCRIPT_KEY}`);
    expect(recordCall.stdin).toContain("INSERT INTO kv");
    const dumpCall = calls.find((c) => c.cmd[0] === "bash")!;
    expect(dumpCall.env.AGE_RECIPIENT).toBe(`${RECIPIENT},${RECIPIENT}`);
    for (const call of calls) {
      // Object-store credentials never reach child processes; the DB password only via PGPASSWORD.
      expect(JSON.stringify(call.env)).not.toMatch(/fixture-secret-access-key|fixture-access-key-id/);
      expect(call.cmd.join(" ")).not.toMatch(/fixture%2Fpass-word|fixture\/pass-word|secret-access/);
    }
    expect(JSON.stringify(record)).not.toMatch(/pass-word|secret|access-key|fixture\.invalid/);
    expect(backupRecordFresh(record, 26, Date.parse("2026-09-28T04:00:00.000Z"))).toBe(true);
    expect(SCRIPT_KEY).toBe(BACKUP_KV_KEY);
  });

  test("a corrupted upload is never recorded as a backup", async () => {
    const { calls, exec } = fakeExec();
    await expect(runBackup(ENV, { exec, store: memoryStore(true).store, baseEnv: {} })).rejects.toThrow("does not match");
    expect(calls.some((c) => c.stdin?.includes("INSERT INTO kv"))).toBe(false);
  });

  test("an older pg_dump than the server stops before dumping", async () => {
    const { calls, exec } = fakeExec({ pgDump: "16.15", server: "180001" });
    await expect(runBackup(ENV, { exec, store: memoryStore().store, baseEnv: {} })).rejects.toThrow("PostgreSQL 18");
    expect(calls.some((c) => c.cmd[0] === "bash")).toBe(false);
  });

  test("the Bun S3 store uploads, stats and re-downloads through an S3-compatible API", async () => {
    const objects = new Map<string, Uint8Array>();
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (req.method === "PUT") { objects.set(path, new Uint8Array(await req.arrayBuffer())); return new Response(null, { status: 200, headers: { etag: '"fixture"' } }); }
        const body = objects.get(path);
        if (!body) return new Response(null, { status: 404 });
        const headers = { "content-length": String(body.byteLength), etag: '"fixture"', "last-modified": new Date().toUTCString(), "content-type": "application/octet-stream" };
        return new Response(req.method === "HEAD" ? null : body, { headers });
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "anyroute-s3-test-"));
    try {
      const store = s3Store({ endpoint: `http://127.0.0.1:${server.port}`, region: "auto", bucket: "fixture-bucket", prefix: "p", accessKeyId: "fixture", secretAccessKey: "fixture-secret", virtualHostedStyle: false });
      const file = join(dir, "archive.age");
      const bytes = crypto.getRandomValues(new Uint8Array(100_000));
      writeFileSync(file, bytes);
      await store.put("p/archive.age", file);
      await store.putText("p/archive.age.sha256", "abc  archive.age\n");
      expect(await store.size("p/archive.age")).toBe(bytes.byteLength);
      expect(await store.sha256("p/archive.age")).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
      expect([...objects.keys()].sort()).toEqual(["/fixture-bucket/p/archive.age", "/fixture-bucket/p/archive.age.sha256"]);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("backup freshness readiness", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter(); });
  afterAll(async () => { await h.close(); });
  const record = (completedAt: Date) => ({ completed_at: completedAt.toISOString(), size_bytes: 1234, sha256: "a".repeat(64), object_key: "anyroute/postgres/x.dump.age" });

  test("is absent unless BACKUP_REQUIRED, then requires a recent verified record", async () => {
    h.ctx.cfg.backup = { required: false, maxAgeHours: 26 };
    expect((await readiness(h.ctx)).checks.backup_fresh).toBeUndefined();
    h.ctx.cfg.backup = { required: true, maxAgeHours: 26 };
    expect((await readiness(h.ctx)).checks.backup_fresh).toBe(false);
    const value = record(new Date(Date.now() - 3_600_000));
    await h.ctx.db.insert(kv).values({ key: BACKUP_KV_KEY, value }).onConflictDoUpdate({ target: kv.key, set: { value } });
    expect((await readiness(h.ctx)).checks.backup_fresh).toBe(true);
    const stale = record(new Date(Date.now() - 27 * 3_600_000));
    await h.ctx.db.update(kv).set({ value: stale }).where(eq(kv.key, BACKUP_KV_KEY));
    expect((await readiness(h.ctx)).checks.backup_fresh).toBe(false);
    const metrics = await (await h.request("/ready/metrics")).text();
    expect(metrics).toContain('anyroute_readiness_check{check="backup_fresh"} 0');
    h.ctx.cfg.backup = { required: false, maxAgeHours: 26 };
  });

  test("rejects malformed, empty and future records", () => {
    const now = Date.parse("2026-09-28T12:00:00Z");
    expect(backupRecordFresh(null, 26, now)).toBe(false);
    expect(backupRecordFresh({ ...record(new Date(now)), sha256: "nothex" }, 26, now)).toBe(false);
    expect(backupRecordFresh({ ...record(new Date(now)), size_bytes: 0 }, 26, now)).toBe(false);
    expect(backupRecordFresh(record(new Date(now + 3_600_000)), 26, now)).toBe(false);
    expect(backupRecordFresh(record(new Date(now - 60_000)), 26, now)).toBe(true);
  });
});

// Real pg_dump + age + psql against the CI PostgreSQL service (skipped where the tools are absent).
const tools = ["pg_dump", "psql", "age", "age-keygen", "bash"].every((t) => Bun.which(t));
describe.skipIf(!process.env.TEST_PG_URL || !tools)("off-host backup against PostgreSQL", () => {
  test("dumps as an age archive that the recovery identity can decrypt, then records it", async () => {
    const postgres = (await import("postgres")).default;
    const { openDatabase } = await import("../src/db/client.ts");
    const name = "ar_backup_" + Math.random().toString(36).slice(2, 10);
    const admin = postgres(process.env.TEST_PG_URL!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.TEST_PG_URL!);
    url.pathname = "/" + name;
    const dir = mkdtempSync(join(tmpdir(), "anyroute-backup-it-"));
    try {
      const handle = await openDatabase(url.toString());
      await handle.close();
      const keygen = Bun.spawnSync(["age-keygen", "-o", join(dir, "identity")]);
      expect(keygen.exitCode).toBe(0);
      const recipient = Bun.spawnSync(["age-keygen", "-y", join(dir, "identity")]).stdout.toString().trim();
      const { objects, store } = memoryStore();
      const record = await runBackup({ ...ENV, DATABASE_URL: url.toString(), BACKUP_AGE_RECIPIENTS: recipient }, { store, exec: spawnExec });
      writeFileSync(join(dir, "fetched.age"), objects.get(record.object_key)!);
      const decrypted = Bun.spawnSync(["age", "-d", "-i", join(dir, "identity"), "-o", join(dir, "plain.dump"), join(dir, "fetched.age")]);
      expect(decrypted.exitCode).toBe(0);
      const list = Bun.spawnSync(["pg_restore", "--list", join(dir, "plain.dump")]);
      expect(list.exitCode).toBe(0);
      expect(list.stdout.toString()).toContain("TABLE DATA public kv");
      const db = postgres(url.toString(), { max: 1, onnotice: () => {} });
      const [row] = await db`select value from kv where key = ${BACKUP_KV_KEY}`;
      await db.end();
      expect(row.value).toMatchObject({ sha256: record.sha256, size_bytes: record.size_bytes, object_key: record.object_key });
      expect(backupRecordFresh(row.value, 26)).toBe(true);
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
