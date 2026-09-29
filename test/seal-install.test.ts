import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSupported, check, loadSchema, parseSealText, validateSeal, type SealConfig } from "../deploy/seal/validate.ts";
import { parseConfig } from "../sidecar/src/config.ts";
import { UsageError } from "../sidecar/src/onboard/args.ts";
import { main as sealMain, parseCli, renderSealYaml, runStatus, runVerify, upsertNode } from "../scripts/seal-cli.ts";

// The SEAL host install package: seal.yaml schema and validator, install.sh (run for real against a fake engine in a
// temp dir), the seal CLI, and the Compose, Helm and Terraform files checked as files. Nothing here needs Docker,
// Helm, Terraform or a cloud; when shellcheck, helm or terraform are installed their checks run too.

const root = resolve(import.meta.dir, "..");
const seal = (p: string) => resolve(root, "deploy/seal", p);
const read = (p: string) => readFileSync(p, "utf8");
const INSTALL = seal("install.sh");
const schema = loadSchema();
const HEX = "ab".repeat(32);
const DIGEST = `sha256:${HEX}`;
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const which = (bin: string) => Bun.which(bin);

const tmp = mkdtempSync(join(tmpdir(), "seal-install-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Engine = { port: number; stop: () => void };
function fakeEngine(kind: "vllm" | "ollama"): Engine {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/v1/models")
        return Response.json(kind === "vllm" ? { object: "list", data: [{ id: "tiny-model", object: "model", owned_by: "vllm" }] } : { object: "list", data: [{ id: "llama3:8b", object: "model", owned_by: "library" }] });
      if (kind === "ollama" && p === "/api/version") return Response.json({ version: "0.0.0" });
      return new Response("not found", { status: 404 });
    },
  });
  return { port: server.port!, stop: () => server.stop(true) };
}

type Run = { code: number; stdout: string; stderr: string };
async function install(args: string[], env: Record<string, string> = {}): Promise<Run> {
  // Async spawn: the fake servers live in this process and must keep answering while the installer runs.
  const proc = Bun.spawn(["sh", INSTALL, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmp, SEAL_PROBE_TIMEOUT: "2", ...env } });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}
const base = (dir: string, port: number) => ["--non-interactive", "--dir", dir, "--probe-ports", String(port), "--hf-repo", "example-org/example-model", "--weights-sha256", HEX, "--price-in", "0.20", "--price-out", "0.9", "--region", "eu-west"];

// ---- schema and validator ---------------------------------------------------------------------------------------

describe("seal.yaml schema and validator", () => {
  const good = (): SealConfig => parseSealText(read(seal("seal.example.yaml"))) as SealConfig;

  test("the example is valid, and the validator implements every keyword the schema uses", () => {
    expect(() => assertSupported(schema)).not.toThrow();
    const r = validateSeal(good());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(() => assertSupported({ type: "object", oneOf: [] })).toThrow(/oneOf/);
  });

  test("unknown settings, bad digests, duplicate lanes and unquoted-looking values are refused", () => {
    const c = good() as unknown as Record<string, unknown>;
    expect(validateSeal({ ...c, surprise: 1 }).errors.join()).toContain("/surprise: unknown setting");
    expect(validateSeal({ ...c, model: { ...(c.model as object), weights_sha256: "sha256:abc" } }).ok).toBe(false);
    expect(validateSeal({ ...c, lanes: ["public", "public"] }).errors.join()).toContain("unique");
    expect(validateSeal({ ...c, gpu: { cc_mode: true, multi_gpu: "single" } }).errors.join()).toContain("/gpu/cc_mode");
    expect(validateSeal({ ...c, version: 2 }).ok).toBe(false);
    expect(validateSeal({ ...c, pricing: { input_per_m_usdg: -1, output_per_m_usdg: 1 } }).ok).toBe(false);
  });

  test("attested lanes and GPU claims need Intel TDX; SEV-SNP is CPU-only", () => {
    const c = good();
    const snpAttested = validateSeal({ ...c, tee: "sev-snp", gpu: { cc_mode: "off", multi_gpu: "single" } });
    expect(snpAttested.ok).toBe(false);
    expect(snpAttested.errors.join()).toContain("need an Intel TDX host");
    const snpGpu = validateSeal({ ...c, tee: "sev-snp", lanes: ["public"] });
    expect(snpGpu.errors.join()).toContain("SEV-SNP has no runtime measurement register");
    const snpPublic = validateSeal({ ...c, tee: "sev-snp", lanes: ["public"], gpu: { cc_mode: "off", multi_gpu: "single" } });
    expect(snpPublic.ok).toBe(true);
    expect(snpPublic.warnings.join()).toContain("CPU claims only");
  });

  test("warnings name the consequences a host should read", () => {
    const r = validateSeal({ ...good(), gpu: { cc_mode: "on", multi_gpu: "ppcie" }, engine: "ollama" });
    expect(r.ok).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/NVLink traffic between GPUs is not encrypted[\s\S]*no batch-invariant/);
  });

  test("the standalone validator exits 0 when valid and 3 when not", () => {
    const ok = Bun.spawnSync(["bun", seal("validate.ts"), seal("seal.example.yaml")]);
    expect(ok.exitCode).toBe(0);
    const bad = join(tmp, "bad.yaml");
    writeFileSync(bad, "version: 1\nengine: vllm\n");
    const r = Bun.spawnSync(["bun", seal("validate.ts"), bad]);
    expect(r.exitCode).toBe(3);
    expect(r.stderr.toString()).toContain("/model: required");
  });
});

