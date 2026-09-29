// Static check of the production Compose graph (no Docker daemon needed):
//   postgres -> migrate -> runtime-role-grants -> provider-init -> router and every worker,
// one-shot jobs never restart, only migrate/grants see the migration-owner URL, and workers have
// a read-only heartbeat healthcheck. With --env it also checks the database identities in the
// environment without printing them.
// Usage: bun scripts/compose-graph-check.ts [--env] [compose files...]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

type DependsOn = Record<string, { condition?: string }>;
export type ComposeService = {
  image?: string;
  command?: string | string[];
  environment?: Record<string, unknown> | string[];
  depends_on?: DependsOn | string[];
  healthcheck?: { disable?: boolean; test?: unknown };
  restart?: string;
  profiles?: string[];
  volumes?: unknown[];
};

function normalizeEnv(env: ComposeService["environment"]): Record<string, unknown> {
  if (!env) return {};
  if (Array.isArray(env)) return Object.fromEntries(env.map((line) => { const [k, ...v] = String(line).split("="); return [k, v.join("=")]; }));
  return env;
}
function normalizeDeps(deps: ComposeService["depends_on"]): DependsOn {
  if (!deps) return {};
  if (Array.isArray(deps)) return Object.fromEntries(deps.map((name) => [name, { condition: "service_started" }]));
  return deps;
}

/** Compose-style merge of the fields this check reads; later files override earlier ones. */
export function loadCompose(files: string[]): Record<string, ComposeService> {
  const services: Record<string, ComposeService> = {};
  for (const file of files) {
    const doc = parse(readFileSync(file, "utf8"), { merge: true }) as { services?: Record<string, ComposeService> };
    for (const [name, overlay] of Object.entries(doc.services ?? {})) {
      const base = services[name] ?? {};
      services[name] = {
        ...base,
        ...overlay,
        environment: { ...normalizeEnv(base.environment), ...normalizeEnv(overlay.environment) },
        depends_on: { ...normalizeDeps(base.depends_on), ...normalizeDeps(overlay.depends_on) },
        volumes: [...(base.volumes ?? []), ...(overlay.volumes ?? [])],
      };
    }
  }
  return services;
}

const text = (value: unknown) => (Array.isArray(value) ? value.join(" ") : String(value ?? ""));

export function checkComposeGraph(services: Record<string, ComposeService>): string[] {
  const errors: string[] = [];
  const deps = (name: string) => normalizeDeps(services[name]?.depends_on);
  const requireDep = (from: string, to: string, condition: string) => {
    if (deps(from)[to]?.condition !== condition) errors.push(`${from} must depend on ${to} with ${condition}`);
  };
  for (const name of ["postgres", "redis", "migrate", "runtime-role-grants", "provider-init", "router"])
    if (!services[name]) errors.push(`missing service ${name}`);
  if (errors.length) return errors;

  // Cycles would deadlock `up`; closure() below also relies on an acyclic graph.
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string, path: string[]) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") { errors.push(`dependency cycle: ${[...path, name].join(" -> ")}`); return; }
    state.set(name, "visiting");
    for (const dep of Object.keys(deps(name))) {
      if (!services[dep]) errors.push(`${name} depends on unknown service ${dep}`);
      else visit(dep, [...path, name]);
    }
    state.set(name, "done");
  };
  for (const name of Object.keys(services)) visit(name, []);
  if (errors.length) return errors;
  const closure = (name: string, seen = new Set<string>()): Set<string> => {
    for (const dep of Object.keys(deps(name))) if (!seen.has(dep)) { seen.add(dep); closure(dep, seen); }
    return seen;
  };

  requireDep("migrate", "postgres", "service_healthy");
  requireDep("runtime-role-grants", "migrate", "service_completed_successfully");
  requireDep("provider-init", "runtime-role-grants", "service_completed_successfully");
  const grants = services["runtime-role-grants"];
  if (!text(grants.command).includes("production-db-runtime-role.sql") || !text(grants.volumes).includes("scripts/production-db-runtime-role.sql"))
    errors.push("runtime-role-grants must run scripts/production-db-runtime-role.sql");
  const grantsEnv = normalizeEnv(grants.environment);
  if (!("MIGRATION_DATABASE_URL" in grantsEnv) || !("RUNTIME_DB_PASSWORD" in grantsEnv)) errors.push("runtime-role-grants needs MIGRATION_DATABASE_URL and RUNTIME_DB_PASSWORD");
  for (const oneShot of ["migrate", "runtime-role-grants", "provider-init"])
    if (services[oneShot].restart !== "no") errors.push(`${oneShot} is a one-shot job and must use restart: "no"`);

  const appImage = (s: ComposeService) => text(s.image).includes("ANYROUTE_IMAGE");
  const longRunning = Object.entries(services).filter(([, s]) => appImage(s) && s.restart && s.restart !== "no" && !s.profiles?.length);
  const workers = longRunning.filter(([, s]) => text(s.command).includes("src/worker.ts"));
  if (!workers.length) errors.push("no worker service runs src/worker.ts");
  for (const [name, s] of longRunning) {
    requireDep(name, "provider-init", "service_completed_successfully");
    const upstream = closure(name);
    for (const stage of ["migrate", "runtime-role-grants", "provider-init"])
      if (!upstream.has(stage)) errors.push(`${name} must start after ${stage}`);
    const env = normalizeEnv(s.environment);
    if ("MIGRATION_DATABASE_URL" in env || text(env.DATABASE_URL).includes("MIGRATION_DATABASE_URL")) errors.push(`${name} must not receive the migration-owner database URL`);
    if (s.healthcheck?.disable) errors.push(`${name} disables its container healthcheck`);
  }
  for (const [name, s] of workers)
    if (!text(s.healthcheck?.test).includes("worker-healthcheck")) errors.push(`${name} needs the read-only worker heartbeat healthcheck`);
  for (const [name, s] of Object.entries(services)) {
    if (name === "migrate" || name === "runtime-role-grants") continue;
    const env = normalizeEnv(s.environment);
    if ("MIGRATION_DATABASE_URL" in env) errors.push(`${name} must not receive MIGRATION_DATABASE_URL`);
  }
  const backup = services.backup;
  if (backup) {
    if (!backup.profiles?.includes("backup")) errors.push("backup must be opt-in through the backup profile");
    if (backup.restart !== "no") errors.push('backup is a scheduled one-shot and must use restart: "no"');
    const env = normalizeEnv(backup.environment);
    if (Object.keys(env).some((k) => /AGE_(IDENTITY|SECRET)/.test(k))) errors.push("backup must never receive an age private identity");
  }
  return errors;
}

