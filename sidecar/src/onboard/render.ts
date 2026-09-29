import { basename } from "node:path";
import type { ManifestEntry } from "../digest.ts";
import { SIDECAR_VERSION } from "../version.ts";
import { BUN_IMAGE, BUN_IMAGE_DIGEST, GATEWAY_HOSTNAME, SIDECAR_PORT } from "./pins.ts";
import type { InitSpec } from "./spec.ts";

// Text of sidecar.yaml and of the compose file. Both are plain templates: the same inputs give the same bytes, and
// nothing in them depends on the machine that produced them (no clock, no host name, no user name).
// The layout follows sidecar/examples/phala. Every value a person supplied is JSON-quoted (valid YAML) and, in the
// compose file, has `$` doubled so that compose leaves it alone.

export const MODELS_ROOT = "/models";
export const MODEL_DIR = "/models/model";
const q = (v: string) => JSON.stringify(v);
/** A value inside the compose file: quoted, with `$` doubled so compose does not interpolate it. */
const cq = (v: string) => JSON.stringify(v).replace(/\$/g, () => "$$");
const lines = (...l: (string | false | undefined | null)[]) => l.filter((x): x is string => typeof x === "string").join("\n");
const indent = (text: string, n: number) => text.split("\n").map((l) => (l ? " ".repeat(n) + l : l)).join("\n");

/** Where the sidecar and the model server see the weights. A directory keeps its layout; a single file keeps its name. */
export function modelPaths(spec: Pick<InitSpec, "weightsPath" | "weightsIsFile">) {
  return spec.weightsIsFile ? { path: `${MODELS_ROOT}/${basename(spec.weightsPath)}`, root: MODELS_ROOT } : { path: MODEL_DIR, root: MODEL_DIR };
}

export function scaleQuota(rpm: number, tpm: number) {
  const r = (n: number) => Math.max(1, Math.round(n));
  return {
    key: { requests_per_minute: rpm, burst: r(rpm / 4), tokens_per_minute: tpm, token_burst: tpm },
    default: { requests_per_minute: r(rpm / 4), burst: r(rpm / 12) },
    global: { requests_per_minute: r(rpm * 1.25), burst: r(rpm / 3), tokens_per_minute: r(tpm * 1.25), token_burst: r(tpm * 1.25) },
  };
}

const upstream = (spec: InitSpec) => (spec.server === "vllm" ? { service: "vllm", url: "http://vllm:8000" } : { service: "llama", url: "http://llama:8080" });

export type RenderInput = { spec: InitSpec; modelDigest: string; keyHash: string; manifest: ManifestEntry[]; tarballSha256: string };

