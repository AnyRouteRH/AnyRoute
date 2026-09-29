import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "../config.ts";
import { hashModelPath } from "../digest.ts";
import { SidecarError, sha256Hex, type Logger } from "../util.ts";
import { SIDECAR_VERSION } from "../version.ts";
import type { Io } from "./io.ts";
import { BUN_IMAGE_DIGEST } from "./pins.ts";
import { renderCompose, renderSidecarYaml } from "./render.ts";
import type { InitSpec } from "./spec.ts";
import { UsageError } from "./args.ts";
import { FILES, type Manifest } from "./state.ts";

export type InitDeps = {
  io: Io;
  fetchImpl?: typeof fetch;
  /** 32 random bytes for the router key. Injectable for tests. */
  randomKey?: () => string;
  logger?: Logger;
};

export type InitResult = {
  dir: string;
  manifest: Manifest;
  files: string[];
  keyCreated: boolean;
  keyPath: string;
  modelDigest: string;
  tarballSha256: string;
};

const MAX_TARBALL_BYTES = 256 * 1024 * 1024;

/** Downloads a commit's tarball and returns its sha256. Only for `--fetch-source-hash`; the result is what you fetched now. */
export async function fetchTarballSha256(repo: string, commit: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = `https://codeload.github.com/${repo}/tar.gz/${commit}`;
  const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new SidecarError("SOURCE_DOWNLOAD", `could not download ${url}: HTTP ${res.status}`);
  const h = createHash("sha256");
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_TARBALL_BYTES) throw new SidecarError("SOURCE_DOWNLOAD", `${url} is larger than ${MAX_TARBALL_BYTES / 1024 / 1024} MiB; refusing`);
    h.update(chunk);
  }
  return h.digest("hex");
}

function writeNew(path: string, content: string, mode: number, force: boolean) {
  writeFileSync(path, content, { mode, flag: force ? "w" : "wx" });
  if (force) chmodSync(path, mode);
}

/** The router key: reused when its file exists (so a second `init` does not lock the router out), otherwise 32 random bytes as hex. */
function routerKey(dir: string, gen: () => string): { key: string; created: boolean; path: string } {
  const path = join(dir, FILES.key);
  if (existsSync(path)) {
    const key = readFileSync(path, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(key)) throw new SidecarError("BAD_KEY_FILE", `${path} exists but does not hold a 64-character hex key; move it aside or fix it`);
    return { key, created: false, path };
  }
  const key = gen();
  writeFileSync(path, key + "\n", { mode: 0o600, flag: "wx" });
  return { key, created: true, path };
}

