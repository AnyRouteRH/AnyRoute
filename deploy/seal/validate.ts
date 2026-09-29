#!/usr/bin/env bun
// A small validator for seal.yaml. It interprets deploy/seal/seal.schema.json (the single source of truth) with the
// subset of JSON Schema 2020-12 that the schema uses, and refuses a schema keyword it does not implement, so a keyword
// added to the schema can never be ignored silently. It then adds warnings for settings that are valid but have
// consequences a host should read. No dependencies: YAML is parsed with Bun's built-in YAML 1.2 parser, so it runs
// from a bare checkout without `bun install`.
//
//   bun deploy/seal/validate.ts seal.yaml      exit 0 when valid (warnings on stderr), 3 when not, 2 on usage

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Schema = Record<string, unknown>;
export type SealConfig = {
  version: 1;
  host_id?: string;
  engine: "vllm" | "sglang" | "llamacpp" | "ollama";
  engine_url: string;
  model: { served_name?: string; hf_repo: string; weights_sha256: string; tokenizer_sha256?: string; quant: string; creator_handle?: string; royalty_bps?: number };
  lanes: ("public" | "attested" | "unlinkable")[];
  pricing: { input_per_m_usdg: number; output_per_m_usdg: number };
  policy: string;
  tee: "tdx" | "sev-snp" | "none";
  gpu: { cc_mode: "on" | "off"; multi_gpu: "single" | "nvle" | "ppcie" };
  kms: string;
  region: string;
  nodes?: { name: string; endpoint: string; region?: string }[];
};
export type SealValidation = { ok: boolean; errors: string[]; warnings: string[]; value: SealConfig | null };

export const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "seal.schema.json");

let cached: Schema | null = null;
export function loadSchema(): Schema {
  cached ??= JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Schema;
  return cached;
}

// Keywords that only describe: they never change the outcome.
const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "default", "examples", "$comment"]);
const IMPLEMENTED = new Set([
  "type", "enum", "const", "pattern", "minLength", "maxLength", "minimum", "maximum", "properties", "required",
  "additionalProperties", "items", "minItems", "maxItems", "uniqueItems", "contains", "allOf", "if", "then", "else",
]);

/** Every keyword in the schema, anywhere, must be implemented or an annotation. Throws otherwise. */
export function assertSupported(schema: unknown, at = "#"): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  for (const [k, v] of Object.entries(schema as Schema)) {
    if (ANNOTATIONS.has(k)) continue;
    if (!IMPLEMENTED.has(k)) throw new Error(`seal.schema.json uses "${k}" at ${at}, which validate.ts does not implement`);
    if (k === "properties") for (const [p, s] of Object.entries(v as Schema)) assertSupported(s, `${at}/properties/${p}`);
    else if (k === "allOf") (v as unknown[]).forEach((s, i) => assertSupported(s, `${at}/allOf/${i}`));
    else if (["items", "contains", "if", "then", "else"].includes(k) || (k === "additionalProperties" && typeof v === "object")) assertSupported(v, `${at}/${k}`);
  }
}

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const typeMatches = (v: unknown, t: string) => typeOf(v) === t || (t === "number" && typeof v === "number" && Number.isFinite(v));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v));