export function renderSidecarYaml(i: RenderInput): string {
  const { spec } = i;
  const phala = spec.target !== "tdx-host";
  const quota = scaleQuota(spec.quota.requestsPerMinute, spec.quota.tokensPerMinute);
  const mp = modelPaths(spec);
  const names = [...(phala ? [GATEWAY_HOSTNAME] : []), ...spec.hostnames];
  const bucket = (b: Record<string, number>, pad: string) => Object.entries(b).map(([k, v]) => `${pad}${k}: ${v}`).join("\n");
  return (
    lines(
      `# sidecar.yaml for provider ${spec.providerId}, written by \`bun sidecar/src/cli.ts init\` (sidecar ${SIDECAR_VERSION}).`,
      phala
        ? "# The compose file carries a verbatim copy of this file in the sidecar's SIDECAR_CONFIG_YAML variable, because a Phala CVM"
        : "# The compose file carries a verbatim copy of this file in the sidecar's SIDECAR_CONFIG_YAML variable, so the file that is",
      phala
        ? "# receives the compose file and nothing else. Keep the two identical: edit this file, then run `init` again with --force."
        : "# measured and hashed is the whole deployment. Keep the two identical: edit this file, then run `init` again with --force.",
      phala ? "# ${DSTACK_APP_ID} and ${DSTACK_GATEWAY_DOMAIN} are filled in by the platform when it interpolates the compose file." : undefined,
      "",
      "server:",
      "  host: 0.0.0.0",
      `  port: ${SIDECAR_PORT}`,
      "  tls: self_signed",
      phala ? "  # The TLS-passthrough name the Phala gateway routes to this port, so a client that pins the certificate can also check it." : "  # The names clients reach this host at; they go in the certificate next to the attestation name.",
      `  hostnames: [${names.map(q).join(", ")}]`,
      "  cert_validity_days: 30",
      "",
      "upstream:",
      `  base_url: ${upstream(spec).url}`,
      "  # Other limits (timeouts, body sizes) use the sidecar's defaults; sidecar.example.yaml lists them.",
      "",
      "model:",
      spec.weightsIsFile ? "  # The file the model server loads, mounted read-only. It is hashed at boot." : "  # The directory the model server loads, mounted read-only. It is hashed at boot.",
      `  path: ${q(mp.path)}`,
      `  served_name: ${q(spec.servedName)}`,
      spec.exclude.length ? `  exclude: [${spec.exclude.map(q).join(", ")}]` : undefined,
      "",
      "allowlist:",
      `  # bun sidecar/src/cli.ts digest <your weights>${spec.exclude.map((e) => ` --exclude ${cliArg(e)}`).join("")}`,
      `  model_digests: [${q(i.modelDigest)}]`,
      "",
      "# The image the sidecar process runs in (pinned by the same digest in the compose file). The sidecar source is not part of an",
      "# image here: it is a public commit's tarball, pinned by its sha256 in the compose file, so the compose hash covers it.",
      `image_digest: ${q(BUN_IMAGE_DIGEST)}`,
      "",
      "attestation:",
      phala ? "  provider: dstack" : "  provider: tdx",
      phala ? "  dstack:" : "  tdx:",
      phala ? "    endpoint: /var/run/dstack.sock" : "    tsm_path: /sys/kernel/config/tsm/report",
      "  fresh_quotes_per_minute: 10",
      "",
      ...(phala ? [] : ["compose:", "  # Nothing on a plain TDX host reports the compose hash, so the sidecar hashes the compose file mounted into it.", "  file: /etc/sidecar/docker-compose.yml", ""]),
      "# One key, for the router that sends this provider its traffic. Only its SHA-256 is here; the key itself is in router-api-key",
      "# next to this file and goes to the router operator, never into a repository or a compose file.",
      "auth:",
      "  keys:",
      "    - id: router",
      `      sha256: ${q(i.keyHash)}`,
      "      quota:",
      bucket(quota.key, "        "),
      "",
      "quota:",
      "  default:",
      bucket(quota.default, "    "),
      "  global:",
      bucket(quota.global, "    "),
      ...(spec.royaltyRecipient ? ["", "royalty:", "  # Published in /.well-known/anyroute-sidecar.json. It does not change what the sidecar does.", `  recipient: ${q(spec.royaltyRecipient)}`] : []),
      "",
      "receipts:",
      "  queue_capacity: 10000",
    ) + "\n"
  );
}

