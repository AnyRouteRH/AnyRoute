import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { SIDECAR_VERSION } from "../src/version.ts";

const root = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

describe("shipped files", () => {
  test("sidecar.example.yaml parses with the strict loader", () => {
    const cfg = loadConfig({}, join(root, "sidecar.example.yaml"));
    expect(cfg.server.tls).toBe("self_signed");
    expect(cfg.attestation.provider).toBe("dstack");
    expect(cfg.classifier.enabled).toBe(false);
    expect(cfg.auth.allowAnonymous).toBe(false);
    expect(cfg.allowlist.modelDigests).toHaveLength(1);
  });

  test("the package version matches the version the sidecar reports", () => {
    expect(JSON.parse(read("package.json")).version).toBe(SIDECAR_VERSION);
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
  });

  test("the compose example requires pinned images, keeps the model server off the public network and unpublished", () => {
    const compose = Bun.YAML.parse(read("docker-compose.example.yml")) as {
      services: Record<string, { image: string; ports?: string[]; networks: string[]; environment?: Record<string, string> }>;
      networks: Record<string, { internal?: boolean }>;
    };
    expect(compose.services.vllm.image).toContain(":?");
    expect(compose.services.sidecar.image).toContain(":?");
    expect(compose.services.vllm.ports).toBeUndefined();
    expect(compose.services.vllm.networks).toEqual(["backend"]);
    expect(compose.networks.backend.internal).toBe(true);
    expect(compose.services.sidecar.environment?.SIDECAR_DEV_ATTESTATION).toBeUndefined();
  });

  test("the lockfile carries exactly the runtime dependency", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(Object.keys(pkg.dependencies)).toEqual(["@noble/hashes"]);
    expect(pkg.dependencies["@noble/hashes"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.license).toBe("Apache-2.0");
  });
});
