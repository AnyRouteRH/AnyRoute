// Read-only assertions for the disposable production topology smoke.
import { eq, inArray, sql } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/client.ts";
import { generations, kv, ledger } from "../src/db/schema.ts";
import { CRITICAL_JOBS, jobReady } from "../src/services/readiness.ts";

const generationId = process.argv[2];
if (process.env.TOPOLOGY_SMOKE_ACK !== "disposable-docker-host") throw new Error("This fixture helper is restricted to the disposable topology smoke.");
if (!generationId) throw new Error("Supply a generation id returned by the routed request.");
const cfg = loadConfig();
if (!cfg.production) throw new Error("The topology fixture must keep production configuration enabled.");
const handle = await openDatabase(cfg.databaseUrl, { migrate: false });
try {
  const [generation] = await handle.db.select({ id: generations.id, cost: generations.cost }).from(generations).where(eq(generations.id, generationId));
  const usage = await handle.db.select({ id: ledger.id, amount: ledger.amount }).from(ledger).where(eq(ledger.generationId, generationId));
  const rows = await handle.db.select().from(kv).where(inArray(kv.key, CRITICAL_JOBS.map((name) => `job-health:${name}`)));
  const roleResult = await handle.db.execute(sql`
    SELECT current_user AS role,
      r.rolsuper AS superuser, r.rolcreatedb AS createdb, r.rolcreaterole AS createrole,
      r.rolreplication AS replication, r.rolbypassrls AS bypassrls,
      has_schema_privilege(current_user, 'public', 'CREATE') AS create_public,
      has_schema_privilege(current_user, 'drizzle', 'CREATE') AS create_drizzle,
      has_table_privilege(current_user, 'public.ledger', 'TRUNCATE') AS truncate_ledger,
      has_table_privilege(current_user, 'drizzle.__drizzle_migrations', 'INSERT') AS migration_insert,
      has_table_privilege(current_user, 'drizzle.__drizzle_migrations', 'UPDATE') AS migration_update,
      has_table_privilege(current_user, 'drizzle.__drizzle_migrations', 'DELETE') AS migration_delete,
      has_table_privilege(current_user, 'drizzle.__drizzle_migrations', 'TRUNCATE') AS migration_truncate,
      COALESCE((SELECT json_agg(json_build_object('role', parent.rolname, 'inherit', member.inherit_option))
        FROM pg_auth_members member JOIN pg_roles parent ON parent.oid = member.roleid
        JOIN pg_roles child ON child.oid = member.member
        WHERE child.rolname = current_user), '[]'::json) AS memberships
    FROM pg_roles r WHERE r.rolname = current_user`);
  const dbRows = ((roleResult as { rows?: Record<string, unknown>[] }).rows ?? roleResult) as Record<string, unknown>[];
  const dbRole = dbRows[0];
  if (!dbRole) throw new Error("Could not inspect runtime database role privileges.");
  const unsafeRoleKeys = ["superuser", "createdb", "createrole", "replication", "bypassrls", "create_public", "create_drizzle", "truncate_ledger", "migration_insert", "migration_update", "migration_delete", "migration_truncate"];
  const unsafeRolePrivileges = unsafeRoleKeys.filter((key) => dbRole[key] === true);
  const workers = Object.fromEntries(CRITICAL_JOBS.map((name) => {
    const state = rows.find((row) => row.key === `job-health:${name}`)?.value;
    return [name, jobReady(state as Parameters<typeof jobReady>[0])];
  }));
  const result = {
    generation: !!generation,
    usage_ledger_rows: usage.length,
    usage_ledger_matches_generation: !!generation && usage.some((row) => row.amount < 0n && -row.amount === generation.cost),
    critical_worker_heartbeats: workers,
    runtime_database_role: dbRole,
    unsafe_runtime_database_privileges: unsafeRolePrivileges,
  };
  process.stdout.write(JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value));
  if (!result.generation || !result.usage_ledger_rows || !result.usage_ledger_matches_generation || Object.values(workers).some((ready) => !ready) || unsafeRolePrivileges.length) process.exitCode = 1;
} finally {
  await handle.close();
}
