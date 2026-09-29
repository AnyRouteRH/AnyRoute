#!/usr/bin/env bun
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hashModelPath } from "./digest.ts";
import { Flags, UsageError, parseFlags, type FlagSpec } from "./onboard/args.ts";
import { buildApplication, masked, saveApplication, submitApplication, type Application } from "./onboard/apply.ts";
import { formatReport, runDoctor } from "./onboard/doctor.ts";
import { runInit } from "./onboard/init.ts";
import { askYesNo, terminalIo, type Io } from "./onboard/io.ts";
import { normalizeOrigin, resolveInit } from "./onboard/spec.ts";
import { FILES, readManifest, type Manifest } from "./onboard/state.ts";
import { SidecarError } from "./util.ts";
import { SIDECAR_VERSION } from "./version.ts";

// Onboarding for a model host: measure the weights, write the sidecar configuration and a pinned deployment for the
// platform you run on, make the router key, file the provider application, and check a running sidecar.
//
//   bun sidecar/src/cli.ts init      (interactive, or all flags)
//   bun sidecar/src/cli.ts apply     print / submit the provider application once the endpoint's address is known
//   bun sidecar/src/cli.ts doctor    check a running sidecar
//   bun sidecar/src/cli.ts digest    print the model digest of a weights directory

const USAGE = `anyroute provider onboarding ${SIDECAR_VERSION}

usage:
  cli.ts init [options]      measure the weights and write sidecar.yaml, a compose file, and a router key
  cli.ts apply [options]     print the provider application (and, with --submit, file it with a router)
  cli.ts doctor [options]    check a running sidecar: /healthz, /attest, digests, certificate, key and receipt
  cli.ts digest <path> [--exclude glob]...

init (asks for anything you leave out when run in a terminal; --yes never asks):
  --target phala-cpu|phala-gpu|tdx-host     where the model runs
  --weights <path>                          the weights: a directory, or one GGUF file
  --exclude <glob>                          leave matching files out of the digest (repeatable)
  --served-name <name>  --id <provider id>  --name <display name>  --out <dir> (default ./anyroute-provider)
  --hf-repo <owner/name> --hf-revision <40 hex>   Phala: where the VM downloads the weights (each file's sha256 is checked)
  --server vllm|llamacpp  --model-image <name@sha256:...>   the model server (llama.cpp's image is pinned for you; vLLM's is yours)
  --hostname <name>                         TLS names; required on tdx-host (repeatable)
  --host-weights-path <abs path>            tdx-host: where the weights are on the host, if not the path they have here
  --sidecar-commit <40 hex> --sidecar-sha256 <hash> | --fetch-source-hash   the public commit the sidecar runs from
  --requests-per-minute <n> --tokens-per-minute <n>   the router key's quota
  --contact <text> --datacenter <code> --payout-address <0x..> --royalty-recipient <0x..>
  --retains-prompts --training --retention-days <n> --zdr   your data policy, as you declare it to the router
  --url <https://endpoint> --router <https://router> --submit --include-key   then file the application
  --force                                   replace files init wrote before (the router key is always kept)

apply:  --dir <dir> --url <https://endpoint> [--router <https://router> --submit] [--include-key] [--print-secrets]
doctor: --url <https://endpoint> [--dir <dir>] [--key-file <file>] [--weights <path>] [--router <url> --id <provider id>]
        [--model <name>] [--no-chat] [--compose-hash <hash>] [--allow-simulated] [--json]
`;

const INIT_FLAGS: FlagSpec = {
  target: "string", weights: "string", exclude: "list", "served-name": "string", id: "string", name: "string", out: "string",
  "hf-repo": "string", "hf-revision": "string", server: "string", "model-image": "string", hostname: "list",
  "sidecar-commit": "string", "sidecar-sha256": "string", "sidecar-repo": "string", "fetch-source-hash": "boolean",
  "requests-per-minute": "string", "tokens-per-minute": "string", "royalty-recipient": "string", "payout-address": "string",
  contact: "string", datacenter: "list", "retains-prompts": "boolean", training: "boolean", "retention-days": "string", zdr: "boolean",
  url: "string", "host-weights-path": "string", "context-size": "string", "max-tokens": "string", "max-model-len": "string", gpu: "boolean", force: "boolean", yes: "boolean",
  router: "string", submit: "boolean", "include-key": "boolean", "print-secrets": "boolean", json: "boolean",
};
const APPLY_FLAGS: FlagSpec = { dir: "string", url: "string", router: "string", submit: "boolean", "include-key": "boolean", "print-secrets": "boolean", yes: "boolean", json: "boolean" };
const DOCTOR_FLAGS: FlagSpec = { url: "string", dir: "string", "key-file": "string", weights: "string", router: "string", id: "string", model: "string", "no-chat": "boolean", "compose-hash": "string", "allow-simulated": "boolean", json: "boolean", exclude: "list" };

