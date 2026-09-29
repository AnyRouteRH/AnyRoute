import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Flags, UsageError } from "./args.ts";
import { askValid, askYesNo, type Io } from "./io.ts";
import { BUN_IMAGE, DEFAULT_SIDECAR_COMMIT, DEFAULT_SIDECAR_REPO, DEFAULT_SIDECAR_TARBALL_SHA256, LLAMACPP_IMAGE } from "./pins.ts";

// Everything the wizard needs to know, gathered from flags first, then (in a terminal) from questions, then defaults.
// Every value is validated here, before anything is written, because several end up inside a compose file that is
// measured into the attestation.

export const TARGETS = ["phala-cpu", "phala-gpu", "tdx-host"] as const;
export type Target = (typeof TARGETS)[number];
export type Server = "vllm" | "llamacpp";

export type DataPolicy = { training: boolean; retains_prompts: boolean; retention_days?: number; zdr?: boolean };

export type InitSpec = {
  target: Target;
  server: Server;
  /** Reserve NVIDIA GPUs for the model server. */
  gpu: boolean;
  outDir: string;
  providerId: string;
  providerName: string;
  servedName: string;
  /** Absolute path of the weights (a directory, or a single file). */
  weightsPath: string;
  weightsIsFile: boolean;
  /** Where the weights are on the TDX host, when that is not the path they have here. */
  hostWeightsPath?: string;
  exclude: string[];
  /** Where a Phala VM downloads the weights from: a Hugging Face repository at an exact commit. */
  hf?: { repo: string; revision: string };
  modelImage: string;
  /** Names or addresses for the TLS certificate, in addition to the gateway name on Phala. */
  hostnames: string[];
  sidecar: { repo: string; commit: string; sha256?: string; fetchHash: boolean };
  quota: { requestsPerMinute: number; tokensPerMinute: number };
  royaltyRecipient?: string;
  contact?: string;
  datacenters: string[];
  payoutAddress?: string;
  dataPolicy: DataPolicy;
  contextSize: number;
  maxTokens?: number;
  maxModelLen?: number;
  /** The endpoint's public https origin, when it is already known (Phala only assigns it at deploy). */
  url?: string;
  force: boolean;
};

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const SERVED_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const HF_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_PINNED = /^[a-z0-9][a-z0-9._\-/:]*@sha256:[0-9a-f]{64}$/;
const GITHUB_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const HOSTNAME = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const check = {
  providerId: (v: string) => (PROVIDER_ID.test(v) ? null : "use 2 to 41 characters: lowercase letters, digits and -, starting with a letter or digit"),
  servedName: (v: string) => (SERVED_NAME.test(v) ? null : "use letters, digits and . _ : / - (at most 128 characters)"),
  hfRepo: (v: string) => (HF_REPO.test(v) ? null : "expected owner/name, for example Qwen/Qwen2.5-0.5B-Instruct-GGUF"),
  hfRevision: (v: string) => (GIT_SHA.test(v) ? null : "expected a full 40-character commit hash (a branch or tag can move, so it cannot be pinned)"),
  image: (v: string) => (IMAGE_PINNED.test(v) ? null : "expected an image pinned by digest: <name>[:tag]@sha256:<64 hex>"),
  hostname: (v: string) => (HOSTNAME.test(v) || /^\d{1,3}(\.\d{1,3}){3}$/.test(v) ? null : "expected a DNS name or an IPv4 address"),
  address: (v: string) => (ADDRESS.test(v) ? null : "expected a 0x-prefixed 20-byte address"),
  githubRepo: (v: string) => (GITHUB_REPO.test(v) ? null : "expected owner/name"),
  commit: (v: string) => (GIT_SHA.test(v) ? null : "expected a full 40-character commit hash"),
  sha256: (v: string) => (SHA256.test(v) ? null : "expected 64 hex characters"),
};

function must(problem: string | null, flag: string): void {
  if (problem) throw new UsageError(`--${flag}: ${problem}`);
}

/** An https origin (loopback may be plain http, for a router on this machine). Path, query and credentials are dropped. */
export function normalizeOrigin(value: string, what: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new UsageError(`${what} is not a URL: ${value}`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new UsageError(`${what} must be https (plain http only for localhost)`);
  if (u.username || u.password) throw new UsageError(`${what} must not contain credentials`);
  return u.origin;
}

/** The sidecar's origin from whatever the operator pasted: https://host, https://host/v1, https://host/attest. */
export function endpointOrigin(value: string): string {
  return normalizeOrigin(value, "the endpoint URL");
}

function pick<T extends string>(flags: Flags, name: string, allowed: readonly T[]): T | undefined {
  const v = flags.str(name);
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) throw new UsageError(`--${name} must be one of: ${allowed.join(", ")}`);
  return v as T;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 41);

