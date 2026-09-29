#!/usr/bin/env bun
// seal: the SEAL host command line. Writes and checks seal.yaml, keeps its list of serving nodes, and checks a running
// sidecar's evidence with the same client checks the SDK uses (packages/client). It publishes nothing and spends
// nothing; the only network calls are to the endpoints and router you name.
//
//   bun scripts/seal-cli.ts init --hf-repo org/model --weights-sha256 sha256:... --price-in 0.2 --price-out 0.9 \
//       --region eu-west --tee tdx
//   bun scripts/seal-cli.ts add-node --name n1 --endpoint https://n1.example:8443
//   bun scripts/seal-cli.ts verify https://n1.example:8443 [--router https://<router> --id <provider id>]
//   bun scripts/seal-cli.ts status
//   bun scripts/seal-cli.ts validate seal.yaml

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { SCHEMA_PATH, parseSealText, validateSeal, type SealConfig } from "../deploy/seal/validate.ts";
import { Flags, UsageError, parseFlags, type FlagSpec } from "../sidecar/src/onboard/args.ts";
import { defaultAttestFetcher, evaluateAttestation, fetchRouterAttestation, type AttestDocument, type AttestFetcher, type RouterAttestation } from "../packages/client/src/attestation.ts";
import { nodeAttestFetcher } from "../packages/client/src/node.ts";
import type { Check } from "../packages/client/src/types.ts";

export const SEAL_CLI_VERSION = "0.1.0";

export const USAGE = `seal ${SEAL_CLI_VERSION}: SEAL host tools

usage:
  seal init [options]            write seal.yaml (checked against deploy/seal/seal.schema.json)
  seal add-node --name <n> --endpoint <https://host:port> [--region <code>] [--config seal.yaml]
  seal verify <endpoint> [--config seal.yaml] [--router <url> --id <provider id>] [--allow-simulated] [--no-fresh] [--json]
  seal status [--config seal.yaml] [--endpoint <url>]... [--json]
  seal validate [<seal.yaml>]

init:
  --hf-repo <owner/name> --weights-sha256 <sha256:hex> --price-in <usdg> --price-out <usdg> --region <code>
  --tee tdx|sev-snp|none (required: seal never guesses what hardware you have)
  --engine vllm|sglang|llamacpp|ollama (default vllm)   --engine-url <url> (default http://127.0.0.1:8000)
  --model <served name> --tokenizer-sha256 <sha256:hex> --quant <fmt> (default bf16)
  --creator-handle <h> --royalty-bps <n> --lanes <list> --policy <id> --kms <id> --host-id <0x..>
  --cc-mode on|off (default off) --multi-gpu single|nvle|ppcie (default single)
  --out <file> (default seal.yaml) --force (replace it; host_id and nodes are kept)

For a whole host (engine detection, sidecar.yaml, compose file, router key) use deploy/seal/install.sh.
`;

const SPECS: Record<string, FlagSpec> = {
  init: {
    out: "string", force: "boolean", model: "string", "hf-repo": "string", "weights-sha256": "string", "tokenizer-sha256": "string",
    quant: "string", "creator-handle": "string", "royalty-bps": "string", lanes: "string", "price-in": "string", "price-out": "string",
    region: "string", policy: "string", kms: "string", "host-id": "string", engine: "string", "engine-url": "string", tee: "string",
    "cc-mode": "string", "multi-gpu": "string",
  },
  "add-node": { config: "string", name: "string", endpoint: "string", region: "string" },
  verify: { config: "string", router: "string", id: "string", "allow-simulated": "boolean", "no-fresh": "boolean", json: "boolean", "timeout-ms": "string" },
  status: { config: "string", endpoint: "list", json: "boolean", "timeout-ms": "string" },
  validate: {},
};

export type Command = keyof typeof SPECS | "help" | "version";
export type ParsedCli = { command: Command; flags: Flags };

