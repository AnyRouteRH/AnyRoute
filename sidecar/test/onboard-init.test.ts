import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { hashModelPath } from "../src/digest.ts";
import { Flags, parseFlags, UsageError } from "../src/onboard/args.ts";
import { runInit, fetchTarballSha256 } from "../src/onboard/init.ts";
import { BUN_IMAGE, BUN_IMAGE_DIGEST, DEFAULT_COMMIT_CONFIG_KEYS, DEFAULT_SIDECAR_COMMIT, DEFAULT_SIDECAR_TARBALL_SHA256, LLAMACPP_IMAGE } from "../src/onboard/pins.ts";
import { resolveInit } from "../src/onboard/spec.ts";
import { FILES } from "../src/onboard/state.ts";
import { main } from "../src/cli.ts";
import { sha256Hex } from "../src/util.ts";
import { cleanup, tmpDir } from "./helpers.ts";
import { FIXED_KEY, IMAGE, REV, gpuFlags, scriptedIo, weightsDir, weightsFile } from "./onboard-helpers.ts";

afterEach(cleanup);

const root = join(import.meta.dir, "..");
const INIT_FLAGS = ["target", "weights", "server", "model-image", "id", "out", "hf-repo", "hf-revision", "served-name", "hostname"];

async function init(argv: string[], answers?: string[]) {
  const io = scriptedIo(answers);
  const flags = new Flags(parseFlags(argv, Object.fromEntries([...INIT_FLAGS.map((f) => [f, "string" as const]), ...["yes", "force", "gpu", "fetch-source-hash", "retains-prompts", "training", "zdr"].map((f) => [f, "boolean" as const]), ...["exclude", "hostname", "datacenter"].map((f) => [f, "list" as const]), ...["royalty-recipient", "sidecar-commit", "sidecar-sha256", "sidecar-repo", "requests-per-minute", "tokens-per-minute", "payout-address", "contact", "retention-days", "url", "context-size", "max-tokens", "max-model-len", "host-weights-path"].map((f) => [f, "string" as const])])));
  const spec = await resolveInit(flags, io);
  const result = await runInit(spec, { io, randomKey: () => FIXED_KEY });
  return { spec, result, io };
}

const stringValues = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(stringValues) : v && typeof v === "object" ? Object.values(v).flatMap(stringValues) : []);
const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
const composeOf = (dir: string) =>
  Bun.YAML.parse(read(dir, FILES.compose)) as {
    services: Record<string, { image: string; ports?: string[]; networks?: string[]; environment?: Record<string, string>; command?: string[]; volumes?: string[]; depends_on?: unknown; user?: string; deploy?: unknown }>;
    networks: Record<string, { internal?: boolean }>;
    volumes?: Record<string, unknown>;
  };

describe("the pins are the ones sidecar/examples/phala runs", () => {
  const example = readFileSync(join(root, "examples/phala/docker-compose.yml"), "utf8");
  test("images, commit and tarball hash", () => {
    expect(example).toContain(BUN_IMAGE);
    expect(example).toContain(LLAMACPP_IMAGE);
    expect(example).toContain(`rev=${DEFAULT_SIDECAR_COMMIT}`);
    expect(example).toContain(`sum=${DEFAULT_SIDECAR_TARBALL_SHA256}`);
    expect(BUN_IMAGE).toContain(`@${BUN_IMAGE_DIGEST}`);
    const yaml = readFileSync(join(root, "examples/phala/sidecar.yaml"), "utf8");
    expect(yaml).toContain(BUN_IMAGE_DIGEST);
  });
  test("legacy generator keys remain supported; the example's v2 extension needs the current loader", () => {
    const current = parseConfig({ model: { digest: "sha256:" + "0".repeat(64) }, auth: { allow_anonymous: true } }, {});
    expect(current).toBeTruthy();
    const exampleKeys = Bun.YAML.parse(readFileSync(join(root, "examples/phala/sidecar.yaml"), "utf8")) as Record<string, unknown>;
    for (const k of Object.keys(exampleKeys).filter(k => k !== "bindings")) expect(DEFAULT_COMMIT_CONFIG_KEYS[""]).toContain(k);
    expect(DEFAULT_COMMIT_CONFIG_KEYS[""]).not.toContain("bindings");
    expect(parseConfig(exampleKeys, { NODE_ENV: "production" }).bindings?.version).toBe(2);
  });
});

