import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { checkComposeGraph, checkDatabaseIdentities, loadCompose } from "../scripts/compose-graph-check.ts";

const root = resolve(import.meta.dir, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const DIGEST = /@sha256:[0-9a-f]{64}$/;

describe("production Compose graph", () => {
  const base = loadCompose([resolve(root, "docker-compose.yml")]);

  test("base graph runs migrate -> runtime-role-grants -> provider-init -> API and workers", () => {
    expect(checkComposeGraph(base)).toEqual([]);
    expect(checkComposeGraph(loadCompose([resolve(root, "docker-compose.yml"), resolve(root, "docker-compose.production-topology.yml")]))).toEqual([]);
    expect(base["runtime-role-grants"].depends_on).toEqual({ migrate: { condition: "service_completed_successfully" } });
    expect(base["provider-init"].depends_on).toMatchObject({ "runtime-role-grants": { condition: "service_completed_successfully" } });
  });

  test("the check rejects a graph without grants, a skipped stage, or disabled worker health", () => {
    const clone = () => structuredClone(base);
    const noGrants = clone();
    delete noGrants["runtime-role-grants"];
    expect(checkComposeGraph(noGrants)).toContain("missing service runtime-role-grants");
    const skip = clone();
    skip["provider-init"].depends_on = { migrate: { condition: "service_completed_successfully" }, redis: { condition: "service_healthy" } };
    expect(checkComposeGraph(skip).join("\n")).toContain("provider-init must depend on runtime-role-grants");
    const unhealthy = clone();
    unhealthy["settlement-worker"].healthcheck = { disable: true };
    expect(checkComposeGraph(unhealthy).join("\n")).toContain("settlement-worker disables its container healthcheck");
    const leak = clone();
    (leak.router.environment as Record<string, string>).MIGRATION_DATABASE_URL = "x";
    expect(checkComposeGraph(leak).join("\n")).toContain("router must not receive");
    const cycle = clone();
    cycle.migrate.depends_on = { router: { condition: "service_started" } };
    expect(checkComposeGraph(cycle).join("\n")).toContain("dependency cycle");
  });

  test("workers use the read-only heartbeat check; the backup job is opt-in and never restarts", () => {
    for (const name of ["registry-worker", "settlement-worker", "anchor-worker"]) {
      expect(base[name].healthcheck?.disable).toBeUndefined();
      expect(JSON.stringify(base[name].healthcheck?.test)).toContain("scripts/worker-healthcheck.sh");
    }
    expect(base.backup.profiles).toEqual(["backup"]);
    expect(base.backup.restart).toBe("no");
    expect(Object.keys(base.backup.environment as object)).not.toContain("MIGRATION_DATABASE_URL");
    expect(read("docker-compose.yml")).not.toMatch(/healthcheck:\s*\{\s*disable:\s*true/);
  });

  test("database identity preflight catches mismatched runtime credentials without echoing them", () => {
    const ok = { DATABASE_URL: "postgres://anyroute_runtime:fixture-runtime-password-000@db:5432/app", MIGRATION_DATABASE_URL: "postgres://owner:fixture@db:5432/app", RUNTIME_DB_PASSWORD: "fixture-runtime-password-000" };
    expect(checkDatabaseIdentities({})).toEqual({ skipped: true, errors: [] });
    expect(checkDatabaseIdentities(ok)).toEqual({ skipped: false, errors: [] });
    const cases = [
      { ...ok, RUNTIME_DB_PASSWORD: "fixture-other-password-000" },
      { ...ok, DATABASE_URL: "postgres://owner:fixture-runtime-password-000@db:5432/app" },
      { ...ok, MIGRATION_DATABASE_URL: "postgres://anyroute_runtime:x@db:5432/app" },
      { ...ok, MIGRATION_DATABASE_URL: "postgres://owner:x@db:5432/other" },
      { ...ok, MIGRATION_DATABASE_URL: undefined },
    ];
    for (const env of cases) {
      const { errors } = checkDatabaseIdentities(env);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join(" ")).not.toContain("fixture");
    }
  });
});

describe("pinned images", () => {
  const workflow = read(".github/workflows/release-checks.yml");
  const smoke = read("scripts/container-smoke.sh");

  test("container smoke uses the same PostgreSQL and Redis digests as CI and rejects mutable tags", () => {
    const ciImages = [...workflow.matchAll(/\b((?:postgres|redis):[\w.-]+@sha256:[0-9a-f]{64})/g)].map((m) => m[1]);
    const smokeImages = [...smoke.matchAll(/\b((?:postgres|redis):[\w.-]+@sha256:[0-9a-f]{64})/g)].map((m) => m[1]);
    expect(smokeImages.length).toBe(2);
    for (const image of smokeImages) expect(ciImages).toContain(image);
    const runs = smoke.split("\n").filter((l) => l.includes("docker run"));
    for (const line of runs) expect(line).not.toMatch(/\s(?:postgres|redis):[\w.-]+(?:\s|$)/);
    expect(runs.some((l) => l.includes('"$postgres_image"'))).toBe(true);
    expect(runs.some((l) => l.includes('"$redis_image"'))).toBe(true);
    expect(smoke).toContain("Refusing mutable fixture image reference");
  });

  test("the smoke script refuses a mutable override before touching Docker", () => {
    const r = Bun.spawnSync(["bash", resolve(root, "scripts/container-smoke.sh")], { env: { PATH: "/usr/bin:/bin", POSTGRES_IMAGE: "postgres:16" } });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("Refusing mutable fixture image reference: postgres:16");
  });

  test("every workflow and deploy image reference is digest-pinned", () => {
    for (const m of workflow.matchAll(/^\s*image:\s*(\S+)/gm)) expect(m[1]).toMatch(DIGEST);
    for (const m of workflow.matchAll(/docker run [^\n]*?\s((?:prom|postgres|redis|ghcr\.io)[^\s]*:[^\s]+)/g)) expect(m[1]).toMatch(DIGEST);
    for (const f of readdirSync(resolve(root, "deploy/railway")).filter((f) => f.endsWith("Dockerfile"))) {
      const text = read(`deploy/railway/${f}`);
      for (const m of text.matchAll(/^(?:FROM|ARG POSTGRES_CLIENT_IMAGE=)\s*(\S+)/gm)) if (!m[1].startsWith("${")) expect(m[1]).toMatch(DIGEST);
    }
    const backup = read("deploy/railway/backup.Dockerfile");
    expect(backup).toMatch(/AGE_SHA256_AMD64=[0-9a-f]{64}/);
    expect(backup).toContain("sha256sum -c");
    expect(backup).not.toContain("AGE-SECRET-KEY");
  });
});

describe("Railway topology as code", () => {
  const cfg = (name: string) => JSON.parse(read(`deploy/railway/${name}.railway.json`));

  test("every service has a config whose Dockerfile exists", () => {
    for (const name of ["migrate", "grants", "provider-init", "api", "worker", "backup"]) {
      const c = cfg(name);
      expect(c.build.builder).toBe("DOCKERFILE");
      expect(existsSync(resolve(root, c.build.dockerfilePath))).toBe(true);
    }
  });

  test("one-shots never restart; the API health checks /health; the worker and backup are modelled", () => {
    for (const name of ["migrate", "grants", "provider-init", "backup"]) expect(cfg(name).deploy).toMatchObject({ restartPolicyType: "NEVER", restartPolicyMaxRetries: 0 });
    expect(cfg("api").deploy).toMatchObject({ startCommand: "bun src/index.ts", healthcheckPath: "/health", restartPolicyType: "ON_FAILURE" });
    expect(cfg("worker").deploy).toMatchObject({ startCommand: "bun src/worker.ts", restartPolicyType: "ON_FAILURE" });
    expect(cfg("worker").deploy.healthcheckPath).toBeUndefined();
    expect(cfg("backup").deploy.cronSchedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
  });

  test("the README documents order, deprecation and variable names without values", () => {
    const readme = read("deploy/railway/README.md");
    for (const phrase of ["migrate", "grants", "provider-init", "2026-12-01", "BACKUP_S3_BUCKET", "BACKUP_AGE_RECIPIENTS", "RUNTIME_DB_PASSWORD", "ALERT_WEBHOOK_URL", "/health", "cronSchedule"]) expect(readme).toContain(phrase);
    expect(readme).not.toMatch(/AGE-SECRET-KEY|postgres(?:ql)?:\/\/[^\s`]*:(?!\$\{\{|<)[^\s`@]+@/);
  });
});

describe("Alertmanager delivery", () => {
  test("routes every alert to one webhook read from a mounted secret file", () => {
    const am = parse(read("monitoring/alertmanager.yml"));
    expect(am.route.receiver).toBe("on-call");
    const receiver = am.receivers.find((r: { name: string }) => r.name === "on-call");
    expect(receiver.webhook_configs[0]).toMatchObject({ url_file: "/run/secrets/alert_webhook_url", send_resolved: true });
    expect(receiver.webhook_configs[0].url).toBeUndefined();
    const compose = parse(read("compose.monitoring.yml"));
    expect(compose.services.alertmanager.secrets).toEqual(["alert_webhook_url"]);
    expect(compose.secrets.alert_webhook_url.file).toContain("ALERT_WEBHOOK_URL_FILE");
    expect(read("monitoring/prometheus.yml")).toContain("alertmanager:9093");
    expect(read(".github/workflows/release-checks.yml")).toMatch(/amtool[^\n]+prom\/alertmanager:v[\d.]+@sha256:[0-9a-f]{64} check-config alertmanager\.yml/);
  });
});