export async function runInit(spec: InitSpec, deps: InitDeps): Promise<InitResult> {
  const { io } = deps;
  const dir = spec.outDir;
  mkdirSync(dir, { recursive: true });

  const targets = [FILES.yaml, FILES.compose, FILES.manifest].map((f) => join(dir, f));
  const existing = targets.filter((p) => existsSync(p));
  if (existing.length && !spec.force) throw new UsageError(`${existing.join(", ")} already exist${existing.length === 1 ? "s" : ""}; pass --force to replace them (the router key is kept either way)`);

  io.err(`Hashing ${spec.weightsPath} ...`);
  const hashed = await hashModelPath(spec.weightsPath, { exclude: spec.exclude, logger: deps.logger });
  io.err(`  ${hashed.digest} (${hashed.files} file${hashed.files === 1 ? "" : "s"}, ${(hashed.bytes / 1e9).toFixed(2)} GB)`);
  if (spec.hf) {
    for (const m of hashed.manifest) {
      if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(m.path) || m.path.split("/").some((seg) => seg === "" || seg === "." || seg === ".."))
        throw new UsageError(`the weights contain a file the Phala download script cannot fetch by name: ${JSON.stringify(m.path)} (use letters, digits and . _ - / only, or leave it out with --exclude)`);
    }
  }

  let tarballSha256 = spec.sidecar.sha256;
  if (!tarballSha256) {
    io.err(`Downloading commit ${spec.sidecar.commit.slice(0, 12)} of ${spec.sidecar.repo} to compute its sha256 ...`);
    tarballSha256 = await fetchTarballSha256(spec.sidecar.repo, spec.sidecar.commit, deps.fetchImpl);
    io.err(`  ${tarballSha256}  (computed from what was served just now; compare it with a second download before you trust it)`);
  }

  const key = routerKey(dir, deps.randomKey ?? (() => randomBytes(32).toString("hex")));
  const keyHash = sha256Hex(key.key);

  const input = { spec, modelDigest: hashed.digest, keyHash, manifest: hashed.manifest, tarballSha256 };
  const yaml = renderSidecarYaml(input);
  const compose = renderCompose(input, yaml);
  selfCheck(spec, yaml, compose, hashed.digest, keyHash);

  const manifest: Manifest = {
    v: 1,
    type: "anyroute.provider.onboarding",
    sidecar_cli_version: SIDECAR_VERSION,
    target: spec.target,
    server: spec.server,
    provider: {
      id: spec.providerId,
      name: spec.providerName,
      ...(spec.contact ? { contact: spec.contact } : {}),
      datacenters: spec.datacenters,
      ...(spec.payoutAddress ? { payout_address: spec.payoutAddress.toLowerCase() } : {}),
      data_policy: spec.dataPolicy,
    },
    model: { served_name: spec.servedName, digest: hashed.digest, files: hashed.files, bytes: hashed.bytes, weights_path: spec.weightsPath, exclude: spec.exclude, ...(spec.hf ? { hf: spec.hf } : {}) },
    sidecar: { repo: spec.sidecar.repo, commit: spec.sidecar.commit, tarball_sha256: tarballSha256, runtime_image_digest: BUN_IMAGE_DIGEST },
    model_image: spec.modelImage,
    compose_sha256: sha256Hex(compose),
    router_key_sha256: keyHash,
    ...(spec.url ? { endpoint: spec.url } : {}),
  };

  writeNew(join(dir, FILES.yaml), yaml, 0o644, spec.force);
  writeNew(join(dir, FILES.compose), compose, 0o644, spec.force);
  writeNew(join(dir, FILES.manifest), JSON.stringify(manifest, null, 2) + "\n", 0o644, spec.force);
  const ignore = join(dir, FILES.gitignore);
  if (!existsSync(ignore)) writeFileSync(ignore, `${FILES.key}\n${FILES.applicationToken}\n${FILES.applicationJson}\n`);

  return { dir, manifest, files: [FILES.yaml, FILES.compose, FILES.manifest], keyCreated: key.created, keyPath: key.path, modelDigest: hashed.digest, tarballSha256 };
}

/**
 * The generated files must be what the sidecar will accept, and the compose copy of the configuration must be the file
 * verbatim. Checked with the sidecar's own loader before anything is written, so a template bug stops here and not on the
 * operator's server.
 */
function selfCheck(spec: InitSpec, yaml: string, compose: string, modelDigest: string, keyHash: string) {
  const cfg = parseConfig(Bun.YAML.parse(yaml), {});
  const problems: string[] = [];
  if (!cfg.allowlist.modelDigests.includes(modelDigest)) problems.push("the model digest is not on the allow-list");
  if (cfg.auth.keys.length !== 1 || cfg.auth.keys[0].sha256 !== keyHash || cfg.auth.allowAnonymous) problems.push("the router key is not the only key");
  if (spec.target !== "tdx-host" && cfg.attestation.provider !== "dstack") problems.push("a Phala deployment must attest through dstack");
  if (spec.target === "tdx-host" && (cfg.attestation.provider !== "tdx" || !cfg.compose.file)) problems.push("a TDX host must attest through tdx and bind its compose file");
  const doc = Bun.YAML.parse(compose) as { services: Record<string, { image?: string; environment?: Record<string, string> }>; networks: Record<string, { internal?: boolean }> };
  if (doc.services.sidecar.environment?.SIDECAR_CONFIG_YAML !== yaml) problems.push("the compose copy of sidecar.yaml differs from the file");
  if (doc.networks.backend?.internal !== true) problems.push("the model server's network is not internal");
  for (const [name, svc] of Object.entries(doc.services)) if (!/@sha256:[0-9a-f]{64}$/.test(svc.image ?? "")) problems.push(`service ${name} is not pinned by digest`);
  if (problems.length) throw new SidecarError("INIT_SELF_CHECK", `generated files failed their own check: ${problems.join("; ")}. This is a bug in the generator; nothing was written.`);
}
