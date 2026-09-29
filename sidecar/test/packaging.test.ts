import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, parseConfig } from "../src/config.ts";
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
    // The optional classifier server is pinned, on the internal network only, unpublished, and off unless its profile is chosen.
    const classifier = compose.services.classifier as (typeof compose.services)[string] & { profiles?: string[] };
    expect(classifier.image).toContain(":?");
    expect(classifier.ports).toBeUndefined();
    expect(classifier.networks).toEqual(["backend"]);
    expect(classifier.profiles).toEqual(["classifier"]);
  });

  test("the runtime dependencies are exactly two, each pinned to an exact version and locked", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(Object.keys(pkg.dependencies)).toEqual(["@hpke/core", "@noble/hashes"]);
    for (const v of Object.values(pkg.dependencies)) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    const lock = read("bun.lock");
    for (const [name, version] of Object.entries(pkg.dependencies)) expect(lock).toContain(`"${name}@${version}"`);
    // @hpke/core brings one internal package and nothing else.
    expect(lock).toMatch(/"@hpke\/core": \["@hpke\/core@[^"]+", "", \{ "dependencies": \{ "@hpke\/common": "[^"]+" \} \}/);
    expect(lock).toMatch(/"@hpke\/common": \["@hpke\/common@[^"]+", "", \{\}/);
    expect(pkg.license).toBe("Apache-2.0");
  });

  test("the example configuration documents the classifier and encryption, and is complete when they are switched on", () => {
    const raw = Bun.YAML.parse(read("sidecar.example.yaml")) as Record<string, any>;
    expect(raw.classifier.enabled).toBe(false);
    expect(raw.hpke.enabled).toBe(false);
    expect(raw.allowlist.classifier_digests).toHaveLength(1);
    raw.classifier.enabled = true;
    raw.hpke.enabled = true;
    const cfg = parseConfig(raw, {});
    expect(cfg.classifier).toMatchObject({ enabled: true, kind: "openai_chat", nonTextInput: "refuse", checkResponse: false });
    expect(cfg.classifier.model.path).toBeTruthy();
    expect(cfg.hpke).toEqual({ enabled: true, clockSkewSeconds: 300 });
    expect(cfg.allowlist.classifierDigests).toHaveLength(1);
  });
});
