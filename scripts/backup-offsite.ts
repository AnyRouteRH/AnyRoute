// Scheduled encrypted off-host PostgreSQL backup (Railway cron service or the Compose backup profile).
//   1. scripts/backup-db.sh writes a pg_dump custom-format archive encrypted to public age recipients.
//   2. The archive and a .sha256 sidecar are uploaded to S3-compatible storage under a new unique key.
//   3. The object size and a full re-download SHA-256 must match the local archive.
//   4. Only then is kv "backup:last" recorded (time, size, checksum, object key; no secrets), which
//      readiness reports as backup_fresh when BACKUP_REQUIRED=true.
// The private age identity never belongs on this host: the job refuses to run if one is present.
// Prints one JSON line. Credentials, connection strings and the webhook/bucket secrets are never printed.
import { S3Client } from "bun";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const BACKUP_KV_KEY = "backup:last"; // Must equal src/services/backup.ts.
const RECIPIENT = /^age1[0-9a-z]{50,}$/;

export type BackupEnv = {
  database: URL;
  recipients: string[];
  s3: { endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; secretAccessKey: string; virtualHostedStyle: boolean };
};
export type ObjectStore = {
  put(key: string, path: string): Promise<void>;
  putText(key: string, text: string): Promise<void>;
  size(key: string): Promise<number>;
  sha256(key: string): Promise<string>;
};
export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string[], env: Record<string, string>, stdin?: string) => Promise<ExecResult>;
export type BackupRecord = {
  completed_at: string; size_bytes: number; sha256: string; object_key: string;
  pg_dump_major: number; server_major: number; recipients: number; format: "pg_dump-custom+age";
};

export class BackupError extends Error {
  constructor(readonly stage: string, message: string, readonly detail?: string) { super(message); }
}

/** Last lines of a tool's stderr for the private job log, with every configured secret removed. */
export function redactDetail(stderr: string, secrets: string[]) {
  let out = stderr;
  for (const secret of secrets.filter((s) => s.length >= 4)) out = out.split(secret).join("[redacted]");
  return out.replace(/postgres(?:ql)?:\/\/\S+/g, "postgres://[redacted]").slice(-600).trim();
}

export function parseBackupEnv(env: Record<string, string | undefined>): BackupEnv {
  // A private identity anywhere in this environment could decrypt every archive it writes.
  if (Object.values(env).some((v) => v?.includes("AGE-SECRET-KEY-"))) throw new BackupError("config", "An age private identity is present in the backup environment; remove it. Only public recipients belong here.");
  const need = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new BackupError("config", `${name} is required.`);
    return value;
  };
  let database: URL;
  try { database = new URL(need("DATABASE_URL")); } catch (e) { throw e instanceof BackupError ? e : new BackupError("config", "DATABASE_URL must be a PostgreSQL URL."); }
  if (!/^postgres(?:ql)?:$/.test(database.protocol) || !database.hostname || database.pathname.length < 2) throw new BackupError("config", "DATABASE_URL must be a PostgreSQL URL with a host and database.");
  const recipients = (env.BACKUP_AGE_RECIPIENTS?.trim() || env.AGE_RECIPIENT?.trim() || "").split(/[\s,]+/).filter(Boolean);
  if (!recipients.length) throw new BackupError("config", "BACKUP_AGE_RECIPIENTS (one or more public age1... recipients) is required.");
  if (recipients.some((r) => !RECIPIENT.test(r))) throw new BackupError("config", "BACKUP_AGE_RECIPIENTS must contain only public age1... recipients.");
  const endpoint = need("BACKUP_S3_ENDPOINT");
  let endpointUrl: URL;
  try { endpointUrl = new URL(endpoint); } catch { throw new BackupError("config", "BACKUP_S3_ENDPOINT must be an https URL."); }
  if (endpointUrl.protocol !== "https:" || endpointUrl.username || endpointUrl.password) throw new BackupError("config", "BACKUP_S3_ENDPOINT must be an https URL without credentials.");
  const prefix = (env.BACKUP_S3_PREFIX?.trim() || "anyroute/postgres").replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(prefix) || prefix.split("/").includes("..")) throw new BackupError("config", "BACKUP_S3_PREFIX may contain only letters, digits, '.', '_', '-' and '/'.");
  return {
    database,
    recipients,
    s3: {
      endpoint: endpointUrl.toString().replace(/\/$/, ""),
      region: env.BACKUP_S3_REGION?.trim() || "auto",
      bucket: need("BACKUP_S3_BUCKET"),
      prefix,
      accessKeyId: need("BACKUP_S3_ACCESS_KEY_ID"),
      secretAccessKey: need("BACKUP_S3_SECRET_ACCESS_KEY"),
      virtualHostedStyle: env.BACKUP_S3_VIRTUAL_HOSTED === "true",
    },
  };
}

