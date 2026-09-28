import { mkdirSync } from "node:fs";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { dirname, resolve } from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.ts";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbHandle = { db: Db; kind: "pglite" | "postgres"; close: () => Promise<void> };

const MIGRATIONS = resolve(import.meta.dir, "../../drizzle");

// DATABASE_URL:
//   pglite://memory            in-process Postgres (WASM), ephemeral — tests
//   pglite://<dir>             in-process Postgres persisted to a directory — zero-setup dev
//   postgres://user@host/db    real Postgres (+ Timescale when installed) — production
export async function openDatabase(url: string, opts: { migrate?: boolean } = {}): Promise<DbHandle> {
  let handle: DbHandle;
  if (url.startsWith("pglite://")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const target = url.slice("pglite://".length);
    let client;
    if (!target || target === "memory") client = new PGlite();
    else {
      const dir = resolve(target);
      mkdirSync(dirname(dir), { recursive: true });
      client = new PGlite(dir);
    }
    await client.waitReady;
    const db = drizzle(client, { schema }) as unknown as Db;
    handle = { db, kind: "pglite", close: () => client.close() };
    if (opts.migrate !== false) {
      const { migrate } = await import("drizzle-orm/pglite/migrator");
      await migrate(db as never, { migrationsFolder: MIGRATIONS });
    }
  } else {
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const client = postgres(url, { max: 20, onnotice: () => {} });
    const db = drizzle(client, { schema }) as unknown as Db;
    handle = { db, kind: "postgres", close: () => client.end({ timeout: 5 }) };
    if (opts.migrate !== false) {
      const { migrate } = await import("drizzle-orm/postgres-js/migrator");
      await migrate(db as never, { migrationsFolder: MIGRATIONS });
    }
  }
  if (opts.migrate === false) {
    try {
      const expected = readMigrationFiles({ migrationsFolder: MIGRATIONS }).at(-1)?.hash;
      const result = await handle.db.execute(sql`select hash from drizzle.__drizzle_migrations order by created_at desc limit 1`);
      const rows = ((result as { rows?: unknown[] }).rows ?? result) as { hash: string }[];
      if (!expected || rows[0]?.hash !== expected) throw new Error("Database schema does not match this release; run the migration job.");
    } catch (error) { await handle.close(); throw error; }
  }
  return handle;
}

export { schema };