export function parseCli(argv: string[]): ParsedCli {
  const [first, ...rest] = argv;
  if (first === undefined || first === "help" || first === "-h" || first === "--help") return { command: "help", flags: new Flags(parseFlags([], {})) };
  if (first === "version" || first === "--version") return { command: "version", flags: new Flags(parseFlags([], {})) };
  const spec = SPECS[first];
  if (!spec) throw new UsageError(`unknown command "${first}" (init, add-node, verify, status, validate)`);
  const flags = new Flags(parseFlags(rest, spec));
  const max = first === "verify" || first === "validate" ? 1 : 0;
  if (flags.positional.length > max) throw new UsageError(`unexpected argument "${flags.positional[max]}"`);
  if (first === "verify" && flags.positional.length !== 1) throw new UsageError("verify needs an endpoint, e.g. seal verify https://host:8443");
  if (flags.has("router") !== flags.has("id")) throw new UsageError("--router and --id go together");
  return { command: first as Command, flags };
}

// ---- seal.yaml ------------------------------------------------------------------------------------------------------

const q = (s: string) => JSON.stringify(s);

/** The same layout install.sh writes: every string quoted, cc_mode quoted so YAML 1.1 readers keep it a string. */
export function renderSealYaml(c: SealConfig, writer = `seal ${SEAL_CLI_VERSION}`): string {
  const l: string[] = [
    `# seal.yaml, written by ${writer}. Schema: seal.schema.json (version 1).`,
    "# Comments are not kept when seal rewrites this file.",
    "version: 1",
  ];
  if (c.host_id) l.push(`host_id: ${q(c.host_id)}`);
  l.push(`engine: ${c.engine}`, `engine_url: ${q(c.engine_url)}`, "model:");
  const m = c.model;
  if (m.served_name) l.push(`  served_name: ${q(m.served_name)}`);
  l.push(`  hf_repo: ${q(m.hf_repo)}`, `  weights_sha256: ${q(m.weights_sha256)}`);
  if (m.tokenizer_sha256) l.push(`  tokenizer_sha256: ${q(m.tokenizer_sha256)}`);
  l.push(`  quant: ${q(m.quant)}`);
  if (m.creator_handle) l.push(`  creator_handle: ${q(m.creator_handle)}`);
  if (m.royalty_bps !== undefined) l.push(`  royalty_bps: ${m.royalty_bps}`);
  l.push(
    `lanes: [${c.lanes.join(", ")}]`,
    `pricing: { input_per_m_usdg: ${c.pricing.input_per_m_usdg}, output_per_m_usdg: ${c.pricing.output_per_m_usdg} }`,
    `policy: ${q(c.policy)}`,
    `tee: ${c.tee}`,
    `gpu: { cc_mode: ${q(c.gpu.cc_mode)}, multi_gpu: ${c.gpu.multi_gpu} }`,
    `kms: ${q(c.kms)}`,
    `region: ${q(c.region)}`,
  );
  if (c.nodes?.length) {
    l.push("nodes:");
    for (const n of c.nodes) l.push(`  - { name: ${q(n.name)}, endpoint: ${q(n.endpoint)}${n.region ? `, region: ${q(n.region)}` : ""} }`);
  }
  return `${l.join("\n")}\n`;
}

function num(flag: string, v: string | undefined, re: RegExp, what: string): number | undefined {
  if (v === undefined) return undefined;
  if (!re.test(v)) throw new UsageError(`--${flag} "${v}" is not ${what}`);
  return Number(v);
}
const digest = (v: string | undefined) => (v === undefined || v.startsWith("sha256:") ? v : `sha256:${v}`);
const PRICE = /^(0|[1-9][0-9]{0,3})(\.[0-9]{1,6})?$/;