describe("init writes a deployment for each target", () => {
  test("phala-gpu: pinned, internal model server, weights fetched by per-file sha256, config copied verbatim", async () => {
    const weights = weightsDir();
    const out = join(tmpDir(), "p");
    const { result, io } = await init(gpuFlags(weights, out, ["--served-name", "demo"]));
    const yaml = read(out, FILES.yaml);
    const c = composeOf(out);

    // sidecar.yaml loads with the sidecar's own loader, and only with keys the default commit knows.
    const cfg = parseConfig(Bun.YAML.parse(yaml), {});
    expect(cfg.attestation.provider).toBe("dstack");
    expect(cfg.model).toMatchObject({ path: "/models/model", servedName: "demo" });
    expect(cfg.allowlist.modelDigests).toEqual([(await hashModelPath(weights)).digest]);
    expect(cfg.auth.allowAnonymous).toBe(false);
    const raw = Bun.YAML.parse(yaml) as Record<string, Record<string, unknown>>;
    for (const [section, keys] of Object.entries(raw)) {
      if (!(section in DEFAULT_COMMIT_CONFIG_KEYS[""].reduce((a, k) => ({ ...a, [k]: 1 }), {}))) throw new Error(`unknown top-level key ${section}`);
      if (DEFAULT_COMMIT_CONFIG_KEYS[section] && keys && typeof keys === "object" && !Array.isArray(keys)) for (const k of Object.keys(keys)) expect(DEFAULT_COMMIT_CONFIG_KEYS[section]).toContain(k);
    }

    // the compose file
    expect(c.services.sidecar.environment?.SIDECAR_CONFIG_YAML).toBe(yaml);
    for (const [name, svc] of Object.entries(c.services)) expect({ name, pinned: /@sha256:[0-9a-f]{64}$/.test(svc.image) }).toEqual({ name, pinned: true });
    expect(c.services.vllm.image).toBe(IMAGE);
    expect(c.services.vllm.ports).toBeUndefined();
    expect(c.services.vllm.networks).toEqual(["backend"]);
    expect(c.services["model-fetch"].networks).toEqual(["egress"]);
    expect(c.networks.backend.internal).toBe(true);
    expect(c.services.sidecar.ports).toEqual(["8443:8443"]);
    expect(c.services.vllm.deploy).toBeTruthy();
    expect(c.services.sidecar.environment).not.toHaveProperty("SIDECAR_DEV_ATTESTATION");
    expect(c.volumes).toEqual({ models: {} });
    // nothing is interpolated by compose except the two platform variables
    const compose = read(out, FILES.compose);
    expect([...compose.matchAll(/\$\{([A-Z_]+)\}/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).sort()).toEqual(["DSTACK_APP_ID", "DSTACK_GATEWAY_DOMAIN"]);
    expect(stringValues(c.services).map((v) => v.replace(/\$\$/g, "").replace(/\$\{DSTACK_(APP_ID|GATEWAY_DOMAIN)\}/g, "")).filter((v) => v.includes("$"))).toEqual([]);
    // the source is the pinned commit's tarball with its hash
    expect(compose).toContain(`rev=${DEFAULT_SIDECAR_COMMIT}`);
    expect(compose).toContain(`sum=${DEFAULT_SIDECAR_TARBALL_SHA256}`);
    // every weight file is listed with the sha256 the digest was computed from
    const manifest = (await hashModelPath(weights)).manifest;
    for (const m of manifest) expect(compose).toContain(`${m.sha256} ${m.path}`);
    expect(compose).toContain(`https://huggingface.co/Org/Model/resolve/${REV}`);
    expect(io.errText()).toContain("Hashing");
    expect(result.modelDigest).toBe((await hashModelPath(weights)).digest);
  });

  test("phala-cpu: llama.cpp from the pinned image, one GGUF file that keeps its name", async () => {
    const file = weightsFile("tiny-q4.gguf");
    const out = join(tmpDir(), "p");
    await init(["--yes", "--target", "phala-cpu", "--weights", file, "--hf-repo", "Org/Tiny-GGUF", "--hf-revision", REV, "--id", "tiny", "--out", out, "--max-tokens", "512"]);
    const c = composeOf(out);
    expect(c.services.llama.image).toBe(LLAMACPP_IMAGE);
    expect(c.services.llama.command).toEqual(["-m", "/models/tiny-q4.gguf", "--alias", "tiny-q4", "--host", "0.0.0.0", "--port", "8080", "-c", "4096", "-n", "512"]);
    expect(c.services.llama.deploy).toBeUndefined();
    const cfg = parseConfig(Bun.YAML.parse(read(out, FILES.yaml)), {});
    expect(cfg.model.path).toBe("/models/tiny-q4.gguf");
    expect(cfg.upstream.baseUrl).toBe("http://llama:8080");
    expect(read(out, FILES.compose)).toContain(`${(await hashModelPath(file)).manifest[0].sha256} tiny-q4.gguf`);
  });

  test("tdx-host: tdx attestation, the compose file is mounted and hashed, weights are a read-only bind mount", async () => {
    const weights = weightsDir();
    const out = join(tmpDir(), "p");
    await init(["--yes", "--target", "tdx-host", "--weights", weights, "--model-image", IMAGE, "--hostname", "llm.example.org", "--hostname", "203.0.113.7", "--id", "tdx-demo", "--out", out, "--royalty-recipient", "0x1111111111111111111111111111111111111111", "--host-weights-path", "/srv/models/my model"]);
    const yaml = read(out, FILES.yaml);
    const cfg = parseConfig(Bun.YAML.parse(yaml), {});
    expect(cfg.attestation.provider).toBe("tdx");
    expect(cfg.compose.file).toBe("/etc/sidecar/docker-compose.yml");
    expect(cfg.server.hostnames).toEqual(["llm.example.org", "203.0.113.7"]);
    expect(cfg.royalty.recipient).toBe("0x1111111111111111111111111111111111111111");
    const c = composeOf(out);
    expect(c.services.sidecar.user).toBe("root");
    expect(c.services.sidecar.volumes).toContain("./docker-compose.yml:/etc/sidecar/docker-compose.yml:ro");
    expect(c.services.sidecar.volumes).toContain("/sys/kernel/config:/sys/kernel/config");
    expect(c.services.sidecar.volumes).toContain("/srv/models/my model:/models/model:ro");
    expect(c.services.vllm.volumes).toEqual(["/srv/models/my model:/models/model:ro"]);
    expect(c.services["model-fetch"]).toBeUndefined();
    expect(c.services.vllm.ports).toBeUndefined();
    expect(c.networks.backend.internal).toBe(true);
    expect(c.services.sidecar.environment?.SIDECAR_CONFIG_YAML).toBe(yaml);
    expect(stringValues(c.services).map((v) => v.replace(/\$\$/g, "")).filter((v) => v.includes("$"))).toEqual([]);
    // the manifest records the hash of the compose file the sidecar will hash at boot
    const manifest = JSON.parse(read(out, FILES.manifest));
    expect(manifest.compose_sha256).toBe(sha256Hex(read(out, FILES.compose)));
  });

  test("the same inputs give the same files, and the output does not depend on where it was written", async () => {
    const weights = weightsDir();
    const a = join(tmpDir(), "a");
    const b = join(tmpDir(), "b");
    await init(gpuFlags(weights, a));
    await init(gpuFlags(weights, b));
    for (const f of [FILES.yaml, FILES.compose]) expect(read(a, f)).toBe(read(b, f));
    expect(read(a, FILES.compose)).not.toContain(a);
    expect(read(a, FILES.yaml)).not.toContain(weights);
    expect(read(a, FILES.compose)).not.toContain(weights);
  });

  test("the digest is the one `digest` prints, and excluded files are neither hashed nor downloaded", async () => {
    const weights = weightsDir({ "config.json": "{}", "model.safetensors": "abc".repeat(50), "README.md": "docs" });
    const out = join(tmpDir(), "p");
    const { result } = await init(gpuFlags(weights, out, ["--exclude", "*.md"]));
    const proc = Bun.spawnSync(["bun", join(root, "src/cli.ts"), "digest", weights, "--exclude", "*.md"]);
    expect(new TextDecoder().decode(proc.stdout).trim()).toBe(result.modelDigest);
    expect(read(out, FILES.compose)).not.toContain("README.md");
    expect(read(out, FILES.yaml)).toContain('exclude: ["*.md"]');
    expect((await hashModelPath(weights)).digest).not.toBe(result.modelDigest);
  });
});

describe("the router key", () => {
  test("is 32 random bytes in a 0600 file; only its SHA-256 appears anywhere else", async () => {
    const out = join(tmpDir(), "p");
    const { result } = await init(gpuFlags(weightsDir(), out));
    const keyPath = join(out, FILES.key);
    expect(result.keyCreated).toBe(true);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(read(out, FILES.key).trim()).toBe(FIXED_KEY);
    const yaml = read(out, FILES.yaml);
    expect(yaml).toContain(sha256Hex(FIXED_KEY));
    for (const f of [FILES.yaml, FILES.compose, FILES.manifest]) expect(read(out, f)).not.toContain(FIXED_KEY);
    expect(read(out, FILES.gitignore)).toContain(FILES.key);
  });

  test("a real random key is generated when none is injected, and a second run keeps it", async () => {
    const out = join(tmpDir(), "p");
    const weights = weightsDir();
    const io = scriptedIo();
    const flagsFor = () => new Flags(parseFlags(gpuFlags(weights, out, ["--force"]), Object.fromEntries(["yes", "force"].map((f) => [f, "boolean"]).concat(["target", "weights", "hf-repo", "hf-revision", "model-image", "id", "out"].map((f) => [f, "string"])) as [string, "string" | "boolean"][])));
    const first = await runInit(await resolveInit(flagsFor(), io), { io });
    const key = read(out, FILES.key).trim();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(first.keyCreated).toBe(true);
    const second = await runInit(await resolveInit(flagsFor(), io), { io });
    expect(second.keyCreated).toBe(false);
    expect(read(out, FILES.key).trim()).toBe(key);
    expect(read(out, FILES.yaml)).toContain(sha256Hex(key));
  });

  test("a damaged key file is an error, not a silent new key", async () => {
    const out = join(tmpDir(), "p");
    await init(gpuFlags(weightsDir(), out));
    await Bun.write(join(out, FILES.key), "not a key\n");
    await expect(init(gpuFlags(weightsDir(), out, ["--force"]))).rejects.toThrow(/does not hold a 64-character hex key/);
    expect(read(out, FILES.key)).toBe("not a key\n");
  });
});

describe("nothing is overwritten without --force", () => {
  test("a second init refuses, changes nothing, and --force replaces the generated files only", async () => {
    const out = join(tmpDir(), "p");
    const weights = weightsDir();
    await init(gpuFlags(weights, out));
    const before = [FILES.yaml, FILES.compose, FILES.manifest].map((f) => read(out, f));
    await expect(init(gpuFlags(weights, out))).rejects.toThrow(/already exist.*--force/);
    expect([FILES.yaml, FILES.compose, FILES.manifest].map((f) => read(out, f))).toEqual(before);
    await Bun.write(join(out, "notes.txt"), "mine");
    await init(gpuFlags(weights, out, ["--force", "--requests-per-minute", "60"]));
    expect(read(out, FILES.yaml)).toContain("requests_per_minute: 60");
    expect(read(out, "notes.txt")).toBe("mine");
  });
});

describe("bad input is refused before anything is written", () => {
  const cases: [string, string[], RegExp][] = [
    ["a branch name where a commit is needed", ["--hf-revision", "main"], /--hf-revision: expected a full 40-character commit hash/],
    ["a model image that is only a tag", ["--model-image", "vllm/vllm-openai:latest"], /pinned by digest/],
    ["a sidecar commit that is not a commit", ["--sidecar-commit", "main"], /--sidecar-commit/],
    ["a different sidecar commit with no tarball hash", ["--sidecar-commit", "a".repeat(40)], /--sidecar-sha256/],
    ["a tarball hash that is not a hash", ["--sidecar-sha256", "abc"], /--sidecar-sha256/],
    ["a provider id with capitals", ["--id", "Demo"], /--id/],
    ["a served name with a space", ["--served-name", "my model"], /--served-name/],
    ["an unknown option", ["--bogus", "1"], /unknown option --bogus/],
    ["zero data retention declared together with retention", ["--retains-prompts", "--zdr"], /--zdr/],
    ["a payout address that is not an address", ["--payout-address", "0x12"], /--payout-address/],
    ["a target that does not exist", ["--target", "aws"], /--target must be one of/],
  ];
  for (const [name, extra, re] of cases) {
    test(name, async () => {
      const out = join(tmpDir(), "p");
      await expect(init(gpuFlags(weightsDir(), out, extra))).rejects.toThrow(re);
      expect(existsSync(join(out, FILES.yaml))).toBe(false);
    });
  }

  test("vLLM with a file, llama.cpp with a directory, CPU with vLLM, and a TDX host with no name", async () => {
    const out = join(tmpDir(), "p");
    await expect(init(["--yes", "--target", "phala-cpu", "--weights", weightsDir(), "--hf-repo", "Org/M", "--hf-revision", REV, "--id", "x1", "--out", out])).rejects.toThrow(/one GGUF file/);
    await expect(init(["--yes", "--target", "phala-gpu", "--weights", weightsFile(), "--hf-repo", "Org/M", "--hf-revision", REV, "--model-image", IMAGE, "--id", "x1", "--out", out])).rejects.toThrow(/directory of weights/);
    await expect(init(["--yes", "--target", "phala-cpu", "--server", "vllm", "--weights", weightsFile(), "--hf-repo", "Org/M", "--hf-revision", REV, "--model-image", IMAGE, "--id", "x1", "--out", out])).rejects.toThrow(/phala-cpu runs llama.cpp/);
    await expect(init(["--yes", "--target", "tdx-host", "--weights", weightsDir(), "--model-image", IMAGE, "--id", "x1", "--out", out])).rejects.toThrow(/--hostname is required/);
    await expect(init(["--yes", "--target", "phala-gpu", "--weights", join(tmpDir(), "nope"), "--hf-repo", "Org/M", "--hf-revision", REV, "--model-image", IMAGE, "--id", "x1", "--out", out])).rejects.toThrow(/cannot be read/);
  });

  test("a file the download script could not fetch by name stops a Phala init", async () => {
    const weights = weightsDir({ "config.json": "{}", "my weights.bin": "x" });
    await expect(init(gpuFlags(weights, join(tmpDir(), "p")))).rejects.toThrow(/cannot fetch by name/);
  });

  test("without --yes and no terminal, a missing value is named rather than guessed", async () => {
    await expect(init(["--target", "phala-gpu"])).rejects.toThrow(/--weights is required/);
  });
});

describe("the sidecar source hash", () => {
  test("--fetch-source-hash hashes what the download serves", async () => {
    const body = new TextEncoder().encode("tarball bytes");
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => (seen.push(String(url)), new Response(body))) as unknown as typeof fetch;
    expect(await fetchTarballSha256("Org/Repo", "b".repeat(40), fetchImpl)).toBe(createHash("sha256").update(body).digest("hex"));
    expect(seen).toEqual([`https://codeload.github.com/Org/Repo/tar.gz/${"b".repeat(40)}`]);
    await expect(fetchTarballSha256("Org/Repo", "b".repeat(40), (async () => new Response("no", { status: 404 })) as unknown as typeof fetch)).rejects.toThrow(/HTTP 404/);
  });

  test("a chosen commit with its hash is used as given", async () => {
    const out = join(tmpDir(), "p");
    await init(gpuFlags(weightsDir(), out, ["--sidecar-commit", "c".repeat(40), "--sidecar-sha256", "d".repeat(64), "--sidecar-repo", "Org/Fork"]));
    const compose = read(out, FILES.compose);
    expect(compose).toContain(`rev=${"c".repeat(40)}`);
    expect(compose).toContain(`sum=${"d".repeat(64)}`);
    expect(compose).toContain("https://codeload.github.com/Org/Fork/tar.gz/$$rev");
    expect(compose).toContain('"Fork-$$rev/sidecar"');
  });
});