/** Cross-checks the runtime and migration database identities. Messages never include values. */
export function checkDatabaseIdentities(env: Record<string, string | undefined>): { skipped: boolean; errors: string[] } {
  const { DATABASE_URL: runtimeUrl, MIGRATION_DATABASE_URL: migrationUrl, RUNTIME_DB_PASSWORD: password } = env;
  if (!runtimeUrl && !migrationUrl && !password) return { skipped: true, errors: [] };
  const errors: string[] = [];
  if (!runtimeUrl || !migrationUrl || !password) return { skipped: false, errors: ["DATABASE_URL, MIGRATION_DATABASE_URL and RUNTIME_DB_PASSWORD must be set together"] };
  let runtime: URL, migration: URL;
  try { runtime = new URL(runtimeUrl); migration = new URL(migrationUrl); } catch { return { skipped: false, errors: ["database URLs must be valid postgres URLs"] }; }
  if (decodeURIComponent(runtime.username) !== "anyroute_runtime") errors.push("DATABASE_URL must connect as anyroute_runtime");
  if (decodeURIComponent(runtime.password) !== password) errors.push("DATABASE_URL password must equal RUNTIME_DB_PASSWORD");
  if (decodeURIComponent(migration.username) === "anyroute_runtime") errors.push("MIGRATION_DATABASE_URL must use the schema owner, not anyroute_runtime");
  if (runtime.host !== migration.host || runtime.pathname !== migration.pathname) errors.push("DATABASE_URL and MIGRATION_DATABASE_URL must target the same database");
  if (password.length < 24) errors.push("RUNTIME_DB_PASSWORD must be at least 24 characters");
  return { skipped: false, errors };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const withEnv = args.includes("--env");
  const files = args.filter((a) => a !== "--env");
  const root = resolve(import.meta.dir, "..");
  const paths = (files.length ? files : ["docker-compose.yml"]).map((f) => resolve(root, f));
  const errors = checkComposeGraph(loadCompose(paths));
  let identity = "";
  if (withEnv) {
    const result = checkDatabaseIdentities(process.env);
    errors.push(...result.errors);
    identity = result.skipped ? " Database identity variables are not exported here; Compose still requires them." : " Runtime and migration database identities are consistent.";
  }
  if (errors.length) {
    for (const e of errors) console.error(`Preflight failed: ${e}.`);
    process.exit(1);
  }
  console.log(`PASS: Compose graph runs migrate -> runtime-role-grants -> provider-init before the API and workers; workers have heartbeat healthchecks.${identity}`);
}