/** Validate `value` against `schema`; returns error strings with a JSON-pointer-ish path. */
export function check(schema: Schema, value: unknown, path = ""): string[] {
  const errs: string[] = [];
  const where = path || "(root)";
  if ("type" in schema) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => typeMatches(value, t))) return [`${where}: expected ${types.join(" or ")}, got ${typeOf(value)}`];
  }
  if ("const" in schema && !same(value, schema.const)) errs.push(`${where}: must be ${show(schema.const)}`);
  if ("enum" in schema && !(schema.enum as unknown[]).some((e) => same(e, value))) errs.push(`${where}: must be one of ${(schema.enum as unknown[]).map(show).join(", ")}, got ${show(value)}`);
  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errs.push(`${where}: ${show(value)} does not match ${schema.pattern}`);
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errs.push(`${where}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errs.push(`${where}: longer than ${schema.maxLength}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errs.push(`${where}: below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errs.push(`${where}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errs.push(`${where}: needs at least ${schema.minItems} item(s)`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errs.push(`${where}: at most ${schema.maxItems} item(s)`);
    if (schema.uniqueItems === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errs.push(`${where}: items must be unique`);
    if (schema.items && typeof schema.items === "object") value.forEach((v, i) => errs.push(...check(schema.items as Schema, v, `${path}/${i}`)));
    if (schema.contains && !value.some((v) => check(schema.contains as Schema, v, path).length === 0)) errs.push(`${where}: no item matches`);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of (schema.required as string[] | undefined) ?? []) if (!(r in obj)) errs.push(`${path}/${r}: required`);
    const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [k, v] of Object.entries(obj)) {
      if (k in props) errs.push(...check(props[k], v, `${path}/${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}/${k}: unknown setting`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") errs.push(...check(schema.additionalProperties as Schema, v, `${path}/${k}`));
    }
  }
  for (const [i, sub] of ((schema.allOf as Schema[] | undefined) ?? []).entries()) {
    const sub_errs = check(sub, value, path);
    if (sub_errs.length) errs.push(...(typeof sub.description === "string" ? [`${where}: ${sub.description} (${sub_errs.join("; ")})`] : sub_errs.map((e) => `${e} (allOf/${i})`)));
  }
  if (schema.if && typeof schema.if === "object") {
    const branch = check(schema.if as Schema, value, path).length === 0 ? schema.then : schema.else;
    if (branch && typeof branch === "object") errs.push(...check(branch as Schema, value, path));
  }
  return errs;
}

/** Valid-but-consequential settings. Never errors: these are for a host to read before going live. */
export function warningsFor(c: SealConfig): string[] {
  const w: string[] = [];
  if (c.gpu.multi_gpu === "ppcie") w.push("gpu.multi_gpu ppcie: NVLink traffic between GPUs is not encrypted. Disclose it, or serve on one GPU or with NVLE.");
  if (c.tee === "sev-snp") w.push("tee sev-snp: the host can carry CPU claims only, never confidential-GPU claims, and the sidecar has no SEV-SNP evidence provider yet, so it cannot attest this host today.");
  if (c.tee === "none") w.push("tee none: nothing about this host is attested. Only the public lane is available.");
  if (c.engine === "llamacpp" || c.engine === "ollama") w.push(`engine ${c.engine}: no batch-invariant serving mode, so responses cannot be re-executed bit for bit.`);
  if (c.lanes.includes("unlinkable")) w.push("lane unlinkable: the router serves it only with Oblivious HTTP and blind tokens switched on.");
  if (c.gpu.cc_mode === "off" && c.tee === "tdx") w.push("gpu.cc_mode off: only the CPU side is confidential; the GPU and its memory are not.");
  if (!c.host_id) w.push("host_id is not set: the router cannot link this endpoint to a HostBond.");
  return w;
}

export function validateSeal(value: unknown, schema: Schema = loadSchema()): SealValidation {
  assertSupported(schema);
  const errors = check(schema, value);
  if (errors.length) return { ok: false, errors, warnings: [], value: null };
  const c = value as SealConfig;
  return { ok: true, errors: [], warnings: warningsFor(c), value: c };
}

export function parseSealText(text: string): unknown {
  // YAML 1.2: a bare `on` stays a string here, but write it quoted for YAML 1.1 readers (Helm, PyYAML).
  return Bun.YAML.parse(text);
}

export function validateSealFile(path: string): SealValidation {
  let parsed: unknown;
  try {
    parsed = parseSealText(readFileSync(path, "utf8"));
  } catch (e) {
    return { ok: false, errors: [`${path}: ${(e as Error).message}`], warnings: [], value: null };
  }
  return validateSeal(parsed);
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file || process.argv.length > 3) {
    console.error("usage: bun deploy/seal/validate.ts <seal.yaml>");
    process.exit(2);
  }
  const r = validateSealFile(file);
  for (const e of r.errors) console.error(`error: ${e}`);
  for (const w of r.warnings) console.error(`warning: ${w}`);
  if (r.ok) console.log(`${file}: valid`);
  process.exit(r.ok ? 0 : 3);
}