/** Build a SealConfig from init flags. `existing` supplies host_id and nodes on --force. Throws UsageError. */
export function buildSeal(f: Flags, existing: Partial<SealConfig> | null = null, rand: () => string = () => randomBytes(32).toString("hex")): SealConfig {
  const required = (name: string) => f.str(name) ?? (() => { throw new UsageError(`--${name} is required`); })();
  const tee = required("tee") as SealConfig["tee"];
  const lanes = (f.str("lanes") ?? (tee === "tdx" ? "public,attested" : "public")).split(",").map((s) => s.trim()).filter(Boolean) as SealConfig["lanes"];
  const c: SealConfig = {
    version: 1,
    host_id: f.str("host-id") ?? existing?.host_id ?? `0x${rand()}`,
    engine: (f.str("engine") ?? "vllm") as SealConfig["engine"],
    engine_url: (f.str("engine-url") ?? "http://127.0.0.1:8000").replace(/\/+$/, "").replace(/\/v1$/, ""),
    model: {
      ...(f.str("model") ? { served_name: f.str("model") } : {}),
      hf_repo: required("hf-repo"),
      weights_sha256: digest(required("weights-sha256"))!,
      ...(f.str("tokenizer-sha256") ? { tokenizer_sha256: digest(f.str("tokenizer-sha256")) } : {}),
      quant: f.str("quant") ?? "bf16",
      ...(f.str("creator-handle") ? { creator_handle: f.str("creator-handle") } : {}),
      ...(f.has("royalty-bps") ? { royalty_bps: num("royalty-bps", f.str("royalty-bps"), /^(0|[1-9][0-9]{0,4})$/, "a whole number of basis points") } : {}),
    } as SealConfig["model"],
    lanes,
    pricing: {
      input_per_m_usdg: num("price-in", required("price-in"), PRICE, "a decimal number like 0.20")!,
      output_per_m_usdg: num("price-out", required("price-out"), PRICE, "a decimal number like 0.90")!,
    },
    policy: f.str("policy") ?? "default-v1",
    tee,
    gpu: { cc_mode: (f.str("cc-mode") ?? "off") as SealConfig["gpu"]["cc_mode"], multi_gpu: (f.str("multi-gpu") ?? "single") as SealConfig["gpu"]["multi_gpu"] },
    kms: f.str("kms") ?? "anyroute-main",
    region: required("region"),
  };
  if (existing?.nodes?.length) c.nodes = existing.nodes;
  return c;
}

export function readSeal(path: string): SealConfig {
  if (!existsSync(path)) throw new UsageError(`${path} does not exist (seal init writes it; --config names another file)`);
  const r = validateSeal(parseSealText(readFileSync(path, "utf8")));
  if (!r.ok) throw new UsageError(`${path} is not a valid seal.yaml:\n  ${r.errors.join("\n  ")}`);
  return r.value!;
}

function writeSeal(path: string, c: SealConfig): string[] {
  const r = validateSeal(parseSealText(renderSealYaml(c)));
  if (!r.ok) throw new UsageError(`refusing to write an invalid seal.yaml:\n  ${r.errors.join("\n  ")}`);
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, renderSealYaml(c), { mode: 0o644 });
  renameSync(tmp, path);
  return r.warnings;
}

/** Add or replace (by name) one node. */
export function upsertNode(c: SealConfig, node: { name: string; endpoint: string; region?: string }): SealConfig {
  const n = { name: node.name, endpoint: node.endpoint.replace(/\/+$/, ""), ...(node.region ? { region: node.region } : {}) };
  const nodes = [...(c.nodes ?? [])];
  const i = nodes.findIndex((x) => x.name === n.name);
  if (i >= 0) nodes[i] = n;
  else nodes.push(n);
  return { ...c, nodes };
}

// ---- verify ---------------------------------------------------------------------------------------------------------

export type VerifyOptions = {
  endpoint: string;
  expectedModelDigest?: string;
  router?: string;
  providerId?: string;
  allowSimulated?: boolean;
  fresh?: boolean;
  timeoutMs?: number;
};
export type VerifyDeps = { fetcher?: AttestFetcher; fetch?: typeof fetch; nonceHex?: () => string };
export type VerifyResult = { ok: boolean; endpoint: string; simulated: boolean; attestationRef: string | null; checks: Check[]; notChecked: string[] };

