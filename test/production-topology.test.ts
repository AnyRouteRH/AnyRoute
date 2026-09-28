import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const root = resolve(import.meta.dir, "..");
const compose = parse(readFileSync(resolve(root, "docker-compose.yml"), "utf8"), { merge: true }) as any;
const fixture = parse(readFileSync(resolve(root, "docker-compose.production-topology.yml"), "utf8"), { merge: true }) as any;

describe("production Compose topology", () => {
  test("migration, provider init, API, and core workers are distinct one-purpose services", () => {
    expect(Object.keys(compose.services)).toEqual(expect.arrayContaining([
      "migrate", "provider-init", "router", "registry-worker", "settlement-worker", "anchor-worker",
    ]));
    expect(compose.services.migrate.environment.DATABASE_URL).toContain("MIGRATION_DATABASE_URL");
    expect(compose.services.router.environment.RUNTIME_ROLE).toBe("api");
    expect(compose.services.router.environment.WORKERS).toBe("false");
    expect(compose.services.router.environment.ROUTER_PRIVATE_KEY).toContain("ROUTER_PRIVATE_KEY");
    expect(compose.services.router.environment.SETTLEMENT_PRIVATE_KEY).toBeUndefined();
    expect(compose.services.router.environment.ANCHORER_PRIVATE_KEY).toBeUndefined();
    expect(compose.services["settlement-worker"].environment.WORKER_JOBS).toBe("settlement");
    expect(compose.services["settlement-worker"].environment.SETTLEMENT_PRIVATE_KEY).toContain("SETTLEMENT_PRIVATE_KEY");
    expect(compose.services["settlement-worker"].environment.ANCHORER_PRIVATE_KEY).toBeUndefined();
    expect(compose.services["anchor-worker"].environment.WORKER_JOBS).toBe("receipts-anchor,receipt-key-rotation");
    expect(compose.services["anchor-worker"].environment.ANCHORER_PRIVATE_KEY).toContain("ANCHORER_PRIVATE_KEY");
    expect(compose.services["anchor-worker"].environment.SETTLEMENT_PRIVATE_KEY).toBeUndefined();
  });

  test("runtime database identity is separate from migration ownership", () => {
    const migrationRole = readFileSync(resolve(root, "scripts/production-db-runtime-role.sql"), "utf8");
    expect(compose.services.migrate.environment.DATABASE_URL).toContain("MIGRATION_DATABASE_URL");
    expect(compose.services.router.environment.DATABASE_URL).toContain("DATABASE_URL");
    expect(migrationRole).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anyroute_runtime");
    expect(migrationRole).toContain("GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO anyroute_runtime");
    expect(migrationRole).toContain("NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    expect(migrationRole).toContain("REVOKE CREATE ON SCHEMA public, drizzle FROM PUBLIC, anyroute_runtime");
    expect(migrationRole).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE[^;]+ON ALL TABLES IN SCHEMA drizzle/);
    expect(migrationRole).not.toMatch(/GRANT\s+ALL\s+ON/i);
    expect(migrationRole).not.toMatch(/GRANT\s+CREATE\s+ON\s+SCHEMA/i);
    expect(migrationRole).not.toMatch(/ALTER\s+ROLE\s+anyroute_runtime\s+(SUPERUSER|CREATEROLE)/i);
  });

  test("mock egress stays inside an internal test network while retaining production TLS checks", () => {
    expect(fixture.networks.egress.internal).toBe(true);
    expect(fixture.networks.egress.ipam.config[0].subnet).toBe("45.67.88.0/24");
    expect(fixture.services["mock-provider"].networks.egress.ipv4_address).toBe("${TOPOLOGY_PROVIDER_IP:-45.67.88.10}");
    expect(fixture.services.router.environment.NODE_EXTRA_CA_CERTS).toBe("/run/topology/tls.crt");
    expect(fixture.services.anvil.command).toEqual(expect.arrayContaining(["--chain-id", "4663"]));
    expect(fixture.services.anvil.ports[0]).toContain("18545");
    expect(compose.services.router.environment.USDG_ADDRESS).toContain("USDG_ADDRESS");
    expect(fixture.services.router.environment.ANYROUTE_ENV).toBeUndefined();
    const verifier = readFileSync(resolve(root, "scripts/production-topology-verify.ts"), "utf8");
    expect(verifier).toContain("unsafe_runtime_database_privileges");
    expect(verifier).toContain("has_table_privilege(current_user, 'public.ledger', 'TRUNCATE')");
    expect(verifier).toContain("has_table_privilege(current_user, 'drizzle.__drizzle_migrations', 'UPDATE')");
  });
});