function cliArg(v: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

function modelServer(spec: InitSpec): string {
  const mp = modelPaths(spec);
  const dependsOnFetch = spec.target === "tdx-host" ? undefined : "    depends_on:\n      model-fetch:\n        condition: service_completed_successfully";
  const gpu = spec.gpu
    ? lines("    deploy:", "      resources:", "        reservations:", "          devices:", "            - driver: nvidia", "              count: all", "              capabilities: [gpu]")
    : undefined;
  if (spec.server === "vllm") {
    const args = ["--model", mp.path, "--served-model-name", spec.servedName, "--host", "0.0.0.0", "--port", "8000", ...(spec.maxModelLen ? ["--max-model-len", String(spec.maxModelLen)] : [])];
    return lines(
      "  vllm:",
      `    image: ${spec.modelImage}`,
      dependsOnFetch,
      `    command: [${args.map(cq).join(", ")}]`,
      "    environment:",
      '      HF_HUB_OFFLINE: "1"',
      "    volumes:",
      `      - ${modelMount(spec, "ro")}`,
      "    networks: [backend]",
      gpu,
      "    restart: unless-stopped",
    );
  }
  const args = ["-m", mp.path, "--alias", spec.servedName, "--host", "0.0.0.0", "--port", "8080", "-c", String(spec.contextSize), ...(spec.maxTokens ? ["-n", String(spec.maxTokens)] : [])];
  return lines(
    "  llama:",
    `    image: ${spec.modelImage}`,
    dependsOnFetch,
    `    command: [${args.map(cq).join(", ")}]`,
    "    volumes:",
    `      - ${modelMount(spec, "ro")}`,
    "    networks: [backend]",
    gpu,
    "    restart: unless-stopped",
  );
}

/** A volume line: the named volume on Phala, the host path on a TDX host. */
function modelMount(spec: InitSpec, mode: "ro" | "rw"): string {
  const mp = modelPaths(spec);
  if (spec.target !== "tdx-host") return `models:${MODELS_ROOT}:${mode}`;
  return cq(`${spec.hostWeightsPath ?? spec.weightsPath}:${mp.path}:${mode}`);
}

function modelFetch(i: RenderInput): string {
  const { spec } = i;
  const mp = modelPaths(spec);
  const hf = spec.hf!;
  const manifest = i.manifest.map((m) => `${m.sha256} ${m.path}`).join("\n");
  const script = lines(
    `base=https://huggingface.co/${hf.repo}/resolve/${hf.revision}`,
    `dest=${mp.root}`,
    "while read -r sum path; do",
    '  f="$$dest/$$path"',
    '  if [ -f "$$f" ] && echo "$$sum  $$f" | sha256sum -c --status -; then continue; fi',
    '  mkdir -p "$$(dirname "$$f")"',
    '  rm -f "$$f" "$$f.part"',
    '  SRC="$$base/$$path" OUT="$$f.part" bun -e "const r = await fetch(process.env.SRC); if (!r.ok) throw new Error(\'download failed: HTTP \' + r.status); await Bun.write(process.env.OUT, r);" </dev/null',
    '  echo "$$sum  $$f.part" | sha256sum -c -',
    '  mv "$$f.part" "$$f"',
    "done <<'MANIFEST'",
    manifest,
    "MANIFEST",
    'echo "weights present, every sha256 ok"',
  );
  return lines(
    "  model-fetch:",
    `    image: ${BUN_IMAGE}`,
    '    entrypoint: ["/bin/sh", "-euc"]',
    "    command:",
    "      - |",
    indent(script, 8),
    "    volumes:",
    `      - ${modelMount(spec, "rw")}`,
    "    networks: [egress]",
    '    restart: "no"',
  );
}

function sidecarService(i: RenderInput, yaml: string): string {
  const { spec } = i;
  const phala = spec.target !== "tdx-host";
  const repoName = spec.sidecar.repo.split("/")[1];
  const server = upstream(spec).service;
  const script = lines(
    `rev=${spec.sidecar.commit}`,
    `sum=${i.tarballSha256}`,
    'mkdir -p /opt/anyroute "$$(dirname "$$SIDECAR_CONFIG")"',
    "cd /opt/anyroute",
    `bun -e "const r = await fetch('https://codeload.github.com/${spec.sidecar.repo}/tar.gz/$$rev'); if (!r.ok) throw new Error('source download failed: HTTP ' + r.status); await Bun.write('src.tar.gz', r);"`,
    'echo "$$sum  src.tar.gz" | sha256sum -c -',
    "rm -rf sidecar",
    `tar -xzf src.tar.gz --strip-components=1 "${repoName}-$$rev/sidecar"`,
    "cd sidecar",
    "bun install --frozen-lockfile --production --ignore-scripts",
    `printf '%s' "$$SIDECAR_CONFIG_YAML" > "$$SIDECAR_CONFIG"`,
    'exec bun src/main.ts serve --config "$$SIDECAR_CONFIG"',
  );
  return lines(
    "  sidecar:",
    `    image: ${BUN_IMAGE}`,
    "    depends_on:",
    phala ? "      model-fetch:\n        condition: service_completed_successfully" : undefined,
    `      ${server}:`,
    "        condition: service_started",
    phala ? "    # root, to open the dstack guest agent socket." : "    # root, to open the kernel's configfs-tsm quote interface.",
    "    user: root",
    '    entrypoint: ["/bin/sh", "-euc"]',
    "    command:",
    "      - |",
    indent(script, 8),
    "    environment:",
    "      NODE_ENV: production",
    "      SIDECAR_CONFIG: /run/sidecar/sidecar.yaml",
    "      # A verbatim copy of sidecar.yaml.",
    "      SIDECAR_CONFIG_YAML: |",
    indent(yaml.replace(/\n$/, ""), 8),
    "    volumes:",
    `      - ${modelMount(spec, "ro")}`,
    phala ? "      # dstack guest agent (attestation.provider: dstack)" : "      # configfs-tsm quote interface (attestation.provider: tdx)",
    phala ? "      - /var/run/dstack.sock:/var/run/dstack.sock" : "      - /sys/kernel/config:/sys/kernel/config",
    phala ? undefined : "      # This very file, so the sidecar can bind its hash (compose.file in sidecar.yaml).",
    phala ? undefined : "      - ./docker-compose.yml:/etc/sidecar/docker-compose.yml:ro",
    "    ports:",
    `      - "${SIDECAR_PORT}:${SIDECAR_PORT}"`,
    "    networks: [backend, egress]",
    "    healthcheck:",
    '      test: ["CMD", "bun", "/opt/anyroute/sidecar/src/main.ts", "healthcheck"]',
    "      interval: 30s",
    "      timeout: 10s",
    "      start_period: 600s",
    "      retries: 3",
    "    restart: unless-stopped",
  );
}

const TARGET_TITLE = { "phala-cpu": "a Phala Cloud (dstack) Intel TDX confidential VM, CPU", "phala-gpu": "a Phala Cloud (dstack) Intel TDX confidential VM with NVIDIA GPUs", "tdx-host": "an Intel TDX host or VM" } as const;

export function renderCompose(i: RenderInput, sidecarYaml: string): string {
  const { spec } = i;
  const phala = spec.target !== "tdx-host";
  const weights = phala
    ? `#   model-fetch  downloads ${i.manifest.length} file${i.manifest.length === 1 ? "" : "s"} from ${spec.hf!.repo} at commit ${spec.hf!.revision}, checks each file's sha256, then exits`
    : `#   (no download)  the weights are mounted read-only from ${(spec.hostWeightsPath ?? spec.weightsPath).replace(/\$/g, "$$$$")}`;
  const head = lines(
    `# AnyRoute sidecar in front of ${spec.server === "vllm" ? "vLLM" : "llama.cpp"} on ${TARGET_TITLE[spec.target]}, for provider ${spec.providerId}.`,
    "# Written by `bun sidecar/src/cli.ts init`; the same inputs (including the router key's hash) give the same file.",
    "#",
    weights,
    `#   ${upstream(spec).service.padEnd(12)} ${spec.server === "vllm" ? "vLLM's" : "llama.cpp's"} OpenAI-compatible server, on an internal network with no route out`,
    `#   sidecar      the sidecar from public commit ${spec.sidecar.commit.slice(0, 12)} of ${spec.sidecar.repo} (tarball sha256 ${i.tarballSha256.slice(0, 12)}…):`,
    "#                hashes the weights, attests, serves TLS on 8443 with a certificate bound to the quote, signs every response",
    "#",
    `# Everything that runs is pinned in this file: images by digest, the weights by ${phala ? "revision and per-file sha256" : "the digest in sidecar.yaml"},`,
    "# the sidecar source by commit and tarball sha256, its dependencies by the committed bun.lock.",
    phala
      ? "# No secrets and no operator-supplied variables: the only ${...} references are DSTACK_APP_ID and DSTACK_GATEWAY_DOMAIN, which the\n# platform sets. Shell variables below are written $$name so that compose leaves them to the shell."
      : "# No secrets and no variables. Shell variables below are written $$name so that compose leaves them to the shell.",
    "#",
    phala
      ? `# Deploy:  phala deploy -n <name> -c docker-compose.yml -t ${spec.target === "phala-cpu" ? "tdx.medium" : "<a GPU instance type>"} --disk-size <enough for the weights> --wait\n# Reach:   https://<app_id>-8443s.<gateway domain>   (the "s" suffix is TLS passthrough: the client terminates TLS with the sidecar)`
      : "# Deploy:  docker compose -f docker-compose.yml up -d     (run it from this directory: the sidecar hashes ./docker-compose.yml)\n# Reach:   https://<the hostname in sidecar.yaml>:8443",
  );
  const services = [phala ? modelFetch(i) : undefined, modelServer(spec), sidecarService(i, sidecarYaml)].filter((s): s is string => !!s).join("\n\n");
  const tail = lines(
    "",
    "networks:",
    "  # No route out: the model server is reachable only from the sidecar.",
    "  backend:",
    "    internal: true",
    phala ? "  # Downloads at start (weights, sidecar source and its one dependency) and the published port." : "  # Downloads at start (the sidecar source and its one dependency) and the published port.",
    "  egress: {}",
    phala ? "" : undefined,
    phala ? "volumes:" : undefined,
    phala ? "  models: {}" : undefined,
  );
  return `${head}\n\nservices:\n${services}\n${tail}\n`;
}