export async function runVerify(o: VerifyOptions, deps: VerifyDeps = {}): Promise<VerifyResult> {
  const base = o.endpoint.replace(/\/+$/, "").replace(/\/attest$/, "");
  const https = base.startsWith("https://");
  const get = deps.fetcher ?? (https ? nodeAttestFetcher({ timeoutMs: o.timeoutMs }) : defaultAttestFetcher(deps.fetch ?? fetch));
  const extra: Check[] = [];
  let boot: AttestDocument | null = null;
  let fresh: { doc: AttestDocument; nonceHex: string } | null = null;
  let certificate: Uint8Array | null = null;
  try {
    const r = await get(`${base}/attest`);
    boot = r.json as AttestDocument;
    certificate = r.certificate ?? null;
    if (o.fresh !== false) {
      const nonceHex = deps.nonceHex?.() ?? randomBytes(32).toString("hex");
      const fr = await get(`${base}/attest?nonce=${nonceHex}`);
      fresh = { doc: fr.json as AttestDocument, nonceHex };
    }
  } catch (e) {
    extra.push({ id: "endpoint.fetch", status: "fail", detail: `Could not read ${base}/attest: ${(e as Error).message}` });
  }
  let router: RouterAttestation | null = null;
  if (o.router && o.providerId) {
    try {
      router = await fetchRouterAttestation(o.router, o.providerId, deps.fetch ?? fetch);
    } catch (e) {
      extra.push({ id: "router.fetch", status: "fail", detail: `Could not read the router's record: ${(e as Error).message}` });
    }
  }
  const r = await evaluateAttestation(
    { providerId: o.providerId ?? base, router, boot, fresh, certificate },
    { allowSimulated: o.allowSimulated, expected: o.expectedModelDigest ? { modelDigest: o.expectedModelDigest } : undefined },
  );
  let checks = r.checks;
  const notChecked = [...r.notChecked];
  if (!o.router) {
    // Without a router only the endpoint's own evidence is checked; the router's quote verification is not.
    checks = checks.filter((c) => !c.id.startsWith("router."));
    notChecked.unshift("The router's record and its verification of the quote signature: pass --router and --id to include them.");
  }
  checks = [...checks, ...extra];
  const ok = checks.length > 0 && !checks.some((c) => c.status === "fail");
  return { ok, endpoint: base, simulated: r.simulated, attestationRef: r.bound?.attestationRef ?? null, checks, notChecked };
}

export function formatVerify(v: VerifyResult): string {
  const mark = { pass: "PASS", fail: "FAIL", not_checked: "SKIP" } as Record<string, string>;
  const lines = [`seal verify ${v.endpoint}`];
  for (const c of v.checks) lines.push(`  ${mark[c.status] ?? c.status.toUpperCase()}  ${c.id}: ${c.detail}`);
  if (v.notChecked.length) lines.push("  not checked:", ...v.notChecked.map((n) => `    - ${n}`));
  lines.push(v.ok ? `OK${v.simulated ? " (SIMULATED: no hardware behind this evidence)" : ""}: attestation ${v.attestationRef ?? "?"}` : "NOT VERIFIED");
  return lines.join("\n");
}

// ---- status ---------------------------------------------------------------------------------------------------------

export type NodeStatus = { name: string; endpoint: string; state: "ok" | "degraded" | "unreachable"; dev: boolean | null; modelDigestMatches: boolean | null; attestationRef: string | null; detail?: string };