export type Streams = { io: Io; fetchImpl?: typeof fetch };

/** File the application the manifest describes. Shared by `init --url` and `apply`. */
async function applyStep(io: Io, dir: string, m: Manifest, flags: Flags, url: string, fetchImpl?: typeof fetch): Promise<void> {
  const includeKey = flags.bool("include-key");
  const application: Application = buildApplication(m, { url, includeKey, keyPath: join(dir, FILES.key) });
  const path = saveApplication(dir, application);
  const router = flags.str("router") ? normalizeOrigin(flags.str("router")!, "the router URL") : undefined;
  io.out(`Provider application${router ? ` for POST ${router}/api/v1/providers/apply` : " for POST /api/v1/providers/apply"}:`);
  io.out(JSON.stringify(flags.bool("print-secrets") ? application : masked(application), null, 2));
  io.err(`Saved to ${path}${application.api_key ? " (mode 0600; it holds the router key)" : ""}.`);
  if (!includeKey) io.err(`The router key is not in the application. Give ${join(dir, FILES.key)} to the router's operator when they approve it, over a private channel.`);

  let submit = flags.bool("submit");
  if (!submit && router && io.interactive) submit = await askYesNo(io, `Submit this application to ${router} now?`, false);
  if (!submit) {
    io.err(router ? "Not submitted. Run apply again with --submit to file it." : "Not submitted. To file it: --router <https://router> --submit, or POST the JSON above to a router.");
    return;
  }
  if (!router) throw new UsageError("--submit needs --router <https://router>");
  if (includeKey && new URL(router).protocol !== "https:") throw new UsageError("--include-key sends the router key: the router URL must be https");
  const res = await submitApplication(router, application, fetchImpl);
  io.err(`Submitted: ${res.id} is ${res.status}. An operator reviews it before anything is routed.`);
  if (res.application_token) {
    const tokenPath = join(dir, FILES.applicationToken);
    writeFileSync(tokenPath, res.application_token + "\n", { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    io.err(`Your application token is saved to ${tokenPath}. You need it to revise a pending application (x-application-token header). Keep it private.`);
  }
  for (const n of res.next ?? []) io.err(n);
}

export async function cmdInit(argv: string[], s: Streams): Promise<number> {
  const flags = new Flags(parseFlags(argv, INIT_FLAGS));
  const io = s.io;
  const spec = await resolveInit(flags, io);
  const result = await runInit(spec, { io, fetchImpl: s.fetchImpl, logger: (_l, _m, f) => io.err(`  hashed ${String(f?.path)}`) });
  const m = result.manifest;
  io.err("");
  io.err(`Wrote ${result.files.map((f) => join(result.dir, f)).join(", ")}`);
  io.err(result.keyCreated ? `Made the router key: ${result.keyPath} (mode 0600). Only its SHA-256 is in sidecar.yaml.` : `Kept the router key already at ${result.keyPath}.`);
  io.out(`model digest ${result.modelDigest}`);
  io.err("");
  const phala = spec.target !== "tdx-host";
  io.err("Next:");
  io.err(`  1. Read ${join(result.dir, FILES.compose)}. Every image, the weights and the sidecar source are pinned in it.`);
  if (phala) {
    io.err(`  2. Deploy:  npx -y phala deploy -n ${spec.providerId} -c ${join(result.dir, FILES.compose)} -t ${spec.target === "phala-cpu" ? "tdx.medium --disk-size 20G" : "<a GPU instance type> --disk-size <enough for the weights>"} --wait`);
    io.err("  3. The endpoint is https://<app_id>-8443s.<gateway domain> (the \"s\" is TLS passthrough). `phala ps` shows the app id.");
  } else {
    io.err(`  2. On the TDX host, in ${result.dir}:  docker compose -f docker-compose.yml up -d   (the sidecar hashes ./docker-compose.yml)`);
    io.err(`  3. The endpoint is https://${spec.hostnames[0]}:8443`);
  }
  const cli = "bun sidecar/src/cli.ts";
  io.err(`  4. Check it:  ${cli} doctor --dir ${result.dir} --url <endpoint> --key-file ${join(result.dir, FILES.key)}`);
  io.err(`  5. File it:   ${cli} apply --dir ${result.dir} --url <endpoint> --router <router> --submit`);
  io.err("");
  io.err(`The TEE this attests is the Intel TDX confidential VM. ${spec.target === "phala-gpu" ? "The sidecar does not collect NVIDIA confidential-computing evidence, so the GPU's state is not covered by /attest." : ""}`.trim());
  if (m.endpoint) {
    io.err("");
    await applyStep(io, result.dir, m, flags, m.endpoint, s.fetchImpl);
  } else if (flags.bool("submit") || flags.has("router")) {
    io.err("--submit / --router need the endpoint's address (--url). Run `apply` once it is deployed.");
  }
  if (flags.bool("json")) io.out(JSON.stringify({ dir: result.dir, model_digest: result.modelDigest, files: result.files, router_key: result.keyPath }));
  return 0;
}

export async function cmdApply(argv: string[], s: Streams): Promise<number> {
  const flags = new Flags(parseFlags(argv, APPLY_FLAGS));
  const dir = resolve(flags.str("dir") ?? "anyroute-provider");
  const m = readManifest(dir);
  const url = flags.str("url") ?? m.endpoint;
  if (!url) throw new UsageError("--url <https://endpoint> is required: the sidecar's public address");
  await applyStep(s.io, dir, m, flags, url, s.fetchImpl);
  return 0;
}

export async function cmdDoctor(argv: string[], s: Streams): Promise<number> {
  const flags = new Flags(parseFlags(argv, DOCTOR_FLAGS));
  const io = s.io;
  const dir = resolve(flags.str("dir") ?? "anyroute-provider");
  const haveDir = existsSync(join(dir, FILES.manifest));
  const m = haveDir ? readManifest(dir) : undefined;
  const url = flags.str("url") ?? m?.endpoint;
  if (!url) throw new UsageError("--url <https://endpoint> is required");

  let key: string | undefined;
  const keyFile = flags.str("key-file") ?? (haveDir && existsSync(join(dir, FILES.key)) ? join(dir, FILES.key) : undefined);
  if (keyFile) {
    if (!existsSync(keyFile)) throw new UsageError(`${keyFile} not found`);
    key = readFileSync(keyFile, "utf8").trim();
  }

  // Which weights the served digest is compared with: weights hashed now, or the digest init recorded.
  let modelDigest = m?.model.digest;
  let source = "the weights init hashed";
  const weights = flags.str("weights");
  if (weights) {
    io.err(`Hashing ${weights} ...`);
    modelDigest = (await hashModelPath(weights, { exclude: flags.list("exclude").length ? flags.list("exclude") : m?.model.exclude })).digest;
    source = "the weights hashed just now";
  }
  let allowlist: string[] | undefined;
  if (haveDir && existsSync(join(dir, FILES.yaml))) {
    const cfg = Bun.YAML.parse(readFileSync(join(dir, FILES.yaml), "utf8")) as { allowlist?: { model_digests?: string[] } };
    allowlist = cfg.allowlist?.model_digests;
  }
  const routerUrl = flags.str("router");
  const providerId = flags.str("id") ?? m?.provider.id;
  if (routerUrl && !providerId) throw new UsageError("--router needs the provider id: --id <provider id>");

  const report = await runDoctor({
    url,
    key,
    expected: { modelDigest, modelDigestSource: source, imageDigest: m ? m.sidecar.runtime_image_digest : undefined, composeHash: flags.str("compose-hash") },
    allowlist,
    keySha256: m?.router_key_sha256,
    model: flags.str("model") ?? m?.model.served_name,
    chat: !flags.bool("no-chat"),
    router: routerUrl ? { url: normalizeOrigin(routerUrl, "the router URL"), providerId: providerId! } : undefined,
    allowSimulated: flags.bool("allow-simulated"),
    fetchImpl: s.fetchImpl,
  });
  io.out(flags.bool("json") ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.ok ? 0 : 1;
}

async function cmdDigest(argv: string[], s: Streams): Promise<number> {
  const path = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--exclude");
  if (!path) throw new UsageError("usage: cli.ts digest <path> [--exclude glob]...");
  const exclude = argv.flatMap((a, i) => (a === "--exclude" && argv[i + 1] ? [argv[i + 1]] : []));
  if (!existsSync(path)) throw new UsageError(`${path} does not exist`);
  const h = await hashModelPath(path, { exclude });
  s.io.out(h.digest);
  return 0;
}

export async function main(argv: string[], s?: Streams): Promise<number> {
  const [cmd, ...rest] = argv;
  const io = s?.io ?? terminalIo({ yes: rest.includes("--yes") });
  const streams: Streams = s ?? { io };
  try {
    switch (cmd) {
      case "init":
        return await cmdInit(rest, streams);
      case "apply":
        return await cmdApply(rest, streams);
      case "doctor":
        return await cmdDoctor(rest, streams);
      case "digest":
        return await cmdDigest(rest, streams);
      case "version":
      case "--version":
        io.out(SIDECAR_VERSION);
        return 0;
      case undefined:
      case "help":
      case "--help":
        io.out(USAGE);
        return cmd === undefined ? 2 : 0;
      default:
        io.err(`unknown command "${cmd}"\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}`);
      return 2;
    }
    if (e instanceof SidecarError) {
      io.err(`error [${e.code}]: ${e.message}`);
      return 1;
    }
    io.err(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return 1;
  } finally {
    io.close?.();
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