export async function resolveInit(flags: Flags, io: Io): Promise<InitSpec> {
  const ask = io.interactive;
  const need = async (flag: string, question: string, verify: (v: string) => string | null, def?: string): Promise<string> => {
    const given = flags.str(flag);
    if (given !== undefined) {
      must(verify(given), flag);
      return given;
    }
    if (ask) return askValid(io, question, verify, def);
    if (def !== undefined) return def;
    throw new UsageError(`--${flag} is required (or run in a terminal to be asked)`);
  };

  let target = pick(flags, "target", TARGETS);
  if (!target) {
    if (!ask) throw new UsageError(`--target is required: one of ${TARGETS.join(", ")}`);
    io.err("Where will the model run?\n  phala-cpu  a Phala Cloud confidential VM, CPU only (llama.cpp)\n  phala-gpu  a Phala Cloud confidential VM with NVIDIA GPUs (vLLM)\n  tdx-host   your own Intel TDX host or VM (vLLM or llama.cpp)");
    target = (await askValid(io, "target", (v) => ((TARGETS as readonly string[]).includes(v) ? null : `one of ${TARGETS.join(", ")}`), "phala-cpu")) as Target;
  }

  const weightsInput = await need("weights", "path to the model weights (a directory, or one GGUF file)", (v) => (v.trim() ? null : "a path is required"));
  const weightsPath = resolve(weightsInput);
  let weightsIsFile: boolean;
  try {
    weightsIsFile = (await stat(weightsPath)).isFile();
  } catch (e) {
    throw new UsageError(`--weights ${weightsPath} cannot be read: ${(e as Error).message}`);
  }

  const hostWeightsPath = flags.str("host-weights-path");
  if (hostWeightsPath !== undefined) {
    if (target !== "tdx-host") throw new UsageError("--host-weights-path is for tdx-host: a Phala VM downloads its weights");
    if (!hostWeightsPath.startsWith("/") || /[\r\n]/.test(hostWeightsPath)) throw new UsageError("--host-weights-path must be an absolute path on the TDX host");
  }

  const server = pick(flags, "server", ["vllm", "llamacpp"] as const) ?? (target === "phala-cpu" || (target === "tdx-host" && weightsIsFile) ? "llamacpp" : "vllm");
  if (target === "phala-cpu" && server !== "llamacpp") throw new UsageError("phala-cpu runs llama.cpp; use phala-gpu or tdx-host for vLLM");
  if (target === "phala-gpu" && server !== "vllm") throw new UsageError("phala-gpu runs vLLM; llama.cpp here is the CPU build");
  if (server === "llamacpp" && !weightsIsFile) throw new UsageError("llama.cpp serves one GGUF file: point --weights at the file (use vLLM for a directory of safetensors)");
  if (server === "vllm" && weightsIsFile) throw new UsageError("vLLM serves a directory of weights: point --weights at the directory (use llama.cpp for one GGUF file)");

  const servedDefault = basename(weightsPath).replace(/\.gguf$/i, "").replace(/[^A-Za-z0-9._:/-]+/g, "-");
  const servedName = await need("served-name", "model name the endpoint serves", check.servedName, servedDefault || "model");
  const providerId = await need("id", "provider id (the short name the router lists you under)", check.providerId, slug(servedName) || undefined);
  const providerName = flags.str("name") ?? (ask ? await askValid(io, "display name", (v) => (v.length >= 1 && v.length <= 80 ? null : "1 to 80 characters"), providerId) : providerId);
  if (providerName.length < 1 || providerName.length > 80) throw new UsageError("--name must be 1 to 80 characters");

  let hf: InitSpec["hf"];
  if (target !== "tdx-host") {
    const repo = await need("hf-repo", "Hugging Face repository the VM downloads the weights from (owner/name)", check.hfRepo);
    const revision = await need("hf-revision", "the repository commit those weights are from (40 hex)", check.hfRevision);
    hf = { repo, revision };
  }

  let modelImage = flags.str("model-image");
  if (modelImage !== undefined) must(check.image(modelImage), "model-image");
  else if (server === "llamacpp") modelImage = LLAMACPP_IMAGE;
  else modelImage = await need("model-image", "vLLM image, pinned by digest (name@sha256:…)", check.image);

  const hostnames = flags.list("hostname");
  for (const h of hostnames) must(check.hostname(h), "hostname");
  if (target === "tdx-host" && hostnames.length === 0) hostnames.push(await need("hostname", "DNS name or address clients reach this host at (goes in the TLS certificate)", check.hostname));

  const commit = flags.str("sidecar-commit") ?? DEFAULT_SIDECAR_COMMIT;
  must(check.commit(commit), "sidecar-commit");
  const repo = flags.str("sidecar-repo") ?? DEFAULT_SIDECAR_REPO;
  must(check.githubRepo(repo), "sidecar-repo");
  let sha256 = flags.str("sidecar-sha256");
  if (sha256 !== undefined) must(check.sha256(sha256), "sidecar-sha256");
  const fetchHash = flags.bool("fetch-source-hash");
  if (sha256 === undefined && !fetchHash) {
    if (commit === DEFAULT_SIDECAR_COMMIT && repo === DEFAULT_SIDECAR_REPO) sha256 = DEFAULT_SIDECAR_TARBALL_SHA256;
    else throw new UsageError("a sidecar commit other than the default needs --sidecar-sha256 <hash of its tarball>, or --fetch-source-hash to compute it now");
  }

  const rpm = flags.int("requests-per-minute", 1, 100_000) ?? 120;
  const tpm = flags.int("tokens-per-minute", 1000, 1_000_000_000) ?? 120_000;

  const royaltyRecipient = flags.str("royalty-recipient");
  if (royaltyRecipient) must(check.address(royaltyRecipient), "royalty-recipient");
  const payoutAddress = flags.str("payout-address");
  if (payoutAddress) must(check.address(payoutAddress), "payout-address");
  const contact = flags.str("contact") ?? (ask ? (await io.ask("contact for the router operator (email or handle, optional)")) || undefined : undefined);
  if (contact && contact.length > 200) throw new UsageError("--contact is at most 200 characters");
  const datacenters = flags.list("datacenter");
  if (datacenters.length > 20 || datacenters.some((d) => d.length < 1 || d.length > 40)) throw new UsageError("--datacenter: up to 20 values of 1 to 40 characters");

  // The data policy is the operator's own declaration to the router. The defaults declare nothing the operator has not chosen:
  // they say prompts are not used for training and not kept, so an operator who keeps them must say so.
  const retains = flags.has("retains-prompts") ? flags.bool("retains-prompts") : ask ? await askYesNo(io, "Does your deployment keep prompts or responses (logs, caches, disks)?", false) : false;
  const training = flags.bool("training");
  const retentionDays = flags.int("retention-days", 0, 3650);
  if (!retains && retentionDays) throw new UsageError("--retention-days only applies together with --retains-prompts");
  const dataPolicy: DataPolicy = { training, retains_prompts: retains, ...(retains ? { retention_days: retentionDays ?? 30 } : { retention_days: 0 }), ...(flags.bool("zdr") ? { zdr: true } : {}) };
  if (dataPolicy.zdr && (retains || training)) throw new UsageError("--zdr (zero data retention) cannot be declared together with --retains-prompts or --training");

  const url = flags.str("url") ? endpointOrigin(flags.str("url")!) : undefined;

  const contextSize = flags.int("context-size", 256, 10_000_000) ?? 4096;
  const maxTokens = flags.int("max-tokens", 1, 10_000_000);
  const maxModelLen = flags.int("max-model-len", 256, 10_000_000);
  if (server === "vllm" && flags.has("context-size")) throw new UsageError("--context-size is for llama.cpp; use --max-model-len for vLLM");
  if (server === "llamacpp" && (flags.has("max-model-len"))) throw new UsageError("--max-model-len is for vLLM; use --context-size for llama.cpp");

  return {
    target,
    server,
    gpu: target === "phala-gpu" || (server === "vllm" && flags.bool("gpu")),
    outDir: resolve(flags.str("out") ?? "anyroute-provider"),
    providerId,
    providerName,
    servedName,
    weightsPath,
    weightsIsFile,
    hostWeightsPath,
    exclude: flags.list("exclude"),
    hf,
    modelImage: modelImage!,
    hostnames,
    sidecar: { repo, commit, sha256, fetchHash },
    quota: { requestsPerMinute: rpm, tokensPerMinute: tpm },
    royaltyRecipient,
    contact,
    datacenters,
    payoutAddress,
    dataPolicy,
    contextSize,
    maxTokens,
    maxModelLen,
    url,
    force: flags.bool("force"),
  };
}

export const RUNTIME_IMAGE = BUN_IMAGE;