describe("asking questions", () => {
  test("in a terminal the missing values are asked for, defaults are offered, and the result matches the flags", async () => {
    const weights = weightsDir();
    const out = join(tmpDir(), "p");
    // target, weights, served name, id, display name, hf repo, revision, model image, contact, retains prompts?
    const answers = ["phala-gpu", weights, "", "", "Demo Model", "Org/Model", REV, IMAGE, "ops@example.org", "n"];
    const { spec, io } = await init(["--out", out], answers);
    expect(io.asked.length).toBe(answers.length);
    expect(spec).toMatchObject({ target: "phala-gpu", server: "vllm", providerName: "Demo Model", contact: "ops@example.org", dataPolicy: { training: false, retains_prompts: false } });
    expect(spec.providerId).toMatch(/^[a-z0-9-]+$/);
    expect(spec.hf).toEqual({ repo: "Org/Model", revision: REV });
  });

  test("a wrong answer is explained and asked again", async () => {
    const weights = weightsDir();
    const answers = ["phala-gpu", weights, "demo", "demo-id", "Demo", "not a repo", "Org/Model", "main", REV, IMAGE, "", "n"];
    const { spec, io } = await init(["--out", join(tmpDir(), "p")], answers);
    expect(spec.hf).toEqual({ repo: "Org/Model", revision: REV });
    expect(io.errText()).toContain("expected owner/name");
    expect(io.errText()).toContain("40-character commit hash");
  });
});

describe("the command line", () => {
  test("init prints the digest on stdout and the next steps on stderr, and exits 0", async () => {
    const io = scriptedIo();
    const out = join(tmpDir(), "p");
    const code = await main(["init", ...gpuFlags(weightsDir(), out)], { io });
    expect(code).toBe(0);
    expect(io.outText()).toMatch(/^model digest sha256:[0-9a-f]{64}$/m);
    expect(io.errText()).toContain("docker-compose.yml");
    expect(io.errText()).toContain("router-api-key");
    expect(io.errText()).toContain("does not collect NVIDIA");
    expect(io.errText()).not.toMatch(/[0-9a-f]{64}\n.*router-api-key/);
  });

  test("usage errors exit 2 and name the problem", async () => {
    const io = scriptedIo();
    expect(await main(["init", "--yes", "--target", "nowhere"], { io })).toBe(2);
    expect(io.errText()).toContain("--target must be one of");
    const io2 = scriptedIo();
    expect(await main(["frobnicate"], { io: io2 })).toBe(2);
    expect(await main(["help"], { io: io2 })).toBe(0);
    expect(io2.outText()).toContain("cli.ts init");
  });
});