// ---- the installer ----------------------------------------------------------------------------------------------

describe("install.sh", () => {
  const text = read(INSTALL);
  let engine: Engine;
  beforeAll(() => {
    engine = fakeEngine("vllm");
  });
  afterAll(() => engine.stop());

  test("its patterns are the schema's patterns", () => {
    const re = (name: string) => new RegExp(`^${name}='([^']*)'$`, "m").exec(text)?.[1];
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const model = (props.model.properties as Record<string, Record<string, unknown>>);
    expect(re("RE_HOST_ID")).toBe(props.host_id.pattern as string);
    expect(re("RE_ENGINE_URL")).toBe(props.engine_url.pattern as string);
    expect(re("RE_SERVED_NAME")).toBe(model.served_name.pattern as string);
    expect(re("RE_HF_REPO")).toBe(model.hf_repo.pattern as string);
    expect(re("RE_SHA256")).toBe(model.weights_sha256.pattern as string);
    expect(re("RE_SHA256")).toBe(model.tokenizer_sha256.pattern as string);
    expect(re("RE_QUANT")).toBe(model.quant.pattern as string);
    expect(re("RE_CREATOR")).toBe(model.creator_handle.pattern as string);
    expect(re("RE_POLICY")).toBe(props.policy.pattern as string);
    expect(re("RE_KMS")).toBe(props.kms.pattern as string);
    expect(re("RE_REGION")).toBe(props.region.pattern as string);
  });

  test("the compose template it embeds is deploy/seal/docker-compose.seal.yaml, byte for byte", () => {
    const embedded = /cat <<'SEAL_COMPOSE_EOF'\n([\s\S]*?)\nSEAL_COMPOSE_EOF\n/.exec(text)![1];
    expect(`${embedded}\n`).toBe(read(seal("docker-compose.seal.yaml")));
  });

  test("POSIX sh, set -eu, and shellcheck-clean when shellcheck is installed", () => {
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).toMatch(/^set -eu$/m);
    expect(text).not.toMatch(/\[\[|^\s*function\s|^\s*local\s|<<<|\$\{[A-Za-z_]+\/\//m);
    const sc = which("shellcheck");
    if (!sc) return;
    const r = Bun.spawnSync([sc, "-s", "sh", INSTALL]);
    expect(r.stdout.toString() + r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
  });

  test("dry run: finds the engine, writes valid files, keeps the key off stdout, and changes nothing on a re-run", async () => {
    const dir = join(tmp, "dry");
    const weights = join(tmp, "weights");
    mkdirSync(weights);
    const r = await install([...base(dir, engine.port), "--tee", "tdx", "--attestation", "tdx", "--cc-mode", "on", "--weights-dir", weights]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`engine:    vllm at http://127.0.0.1:${engine.port}`);
    expect(r.stdout).toContain("checked    seal.yaml against seal.schema.json");
    expect(r.stdout).toMatch(/registry:  https:\/\/\S+\/registry\/<provider id>\//);
    expect(r.stdout).toContain("placeholder address, not live yet");
    expect(readdirSync(dir).sort()).toEqual([".gitignore", "docker-compose.seal.yaml", "router-api-key", "seal.yaml", "sidecar.yaml"]);

    // seal.yaml: valid, and what was asked for.
    const v = validateSeal(parseSealText(read(join(dir, "seal.yaml"))));
    expect(v.errors).toEqual([]);
    const c = v.value!;
    expect(c).toMatchObject({ engine: "vllm", engine_url: `http://127.0.0.1:${engine.port}`, lanes: ["public", "attested"], tee: "tdx", gpu: { cc_mode: "on", multi_gpu: "single" }, pricing: { input_per_m_usdg: 0.2, output_per_m_usdg: 0.9 } });
    expect(c.model).toEqual({ served_name: "tiny-model", hf_repo: "example-org/example-model", weights_sha256: DIGEST, quant: "bf16" });
    expect(c.host_id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(read(join(dir, "seal.yaml"))).toContain('cc_mode: "on"');

    // The key: 0600, 64 hex, never printed; only its SHA-256 is in sidecar.yaml.
    const key = read(join(dir, "router-api-key"));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(dir, "router-api-key")).mode & 0o777).toBe(0o600);
    expect(r.stdout + r.stderr).not.toContain(key);
    for (const f of ["seal.yaml", "sidecar.yaml", "docker-compose.seal.yaml"]) expect(read(join(dir, f))).not.toContain(key);

    // sidecar.yaml is accepted by the sidecar's own loader.
    const sc = parseConfig(Bun.YAML.parse(read(join(dir, "sidecar.yaml"))));
    expect(sc.auth.keys).toEqual([{ id: "router", sha256: sha256(key), quota: undefined }]);
    expect(sc.upstream.baseUrl).toBe(`http://127.0.0.1:${engine.port}`);
    expect(sc.allowlist.modelDigests).toEqual([DIGEST]);
    expect(sc.model.path).toBe("/models/model");
    expect(sc.attestation.provider).toBe("tdx");

    // The compose file: rendered, tagged lines for tdx and weights kept, no placeholder left, labels commit to the files.
    const composeText = read(join(dir, "docker-compose.seal.yaml"));
    const code = composeText.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
    expect(code).not.toMatch(/__[A-Z_]+__|# seal:/);
    const compose = Bun.YAML.parse(composeText) as { services: { sidecar: Record<string, unknown> } };
    const s = compose.services.sidecar as { network_mode: string; user: string; volumes: string[]; labels: Record<string, string>; environment: Record<string, string> };
    expect(s.network_mode).toBe("host");
    expect(s.user).toBe("0:0");
    expect(s.volumes).toContain(`${weights}:/models/model:ro`);
    expect(s.volumes).toContain("/sys/kernel/config:/sys/kernel/config");
    expect(s.volumes.join()).not.toContain("dstack.sock");
    expect(s.environment.SIDECAR_DEV_ATTESTATION).toBeUndefined();
    expect(s.labels["xyz.anyroute.seal.seal-yaml-sha256"]).toBe(sha256(read(join(dir, "seal.yaml"))));
    expect(s.labels["xyz.anyroute.seal.sidecar-yaml-sha256"]).toBe(sha256(read(join(dir, "sidecar.yaml"))));
    expect(s.labels["xyz.anyroute.seal.host-id"]).toBe(c.host_id!);

    // Idempotent: the same options leave every file alone and keep host_id and the key.
    const before = Object.fromEntries(readdirSync(dir).map((f) => [f, read(join(dir, f))]));
    const again = await install([...base(dir, engine.port), "--tee", "tdx", "--attestation", "tdx", "--cc-mode", "on", "--weights-dir", weights]);
    expect(again.code).toBe(0);
    expect(again.stdout).not.toContain("  wrote ");
    expect(again.stdout.match(/ unchanged /g)?.length).toBe(4);
    expect(again.stdout).toContain("kept       ");
    expect(Object.fromEntries(readdirSync(dir).map((f) => [f, read(join(dir, f))]))).toEqual(before);
  });

  test("detects Ollama, and renders a digest-pinned image for docker compose", async () => {
    const ollama = fakeEngine("ollama");
    try {
      const dir = join(tmp, "ollama");
      const image = `registry.example/anyroute/sidecar@sha256:${"cd".repeat(32)}`;
      const r = await install([...base(dir, ollama.port), "--tee", "none", "--sidecar-image", image]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("engine:    ollama");
      const c = validateSeal(parseSealText(read(join(dir, "seal.yaml")))).value!;
      expect(c.engine).toBe("ollama");
      expect(c.model.served_name).toBe("llama3:8b");
      expect(c.lanes).toEqual(["public"]);
      expect(c.gpu.cc_mode).toBe("off");
      const s = (Bun.YAML.parse(read(join(dir, "docker-compose.seal.yaml"))) as { services: { sidecar: { image: string; environment: Record<string, string>; volumes: string[] } } }).services.sidecar;
      expect(s.image).toBe(image);
      expect(s.environment.SIDECAR_IMAGE_DIGEST).toBe(`sha256:${"cd".repeat(32)}`);
      expect(s.volumes).toEqual(["./seal.yaml:/etc/seal/seal.yaml:ro", "./sidecar.yaml:/etc/seal/sidecar.yaml:ro"]);
      expect(read(join(dir, "sidecar.yaml"))).toContain("this sidecar cannot attest here");
      const docker = which("docker");
      if (docker && Bun.spawnSync([docker, "compose", "version"]).exitCode === 0) {
        const cfg = Bun.spawnSync([docker, "compose", "-f", join(dir, "docker-compose.seal.yaml"), "config", "-q"], { cwd: dir });
        expect(cfg.stderr.toString()).toBe("");
        expect(cfg.exitCode).toBe(0);
      }
      // --apply is refused where the sidecar cannot attest.
      const apply = await install([...base(dir, ollama.port), "--tee", "none", "--sidecar-image", image, "--apply"]);
      expect(apply.code).toBe(1);
      expect(apply.stderr).toContain("has no Intel TDX");
    } finally {
      ollama.stop();
    }
  });

  test("refuses claims the hardware cannot back, and missing engines", async () => {
    const snp = await install([...base(join(tmp, "snp"), engine.port), "--tee", "sev-snp", "--lanes", "public,attested"]);
    expect(snp.code).toBe(1);
    expect(snp.stderr).toContain("attested and unlinkable lanes need an Intel TDX host");
    const snpGpu = await install([...base(join(tmp, "snp2"), engine.port), "--tee", "sev-snp", "--cc-mode", "on"]);
    expect(snpGpu.code).toBe(1);
    expect(snpGpu.stderr).toContain("SEV-SNP has no runtime measurement register");
    const none = await install([...base(join(tmp, "none"), engine.port).map((a) => (a === String(engine.port) ? "1" : a)), "--tee", "tdx"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("no OpenAI-compatible engine answered /v1/models");
    const typo = await install(["--non-interactive", "--wieghts", "x"]);
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain("unknown option --wieghts");
    const badDigest = await install([...base(join(tmp, "bd"), engine.port).map((a) => (a === HEX ? "sha256:xyz" : a)), "--tee", "tdx"]);
    expect(badDigest.code).toBe(1);
    expect(badDigest.stderr).toContain("--weights-sha256");
    const help = await install(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--weights-sha256");
    for (const d of ["snp", "snp2", "none"]) expect(existsSync(join(tmp, d, "seal.yaml"))).toBe(false);
  });

  test("--apply runs docker compose up -d, waits for the sidecar and reads its attestation", async () => {
    const ref = "ef".repeat(32);
    const sidecar = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/healthz") return Response.json({ status: "ok" });
        if (p === "/attest") return Response.json({ v: 1, dev: true, attestation_ref: ref, evidence: { kind: "dev", format: "dev-simulated" }, bindings: {} });
        return new Response("nf", { status: 404 });
      },
    });
    try {
      const dir = join(tmp, "apply");
      const log = join(tmp, "docker.log");
      const fakeDocker = join(tmp, "fake-docker");
      writeFileSync(fakeDocker, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);
      chmodSync(fakeDocker, 0o755);
      const image = `registry.example/anyroute/sidecar@sha256:${"cd".repeat(32)}`;
      const r = await install([...base(dir, engine.port), "--tee", "tdx", "--attestation", "dev", "--sidecar-image", image, "--apply", "--sidecar-url", `http://127.0.0.1:${sidecar.port}`], { SEAL_DOCKER: fakeDocker });
      expect(r.code).toBe(0);
      expect(read(log).trim()).toBe(`compose --project-directory ${dir} -f ${dir}/docker-compose.seal.yaml up -d`);
      expect(r.stdout).toContain(`attested:  reference ${ref}`);
      expect(r.stderr).toContain("SIMULATED");
      expect(JSON.parse(read(join(dir, "attest.json"))).attestation_ref).toBe(ref);
      const s = (Bun.YAML.parse(read(join(dir, "docker-compose.seal.yaml"))) as { services: { sidecar: { environment: Record<string, string> } } }).services.sidecar;
      expect(s.environment.SIDECAR_DEV_ATTESTATION).toBe("true");
    } finally {
      sidecar.stop(true);
    }
  });
});

// ---- the seal CLI -----------------------------------------------------------------------------------------------

describe("seal CLI", () => {
  test("argument parsing", () => {
    expect(parseCli([]).command).toBe("help");
    expect(parseCli(["--version"]).command).toBe("version");
    const v = parseCli(["verify", "https://h:8443", "--router", "https://r", "--id", "p1", "--json"]);
    expect(v.command).toBe("verify");
    expect(v.flags.positional).toEqual(["https://h:8443"]);
    expect(v.flags.str("id")).toBe("p1");
    expect(v.flags.bool("json")).toBe(true);
    expect(parseCli(["status", "--endpoint", "https://a", "--endpoint", "https://b"]).flags.list("endpoint")).toEqual(["https://a", "https://b"]);
    expect(() => parseCli(["verify"])).toThrow(UsageError);
    expect(() => parseCli(["verify", "https://h", "--router", "https://r"])).toThrow("--router and --id go together");
    expect(() => parseCli(["init", "--wieghts", "x"])).toThrow("unknown option --wieghts");
    expect(() => parseCli(["deploy"])).toThrow('unknown command "deploy"');
    expect(() => parseCli(["add-node", "extra"])).toThrow("unexpected argument");
  });

  test("init writes what install.sh writes; add-node adds and replaces nodes by name", async () => {
    const engine = fakeEngine("vllm");
    try {
      const dir = join(tmp, "cli-vs-installer");
      const hostId = `0x${"12".repeat(32)}`;
      const r = await install([...base(dir, engine.port), "--tee", "tdx", "--host-id", hostId, "--lanes", "public,attested,unlinkable"]);
      expect(r.code).toBe(0);
      const out = join(tmp, "cli-seal.yaml");
      const log: string[] = [];
      const code = await sealMain(["init", "--out", out, "--tee", "tdx", "--host-id", hostId, "--engine-url", `http://127.0.0.1:${engine.port}/v1`, "--model", "tiny-model", "--hf-repo", "example-org/example-model", "--weights-sha256", HEX, "--price-in", "0.20", "--price-out", "0.9", "--region", "eu-west", "--lanes", "public,attested,unlinkable"], (s) => log.push(s), (s) => log.push(s));
      expect(code).toBe(0);
      expect(parseSealText(read(out))).toEqual(parseSealText(read(join(dir, "seal.yaml"))));
      expect(await sealMain(["init", "--out", out, "--tee", "tdx", "--hf-repo", "a/b", "--weights-sha256", HEX, "--price-in", "1", "--price-out", "1", "--region", "eu"], () => {}, (s) => log.push(s))).toBe(2);
      expect(log.join()).toContain("pass --force");

      expect(await sealMain(["add-node", "--config", out, "--name", "n1", "--endpoint", "https://n1.example.invalid:8443/"], () => {}, () => {})).toBe(0);
      expect(await sealMain(["add-node", "--config", out, "--name", "n2", "--endpoint", "https://n2.example.invalid:8443", "--region", "us-east"], () => {}, () => {})).toBe(0);
      expect(await sealMain(["add-node", "--config", out, "--name", "n1", "--endpoint", "https://n1b.example.invalid:8443"], () => {}, () => {})).toBe(0);
      const c = validateSeal(parseSealText(read(out))).value!;
      expect(c.nodes).toEqual([{ name: "n1", endpoint: "https://n1b.example.invalid:8443" }, { name: "n2", endpoint: "https://n2.example.invalid:8443", region: "us-east" }]);
      expect(c.host_id).toBe(hostId);
      // --force keeps host_id and nodes.
      expect(await sealMain(["init", "--out", out, "--force", "--tee", "tdx", "--hf-repo", "a/b", "--weights-sha256", HEX, "--price-in", "1", "--price-out", "2", "--region", "eu-west"], () => {}, () => {})).toBe(0);
      const forced = validateSeal(parseSealText(read(out))).value!;
      expect(forced.host_id).toBe(hostId);
      expect(forced.nodes?.length).toBe(2);
      // An invalid node name is refused before anything is written.
      expect(await sealMain(["add-node", "--config", out, "--name", "Bad Name", "--endpoint", "https://x"], () => {}, () => {})).toBe(2);
      expect(upsertNode(forced, { name: "n3", endpoint: "http://10.0.0.3:8443/" }).nodes!.at(-1)).toEqual({ name: "n3", endpoint: "http://10.0.0.3:8443" });
      expect(renderSealYaml(forced)).toContain('cc_mode: "off"');
    } finally {
      engine.stop();
    }
  });

  test("verify reads the endpoint's evidence with the client checks and fails closed", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        if (new URL(req.url).pathname === "/attest") return Response.json({ attestation_ref: "00", evidence: { kind: "tdx", format: "tdx-quote", quote: "00", report_data: "00", nonce: null }, bindings: {} });
        return new Response("nf", { status: 404 });
      },
    });
    try {
      const bad = await runVerify({ endpoint: `http://127.0.0.1:${server.port}/`, fresh: true });
      expect(bad.ok).toBe(false);
      expect(bad.endpoint).toBe(`http://127.0.0.1:${server.port}`);
      expect(bad.checks.some((c) => c.id.startsWith("router."))).toBe(false);
      expect(bad.checks.some((c) => c.status === "fail")).toBe(true);
      expect(bad.notChecked[0]).toContain("pass --router and --id");
      const gone = await runVerify({ endpoint: "http://127.0.0.1:1", fresh: false });
      expect(gone.ok).toBe(false);
      expect(gone.checks.find((c) => c.id === "endpoint.fetch")?.status).toBe("fail");
      const lines: string[] = [];
      expect(await sealMain(["verify", `http://127.0.0.1:${server.port}`, "--json", "--config", seal("seal.example.yaml")], (s) => lines.push(s), () => {})).toBe(1);
      expect(JSON.parse(lines.join("\n")).ok).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("status reads /healthz of every node and compares the model digest", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ status: "ok", dev: false, model_digest: DIGEST, attestation: { ref: "ab".repeat(32) } }) });
    try {
      const rows = await runStatus([{ name: "n1", endpoint: `http://127.0.0.1:${server.port}` }, { name: "n2", endpoint: "http://127.0.0.1:1" }], DIGEST);
      expect(rows[0]).toMatchObject({ name: "n1", state: "ok", dev: false, modelDigestMatches: true });
      expect(rows[1].state).toBe("unreachable");
      expect(await sealMain(["status", "--endpoint", `http://127.0.0.1:${server.port}`], () => {}, () => {})).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});

// ---- Helm and Terraform, as files -------------------------------------------------------------------------------

describe("helm chart", () => {
  const chart = seal("helm/charts/seal");
  const templates = readdirSync(join(chart, "templates")).map((f) => [f, read(join(chart, "templates", f))] as const);
  const values = Bun.YAML.parse(read(join(chart, "values.yaml"))) as Record<string, unknown>;

  test("Chart.yaml, and the default seal values are a valid seal.yaml", () => {
    const meta = Bun.YAML.parse(read(join(chart, "Chart.yaml"))) as Record<string, string>;
    expect(meta).toMatchObject({ apiVersion: "v2", name: "seal", type: "application" });
    const r = validateSeal(values.seal);
    expect(r.errors).toEqual([]);
    expect(read(join(chart, "values.yaml"))).toContain('cc_mode: "on"');
  });

  test("templates render the expected kinds, reference only defined values and balance their blocks", () => {
    const all = templates.map(([, t]) => t).join("\n");
    for (const kind of ["Deployment", "Service", "ConfigMap"]) expect(all).toContain(`kind: ${kind}`);
    const lookup = (path: string[]) => path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), values);
    for (const m of all.matchAll(/\.Values((?:\.[A-Za-z_][A-Za-z0-9_]*)+)/g)) {
      const path = m[1].slice(1).split(".");
      expect(lookup(path) !== undefined || path.join(".") === "seal.model.served_name").toBe(true);
    }
    for (const [name, t] of templates) {
      const opens = [...t.matchAll(/\{\{-?\s*(if|range|with|define)\b/g)].length;
      const ends = [...t.matchAll(/\{\{-?\s*end\s*-?\}\}/g)].length;
      expect(`${name}: ${opens}`).toBe(`${name}: ${ends}`);
      expect(t.split("{{").length).toBe(t.split("}}").length);
    }
    expect(all).toContain('regexMatch "@sha256:[0-9a-f]{64}$"');
    expect(all).not.toMatch(/containerPort: \{\{ \.Values\.engine\.port/);
  });

  test("helm lint and template pass when helm is installed", () => {
    const helm = which("helm");
    if (!helm) return;
    const set = ["--set", `sidecar.image=r.example/sidecar@sha256:${"cd".repeat(32)}`, "--set", `engine.image=r.example/vllm@sha256:${"ef".repeat(32)}`, "--set", `sidecar.routerKeySha256=${HEX}`];
    expect(Bun.spawnSync([helm, "lint", chart, ...set]).exitCode).toBe(0);
    const out = Bun.spawnSync([helm, "template", "t", chart, ...set]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.toString()).toContain("kind: Deployment");
  });
});

describe("terraform modules", () => {
  const modules = ["gcp-confidential", "azure-ncc-h100", "phala"];
  const files = (m: string) => readdirSync(seal(`terraform/${m}`)).filter((f) => f.endsWith(".tf")).map((f) => read(seal(`terraform/${m}/${f}`)));

  test("each module declares every variable it uses and balances its braces", () => {
    for (const m of modules) {
      const src = files(m).join("\n");
      const declared = new Set([...src.matchAll(/^variable "([a-z_]+)"/gm)].map((x) => x[1]));
      for (const u of src.matchAll(/\bvar\.([a-z_]+)/g)) expect(`${m}: ${u[1]} ${declared.has(u[1])}`).toBe(`${m}: ${u[1]} true`);
      expect(src.split("{").length).toBe(src.split("}").length);
      expect(src).toContain('required_version = ">= 1.5"');
    }
  });

  test("GCP is TDX; Azure is SEV-SNP and says it is CPU-attested only; Phala creates nothing", () => {
    const gcp = files("gcp-confidential").join("\n");
    expect(gcp).toContain('confidential_instance_type = "TDX"');
    expect(gcp).toContain("--tee tdx --attestation tdx");
    const azure = files("azure-ncc-h100").join("\n");
    expect(azure).toContain("SEV-SNP hosts are CPU-attested only");
    expect(azure).toContain("--tee sev-snp --cc-mode off --lanes public");
    expect(azure).toContain('security_encryption_type = "VMGuestStateOnly"');
    const phala = files("phala").join("\n");
    expect(phala).not.toMatch(/^resource /m);
    expect(phala).toContain("Placeholder");
    // The modules stage this repository's installer.
    for (const m of ["gcp-confidential", "azure-ncc-h100"]) expect(files(m).join()).toContain('filebase64("${path.module}/../../install.sh")');
    expect(existsSync(seal("terraform/shared/stage-installer.sh.tftpl"))).toBe(true);
  });

  test("terraform fmt passes when terraform is installed", () => {
    const tf = which("terraform");
    if (!tf) return;
    expect(Bun.spawnSync([tf, "fmt", "-check", "-recursive", seal("terraform")]).exitCode).toBe(0);
  });
});

describe("docs", () => {
  test("the host README exists, is linked from the spec status table, and names the limits", () => {
    const readme = read(seal("README.md"));
    expect(read(resolve(root, "spec/README.md"))).toContain("deploy/seal/");
    expect(readme).toContain("Intel TDX");
    expect(readme).toContain("SEV-SNP");
    expect(readme).toContain("get.anyroute.xyz/seal");
    expect(readme).toMatch(/not live/);
    for (const doc of [readme, read(INSTALL), read(seal("seal.schema.json"))]) expect(doc).not.toContain(String.fromCharCode(0x2014));
  });
});
