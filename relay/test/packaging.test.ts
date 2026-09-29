import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RELAY_VERSION } from "../src/version.ts";

const root = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

describe("shipped files", () => {
  test("the package version matches the version the relay reports, and it has no runtime dependencies", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.version).toBe(RELAY_VERSION);
    expect(pkg.dependencies).toEqual({});
    expect(pkg.license).toBe("Apache-2.0");
  });

  test("the Dockerfile pins every base image by digest, installs from the lockfile and never as root", () => {
    const docker = read("Dockerfile");
    const bases = [...docker.matchAll(/^(?:ARG BUN_IMAGE=|FROM )(\S+)/gm)].map((m) => m[1]).filter((v) => !v.startsWith("${") && !/^[A-Za-z]+$/.test(v));
    expect(bases.length).toBeGreaterThan(0);
    for (const b of bases) expect(b).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(docker).toContain("--frozen-lockfile");
    expect(docker).toContain("--ignore-scripts");
    expect(docker).toMatch(/SOURCE_DATE_EPOCH/);
    expect(docker).toMatch(/^USER bun$/m);
    expect(docker).not.toMatch(/apt-get|curl |wget /);
    expect(docker).toMatch(/HEALTHCHECK/);
  });

  test("the compose example writes nothing down: no log driver, read-only, no volumes, no capabilities, image by digest", () => {
    const compose = Bun.YAML.parse(read("docker-compose.example.yml")) as { services: { relay: Record<string, any> } };
    const relay = compose.services.relay;
    expect(relay.image).toContain(":?");
    expect(relay.logging).toEqual({ driver: "none" });
    expect(relay.read_only).toBe(true);
    expect(relay.cap_drop).toEqual(["ALL"]);
    expect(relay.volumes).toBeUndefined();
    expect(relay.security_opt).toContain("no-new-privileges:true");
  });

  test("the README tells an independent operator what to do and what not to do", () => {
    const readme = read("README.md");
    for (const must of ["RELAY_GATEWAYS", "secret_sha256", "access log", "independent", "docker buildx", "@sha256:"]) expect(readme).toContain(must);
    // It never asks for the secret itself to be shared.
    expect(readme).toMatch(/never send the secret/i);
  });
});