/** Liveness only: /healthz over TLS without pinning. `seal verify` is the evidence check. */
export async function runStatus(nodes: { name: string; endpoint: string }[], expectedDigest: string | undefined, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<NodeStatus[]> {
  return Promise.all(
    nodes.map(async (n): Promise<NodeStatus> => {
      const base = n.endpoint.replace(/\/+$/, "");
      try {
        const init = { signal: AbortSignal.timeout(timeoutMs), tls: { rejectUnauthorized: false } } as RequestInit;
        const res = await fetchImpl(`${base}/healthz`, init);
        const body = (await res.json().catch(() => ({}))) as { status?: string; dev?: boolean; model_digest?: string; attestation?: { ref?: string } };
        return {
          name: n.name,
          endpoint: base,
          state: res.ok && body.status === "ok" ? "ok" : "degraded",
          dev: typeof body.dev === "boolean" ? body.dev : null,
          modelDigestMatches: expectedDigest && body.model_digest ? body.model_digest === expectedDigest : null,
          attestationRef: body.attestation?.ref ?? null,
        };
      } catch (e) {
        return { name: n.name, endpoint: base, state: "unreachable", dev: null, modelDigestMatches: null, attestationRef: null, detail: (e as Error).message };
      }
    }),
  );
}

export function formatStatus(rows: NodeStatus[]): string {
  if (!rows.length) return "no nodes (seal add-node --name <n> --endpoint <url>, or --endpoint <url>)";
  const yn = (b: boolean | null) => (b === null ? "?" : b ? "yes" : "NO");
  return [
    "name            state        dev   digest  attestation  endpoint",
    ...rows.map((r) => `${r.name.padEnd(15)} ${r.state.padEnd(12)} ${(r.dev ? "YES" : r.dev === null ? "?" : "no").padEnd(5)} ${yn(r.modelDigestMatches).padEnd(7)} ${(r.attestationRef?.slice(0, 12) ?? "-").padEnd(12)} ${r.endpoint}`),
  ].join("\n");
}

// ---- main -----------------------------------------------------------------------------------------------------------

function timeout(f: Flags): number | undefined {
  const v = f.str("timeout-ms");
  if (v === undefined) return undefined;
  if (!/^[1-9][0-9]{0,6}$/.test(v)) throw new UsageError("--timeout-ms must be a whole number of milliseconds");
  return Number(v);
}

export async function main(argv: string[], out: (s: string) => void = console.log, err: (s: string) => void = console.error): Promise<number> {
  let cli: ParsedCli;
  try {
    cli = parseCli(argv);
  } catch (e) {
    err(`seal: ${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const f = cli.flags;
  try {
    switch (cli.command) {
      case "help":
        out(USAGE);
        return 0;
      case "version":
        out(SEAL_CLI_VERSION);
        return 0;
      case "validate": {
        const path = f.positional[0] ?? "seal.yaml";
        if (!existsSync(path)) throw new UsageError(`${path} does not exist`);
        const r = validateSeal(parseSealText(readFileSync(path, "utf8")));
        for (const e of r.errors) err(`error: ${e}`);
        for (const w of r.warnings) err(`warning: ${w}`);
        if (r.ok) out(`${path}: valid (${SCHEMA_PATH.split("/").slice(-3).join("/")})`);
        return r.ok ? 0 : 1;
      }
      case "init": {
        const path = f.str("out") ?? "seal.yaml";
        let existing: SealConfig | null = null;
        if (existsSync(path)) {
          if (!f.bool("force")) throw new UsageError(`${path} exists; pass --force to replace it (host_id and nodes are kept)`);
          const parsed = parseSealText(readFileSync(path, "utf8")) as Partial<SealConfig> | null;
          existing = parsed && typeof parsed === "object" ? (parsed as SealConfig) : null;
        }
        const c = buildSeal(f, existing);
        for (const w of writeSeal(path, c)) err(`warning: ${w}`);
        out(`wrote ${path} (host_id ${c.host_id})`);
        return 0;
      }
      case "add-node": {
        const path = f.str("config") ?? "seal.yaml";
        const name = f.str("name");
        const endpoint = f.str("endpoint");
        if (!name || !endpoint) throw new UsageError("add-node needs --name and --endpoint");
        const c = upsertNode(readSeal(path), { name, endpoint, region: f.str("region") });
        for (const w of writeSeal(path, c)) err(`warning: ${w}`);
        out(`${path}: ${c.nodes!.length} node(s); ${name} -> ${endpoint.replace(/\/+$/, "")}`);
        return 0;
      }
      case "verify": {
        const config = f.str("config") ?? (existsSync("seal.yaml") ? "seal.yaml" : undefined);
        const seal = config ? readSeal(config) : null;
        const v = await runVerify({
          endpoint: f.positional[0],
          expectedModelDigest: seal?.model.weights_sha256,
          router: f.str("router"),
          providerId: f.str("id"),
          allowSimulated: f.bool("allow-simulated"),
          fresh: !f.bool("no-fresh"),
          timeoutMs: timeout(f),
        });
        out(f.bool("json") ? JSON.stringify(v, null, 2) : formatVerify(v));
        return v.ok ? 0 : 1;
      }
      case "status": {
        const extra = f.list("endpoint").map((e, i) => ({ name: `endpoint-${i + 1}`, endpoint: e }));
        const path = f.str("config") ?? "seal.yaml";
        const seal = extra.length && !f.has("config") && !existsSync(path) ? null : readSeal(path);
        const rows = await runStatus([...(seal?.nodes ?? []), ...extra], seal?.model.weights_sha256, fetch, timeout(f));
        out(f.bool("json") ? JSON.stringify(rows, null, 2) : formatStatus(rows));
        return rows.length > 0 && rows.every((r) => r.state === "ok") ? 0 : 1;
      }
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(`seal: ${e.message}`);
      return 2;
    }
    throw e;
  }
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