/** libpq variables for pg_dump/psql, so the password never appears in a process argument list. */
export function pgEnv(url: URL): Record<string, string> {
  const out: Record<string, string> = {
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGAPPNAME: "anyroute-backup",
    PGCONNECT_TIMEOUT: "15",
  };
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode && /^[a-z-]+$/.test(sslmode)) out.PGSSLMODE = sslmode;
  return out;
}

/** An age v1 header with at least one stanza per recipient and no passphrase stanza. */
export function checkAgeHeader(head: Uint8Array, recipients: number) {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head);
  if (!text.startsWith("age-encryption.org/v1\n")) return false;
  const end = text.indexOf("\n---");
  if (end < 0) return false;
  const stanzas = text.slice(0, end).split("\n").filter((line) => line.startsWith("-> "));
  return !stanzas.some((line) => line.startsWith("-> scrypt ")) && stanzas.length >= recipients;
}

export const majorOf = (version: string) => Number(/(\d+)(?:\.\d+)?/.exec(version)?.[1] ?? NaN);

async function sha256File(path: string) {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

export function s3Store(c: BackupEnv["s3"]): ObjectStore {
  const client = new S3Client({ endpoint: c.endpoint, region: c.region, bucket: c.bucket, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, virtualHostedStyle: c.virtualHostedStyle });
  return {
    async put(key, path) { await client.write(key, Bun.file(path), { type: "application/octet-stream" }); },
    async putText(key, text) { await client.write(key, text, { type: "text/plain" }); },
    async size(key) { return (await client.stat(key)).size; },
    async sha256(key) {
      const hasher = new Bun.CryptoHasher("sha256");
      for await (const chunk of client.file(key).stream()) hasher.update(chunk);
      return hasher.digest("hex");
    },
  };
}

export const spawnExec: Exec = async (cmd, env, stdin) => {
  const proc = Bun.spawn(cmd, { env, stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
};

const RECORD_SQL = `\\set ON_ERROR_STOP on
INSERT INTO kv (key, value, updated_at) VALUES (:'record_key', :'record'::jsonb, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
`;

export type BackupDeps = { exec?: Exec; store?: ObjectStore; now?: () => number; script?: string; baseEnv?: Record<string, string> };

export async function runBackup(env: Record<string, string | undefined>, deps: BackupDeps = {}): Promise<BackupRecord> {
  const cfg = parseBackupEnv(env);
  const exec = deps.exec ?? spawnExec;
  const store = deps.store ?? s3Store(cfg.s3);
  const now = deps.now ?? Date.now;
  const script = deps.script ?? resolve(import.meta.dir, "backup-db.sh");
  // Children get only what they need: never the object-store credentials.
  const base = deps.baseEnv ?? Object.fromEntries(["PATH", "HOME", "LANG", "TMPDIR"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])));
  const pg = { ...base, ...pgEnv(cfg.database) };
  const secrets = [pg.PGPASSWORD, cfg.s3.secretAccessKey, cfg.s3.accessKeyId, env.DATABASE_URL ?? ""];
  const run = async (stage: string, cmd: string[], extra: Record<string, string> = {}, stdin?: string) => {
    const result = await exec(cmd, { ...pg, ...extra }, stdin);
    if (result.code !== 0) throw new BackupError(stage, `${stage} failed (exit ${result.code}).`, redactDetail(result.stderr, secrets));
    return result.stdout;
  };

  const pgDumpMajor = majorOf(await run("client version", ["pg_dump", "--version"]));
  const serverMajor = Math.floor(Number((await run("server version", ["psql", "-X", "-A", "-t", "-c", "show server_version_num"])).trim()) / 10_000);
  if (!Number.isFinite(pgDumpMajor) || !Number.isFinite(serverMajor) || serverMajor < 10) throw new BackupError("server version", "Could not determine PostgreSQL versions.");
  if (pgDumpMajor < serverMajor) throw new BackupError("server version", `pg_dump ${pgDumpMajor} cannot back up PostgreSQL ${serverMajor}; rebuild the backup image with a PostgreSQL ${serverMajor} client (POSTGRES_CLIENT_IMAGE).`);

  const work = mkdtempSync(join(tmpdir(), "anyroute-backup-"));
  try {
    const started = new Date(now());
    const stamp = started.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const name = `anyroute-${stamp}-${randomBytes(4).toString("hex")}.dump.age`;
    const file = join(work, name);
    await run("dump", ["bash", script, file], { AGE_RECIPIENT: cfg.recipients.join(",") });

    const size = statSync(file).size;
    const sha256 = await sha256File(file);
    const sidecar = readFileSync(`${file}.sha256`, "utf8").trim().split(/\s+/)[0];
    if (!(size > 0) || sidecar !== sha256) throw new BackupError("checksum", "Local archive checksum does not match its sidecar.");
    if (!checkAgeHeader(new Uint8Array(await Bun.file(file).slice(0, 64 * 1024).arrayBuffer()), cfg.recipients.length))
      throw new BackupError("encryption", "Archive is not age-encrypted to the configured recipients.");

    const objectKey = `${cfg.s3.prefix}/${name}`;
    try {
      await store.put(objectKey, file);
      await store.putText(`${objectKey}.sha256`, `${sha256}  ${name}\n`);
    } catch (e) {
      throw new BackupError("upload", `Upload failed (${(e as { code?: string }).code ?? (e as Error).name ?? "error"}).`);
    }
    let remoteSize: number, remoteSha: string;
    try { remoteSize = await store.size(objectKey); remoteSha = await store.sha256(objectKey); }
    catch (e) { throw new BackupError("verify", `Could not read back the uploaded archive (${(e as { code?: string }).code ?? (e as Error).name ?? "error"}).`); }
    if (remoteSize !== size || remoteSha !== sha256) throw new BackupError("verify", "Uploaded archive does not match the local archive.");

    const record: BackupRecord = {
      completed_at: new Date(now()).toISOString(), size_bytes: size, sha256, object_key: objectKey,
      pg_dump_major: pgDumpMajor, server_major: serverMajor, recipients: cfg.recipients.length, format: "pg_dump-custom+age",
    };
    await run("record", ["psql", "-X", "-q", "-v", `record_key=${BACKUP_KV_KEY}`, "-v", `record=${JSON.stringify(record)}`, "-f", "-"], {}, RECORD_SQL);
    return record;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const record = await runBackup(process.env);
    console.log(JSON.stringify({ ok: true, ...record }));
  } catch (e) {
    const stage = e instanceof BackupError ? e.stage : "unexpected";
    const message = e instanceof BackupError ? e.message : "Unexpected failure; see the stage above.";
    const detail = e instanceof BackupError && e.detail ? { detail: e.detail } : {};
    console.error(JSON.stringify({ ok: false, stage, error: message, ...detail }));
    process.exit(1);
  }
}
