// Presets tab helpers: pure functions shared by components/features/Presets.jsx and tests/presets.test.mjs.
// A preset is a versioned saved route (@preset/<name>[@<version>]) that may also carry a system prompt, tools and a
// response_format. The router is the authority on every rule; these checks only stop obvious mistakes before a call.

export const PRESET_PREFIX = "@preset/";
export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
export const MAX_PRESETS = 100;
export const MAX_VERSIONS = 100;
export const LIMITS = { systemPromptChars: 16000, tools: 32, models: 8, presetBytes: 64 * 1024 };
const FIELDS = ["description", "models", "provider", "params", "system_prompt", "response_format", "tools", "tool_choice"];

export const shortHash = (hash) => String(hash || "").slice(0, 12);
export const versionLabel = (v) => `v${v.version} · ${shortHash(v.hash)}`;
export const pinned = (name, version) => `${PRESET_PREFIX}${name}@${version}`;

/** A name suggestion inside the router's pattern. */
export function slugifyName(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

/** The editor's starting text: a preset document as formatted JSON. */
export function docText(doc) {
  const out = {};
  for (const k of FIELDS) if (doc?.[k] !== undefined) out[k] = doc[k];
  return JSON.stringify(Object.keys(out).length ? out : { description: "", models: [], params: { temperature: 0.2 }, system_prompt: "You are a helpful assistant." }, null, 2);
}

/**
 * Parse the editor's JSON into a preset document. Returns { ok, doc } or { ok: false, errors } with one message per field,
 * checking what can be checked without the router: JSON syntax, known fields, the model list and the size caps.
 */
export function parseDoc(text, { catalogIds } = {}) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: { json: `Not valid JSON: ${e.message}` } };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, errors: { json: "The preset is a JSON object." } };
  const errors = {};
  const unknown = Object.keys(doc).filter((k) => !FIELDS.includes(k));
  if (unknown.length) errors.json = `Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. A preset has ${FIELDS.join(", ")}.`;
  const models = doc.models;
  if (!Array.isArray(models) || !models.length) errors.models = "List at least one model.";
  else if (models.length > LIMITS.models) errors.models = `List at most ${LIMITS.models} models.`;
  else if (new Set(models).size !== models.length) errors.models = "List each model once.";
  else if (models.some((m) => typeof m !== "string" || /^@(route|preset)\//i.test(m))) errors.models = "Models are catalog ids; a preset cannot point to a route or another preset.";
  else if (catalogIds) {
    const missing = models.filter((m) => !catalogIds.has(String(m).split(":")[0]));
    if (missing.length) errors.models = `Not in the catalog: ${missing.join(", ")}.`;
  }
  if (doc.system_prompt !== undefined && (typeof doc.system_prompt !== "string" || !doc.system_prompt.length)) errors.system_prompt = "system_prompt is text; leave it out instead of sending it empty.";
  else if (typeof doc.system_prompt === "string" && doc.system_prompt.length > LIMITS.systemPromptChars) errors.system_prompt = `system_prompt is ${doc.system_prompt.length.toLocaleString("en-US")} characters; the limit is ${LIMITS.systemPromptChars.toLocaleString("en-US")}.`;
  if (doc.tools !== undefined && (!Array.isArray(doc.tools) || doc.tools.length > LIMITS.tools)) errors.tools = `tools is a list of at most ${LIMITS.tools} function definitions.`;
  if (doc.tool_choice !== undefined && !doc.tools) errors.tool_choice = "tool_choice needs tools in the same preset.";
  if (typeof doc.description === "string" && doc.description.trim().length > 280) errors.description = "The description is at most 280 characters.";
  const size = new TextEncoder().encode(JSON.stringify(doc)).length;
  if (size > LIMITS.presetBytes) errors.json = `The preset is ${size.toLocaleString("en-US")} bytes as JSON; the limit is 64 KB.`;
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, doc };
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const ptr = (s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1");
const stable = (v) => JSON.stringify(v, (_, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/** The router's diff (GET /api/v1/presets/:name/diff), for the sample workspace: JSON Pointer paths with old and new values. */
export function diffDocs(a, b, path = "") {
  if (stable(a) === stable(b)) return [];
  if (isObj(a) && isObj(b)) {
    const out = [];
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const p = `${path}/${ptr(k)}`;
      if (!(k in b)) out.push({ op: "remove", path: p, from: a[k] });
      else if (!(k in a)) out.push({ op: "add", path: p, to: b[k] });
      else out.push(...diffDocs(a[k], b[k], p));
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const out = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= b.length) out.push({ op: "remove", path: `${path}/${i}`, from: a[i] });
      else if (i >= a.length) out.push({ op: "add", path: `${path}/${i}`, to: b[i] });
      else out.push(...diffDocs(a[i], b[i], `${path}/${i}`));
    }
    return out;
  }
  return [{ op: "replace", path: path || "/", from: a, to: b }];
}

/** A value in the diff view: strings as written (cut), everything else as compact JSON. */
export function showValue(v, max = 160) {
  if (v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Short tags for the list: what the preset sets beyond its models. */
export function presetSummary(doc = {}) {
  const tags = [];
  if (doc.system_prompt) tags.push(`system prompt · ${doc.system_prompt.length.toLocaleString("en-US")} chars`);
  if (doc.tools?.length) tags.push(`${doc.tools.length} tool${doc.tools.length === 1 ? "" : "s"}`);
  if (doc.response_format) tags.push(`response_format ${doc.response_format.type}`);
  if (doc.provider?.lane === "attested") tags.push("lane attested");
  else if (doc.provider?.disclosure) tags.push(`disclosure ${doc.provider.disclosure}`);
  for (const [k, v] of Object.entries(doc.params || {})) if (typeof v !== "object") tags.push(`${k} ${v}`);
  return tags;
}

export function snippet(name, version, base, lang = "js") {
  const url = (base || "https://your-router.example").replace(/\/$/, "") + "/api/v1";
  const model = PRESET_PREFIX + (name || "your-preset") + (version ? `@${version}` : "");
  if (lang === "python")
    return `import os
from openai import OpenAI

client = OpenAI(base_url="${url}", api_key=os.environ["ANYROUTE_API_KEY"])

completion = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(completion.model)  # the model that served this call`;
  return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${url}",
  apiKey: process.env.ANYROUTE_API_KEY,
});

const completion = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(completion.model, completion.preset); // served model, { name, version, hash }`;
}

// ---- the sample workspace ----------------------------------------------------------------------------

const S1 = { description: "Support replies in one line", models: ["qwen/qwen3-32b", "meta-llama/llama-3.3-70b-instruct"], params: { temperature: 0.2, max_tokens: 200 }, system_prompt: "You are the support assistant. Answer in one line." };
const S2 = { ...S1, params: { temperature: 0.4, max_tokens: 200 }, system_prompt: "You are the support assistant. Answer in one line and link the docs." };
const E1 = { description: "Extract invoice fields as JSON", models: ["meta-llama/llama-3.3-70b-instruct"], params: { temperature: 0 }, response_format: { type: "json_object" } };

/** Fixed, labelled examples for the sample workspace: never sent to the API. */
export const samplePresets = [
  {
    name: "extract-invoice",
    model: PRESET_PREFIX + "extract-invoice",
    description: E1.description,
    version: 1,
    hash: "4b1e0c9a7d2f5e8c3a6b9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c",
    config: E1,
    versions: 1,
    sample: true,
    history: [{ version: 1, hash: "4b1e0c9a7d2f5e8c3a6b9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c", source: "put", created_at: "2026-09-28T09:00:00.000Z", config: E1 }],
  },
  {
    name: "support",
    model: PRESET_PREFIX + "support",
    description: S1.description,
    version: 3,
    hash: "9f2c4e6a8b0d1f3e5a7c9b1d3f5e7a9c0b2d4f6e8a0c2e4b6d8f0a1c3e5b7d9f",
    config: S1,
    versions: 3,
    sample: true,
    history: [
      { version: 3, hash: "9f2c4e6a8b0d1f3e5a7c9b1d3f5e7a9c0b2d4f6e8a0c2e4b6d8f0a1c3e5b7d9f", source: "rollback", restored_from: 1, created_at: "2026-09-30T08:10:00.000Z", config: S1 },
      { version: 2, hash: "1a3c5e7f9b2d4f6a8c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f1a3c5e7b9d2f4a", source: "put", created_at: "2026-09-29T16:40:00.000Z", config: S2 },
      { version: 1, hash: "9f2c4e6a8b0d1f3e5a7c9b1d3f5e7a9c0b2d4f6e8a0c2e4b6d8f0a1c3e5b7d9f", source: "put", created_at: "2026-09-29T10:05:00.000Z", config: S1 },
    ],
  },
];
