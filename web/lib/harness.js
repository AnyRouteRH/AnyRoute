// Harness: the pure logic behind the one-page workspace for every model and its tools.
// Catalogue normalisation, capability filters, search and sort, request building with parameter
// gating (a setting the model does not declare is never sent), and the stream accumulator.
// No DOM, no storage: the page (components/Harness.jsx) owns those, and tests drive this file directly.
import { MODEL_CAPABILITIES, modelCapabilities, modelModalities } from "./model-capabilities.js";
import { catalogHasCapability } from "./harness-catalog-capabilities.js";
import { modelInputs } from "./harness-images.js";

// ---------------------------------------------------------------- capabilities

const has = (list, x) => Array.isArray(list) && list.includes(x);

/** Capability chips, in display order. Each test reads a normalised model (see normalizeModel). */
export const CAPS = [
  { key: "vision", label: "Vision", test: (m) => has(m.inputs, "image") },
  { key: "files", label: "Files", test: (m) => has(m.inputs, "file") },
  { key: "video", label: "Video in", test: (m) => has(m.inputs, "video") },
  { key: "tools", label: "Tools", test: (m) => m.params.has("tools") },
  { key: "reasoning", label: "Reasoning", test: (m) => m.params.has("reasoning") || m.params.has("include_reasoning") || m.params.has("reasoning_effort") },
  { key: "json", label: "JSON", test: (m) => m.params.has("response_format") || m.params.has("structured_outputs") },
  { key: "web", label: "Web search", test: (m) => m.params.has("web_search_options") },
  { key: "imageOut", label: "Image out", test: (m) => has(m.outputs, "image") },
  { key: "audioOut", label: "Audio out", test: (m) => has(m.outputs, "audio") },
  { key: "attested", label: "Attested", test: (m) => m.attested },
];

// ---------------------------------------------------------------- makers

const MAKER_NAMES = {
  openai: "OpenAI", anthropic: "Anthropic", google: "Google", qwen: "Qwen", mistralai: "Mistral", "z-ai": "Z.ai", deepseek: "DeepSeek",
  minimax: "MiniMax", "meta-llama": "Meta", meta: "Meta", tencent: "Tencent", moonshotai: "Moonshot", "aion-labs": "Aion Labs", cohere: "Cohere",
  "x-ai": "xAI", "bytedance-seed": "ByteDance Seed", bytedance: "ByteDance", nvidia: "NVIDIA", xiaomi: "Xiaomi", amazon: "Amazon", perplexity: "Perplexity",
  sakana: "Sakana", inclusionai: "inclusionAI", upstage: "Upstage", nousresearch: "Nous Research", microsoft: "Microsoft", "ibm-granite": "IBM Granite",
  "arcee-ai": "Arcee", liquid: "Liquid", baidu: "Baidu", stepfun: "StepFun", rekaai: "Reka", thedrummer: "TheDrummer", sao10k: "Sao10K",
};
const PREFIX_MAKERS = [
  [/^claude/, "anthropic"], [/^(gpt|o\d|chatgpt)/, "openai"], [/^gemini|^gemma/, "google"], [/^grok/, "x-ai"], [/^glm/, "z-ai"], [/^kimi/, "moonshotai"],
  [/^(qwen|qwq)/, "qwen"], [/^deepseek/, "deepseek"], [/^(llama)/, "meta-llama"], [/^(mistral|mixtral|codestral)/, "mistralai"],
];
/** Makers that lead the "popular" sort, most asked-for first. */
export const POPULAR_MAKERS = ["anthropic", "openai", "google", "deepseek", "qwen", "x-ai", "meta-llama", "moonshotai", "z-ai", "mistralai", "minimax"];

/** The maker key for a model id: the part before "/" (variants like "~openai" fold in), or a known name prefix. */
export function makerOf(id) {
  const s = String(id || "").toLowerCase();
  if (s.startsWith("@route/")) return "@route";
  const slash = s.indexOf("/");
  if (slash > 0) {
    const m = s.slice(0, slash).replace(/^~/, "");
    return m === "meta" ? "meta-llama" : m;
  }
  for (const [re, maker] of PREFIX_MAKERS) if (re.test(s)) return maker;
  return s.split(/[-.]/)[0] || s;
}
export function makerLabel(maker) {
  if (maker === "@route") return "Your routes";
  if (MAKER_NAMES[maker]) return MAKER_NAMES[maker];
  return String(maker).split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

// ---------------------------------------------------------------- normalise

const perMillion = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n * 1e6 : 0;
};

/** API catalogue record → the shape the harness renders and gates against. */
export function normalizeModel(raw, order = 0) {
  const params = new Set(raw.supported_parameters || []);
  const maker = makerOf(raw.id);
  const m = {
    id: raw.id,
    name: raw.name && raw.name !== raw.id ? raw.name : String(raw.id).split("/").pop(),
    maker,
    makerLabel: makerLabel(maker),
    context: Number(raw.context_length || raw.top_provider?.context_length || 0),
    maxOut: Number(raw.top_provider?.max_completion_tokens || 0) || null,
    inPrice: perMillion(raw.pricing?.prompt),
    outPrice: perMillion(raw.pricing?.completion),
    requestPrice: Number(raw.pricing?.request || 0) || 0,
    inputs: modelInputs(raw),
    outputs: modelModalities(raw, "output"),
    capabilities: modelCapabilities(raw),
    providerNames: [raw.provider_name, ...(raw.provider_names || [])].filter(Boolean).join(" "),
    params,
    attested: raw.disclosure?.best === "attested" || (!raw.disclosure && !!raw.attested_available),
    disclosure: raw.disclosure?.best || (raw.attested_available ? "attested" : null),
    created: Number(raw.created || 0),
    order,
    description: raw.description || "",
  };
  m.caps = new Set(CAPS.filter((c) => c.test(m)).map((c) => c.key));
  return m;
}

/**
 * A saved route (`@route/<slug>`) as a model entry. It can be served by any of its models, so it only
 * claims what every one of them supports: the intersection of their parameters and modalities.
 */
export function routeAsModel(route, byId) {
  const members = (route?.config?.models || []).map((id) => byId.get(String(id).replace(/:[a-z]+$/, ""))).filter(Boolean);
  const inter = (lists) => (lists.length ? lists.reduce((a, b) => a.filter((x) => b.includes(x))) : ["text"]);
  const params = members.length ? [...members[0].params].filter((p) => members.every((m) => m.params.has(p))) : ["max_tokens", "temperature", "stream"];
  const raw = {
    id: "@route/" + route.slug,
    name: route.name || route.slug,
    context_length: members.length ? Math.min(...members.map((m) => m.context || 0)) : 0,
    architecture: { input_modalities: inter(members.map((m) => m.inputs)), output_modalities: inter(members.map((m) => m.outputs)) },
    supported_parameters: params,
    pricing: members.length ? { prompt: Math.max(...members.map((m) => m.inPrice)) / 1e6, completion: Math.max(...members.map((m) => m.outPrice)) / 1e6 } : {},
    disclosure: { best: members.length && members.every((m) => m.attested) ? "attested" : null },
    description: route.description || "",
  };
  const m = normalizeModel(raw, -1);
  m.route = { slug: route.slug, members: members.map((x) => x.id) };
  return m;
}

// ---------------------------------------------------------------- counts, search, sort

export function catalogueCounts(models) {
  const makers = new Set(models.map((m) => (m.maker === "meta" ? "meta-llama" : m.maker)));
  const count = (k) => models.filter((m) => m.caps.has(k)).length;
  return { models: models.length, makers: makers.size, tools: count("tools"), vision: count("vision") };
}

const compact = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const subsequence = (needle, hay) => {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++;
  return i === needle.length;
};

/**
 * Score one model against a query: every word must match the name, id or maker, as a substring or
 * (for the id) as an in-order subsequence ("gpt4o", "dsr1"). Lower is better; null means no match.
 */
export function matchScore(m, query) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const name = m.name.toLowerCase();
  const id = m.id.toLowerCase();
  const maker = m.makerLabel.toLowerCase() + " " + m.maker + " " + (m.providerNames || "").toLowerCase();
  const cid = compact(m.id + m.name);
  let score = 0;
  for (const w of words) {
    const cw = compact(w);
    if (name.startsWith(w)) score += 0;
    else if (name.includes(w)) score += 1;
    else if (id.includes(w)) score += 2;
    else if (maker.includes(w)) score += 3;
    else if (cw && cid.includes(cw)) score += 4;
    else if (cw.length > 1 && subsequence(cw, cid)) score += 8;
    else return null;
  }
  return score;
}

export const SORTS = [
  { key: "popular", label: "Popular" },
  { key: "cheapest", label: "Cheapest" },
  { key: "context", label: "Context" },
];

const popularRank = (m) => {
  const i = POPULAR_MAKERS.indexOf(m.maker);
  return i < 0 ? POPULAR_MAKERS.length : i;
};
const blended = (m) => m.inPrice * 0.75 + m.outPrice * 0.25;

const COMPARE = {
  popular: (a, b) => popularRank(a) - popularRank(b) || a.order - b.order,
  cheapest: (a, b) => blended(a) - blended(b) || a.order - b.order,
  context: (a, b) => b.context - a.context || blended(a) - blended(b),
};

/** Filter (every chosen capability must be present), search, then sort. Search relevance leads when there is a query. */
export function filterCatalog(models, { query = "", caps = [], sort = "popular" } = {}) {
  const need = [...caps];
  const cmp = COMPARE[sort] || COMPARE.popular;
  const rows = [];
  for (const m of models) {
    if (!need.every((k) => catalogHasCapability(m, k))) continue;
    const s = matchScore(m, query);
    if (s === null) continue;
    rows.push({ m, s });
  }
  rows.sort((a, b) => a.s - b.s || cmp(a.m, b.m));
  return rows.map((r) => r.m);
}

/** How many models each chip would leave, given the other chosen chips and the query. */
export function capCounts(models, { query = "", caps = [] } = {}) {
  const base = models.filter((m) => [...caps].every((k) => catalogHasCapability(m, k)) && matchScore(m, query) !== null);
  return Object.fromEntries([...CAPS, ...MODEL_CAPABILITIES].map((c) => [c.key, base.filter((m) => catalogHasCapability(m, c.key)).length]));
}

/** Groups in the order their first model appears, so the sort decides the group order too. */
export function groupByMaker(list) {
  const groups = new Map();
  for (const m of list) {
    const k = m.maker;
    if (!groups.has(k)) groups.set(k, { maker: k, label: m.makerLabel, models: [] });
    groups.get(k).models.push(m);
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------- formatting

export function formatPrice(perM) {
  if (!perM) return "free";
  if (perM >= 100) return "$" + Math.round(perM);
  if (perM >= 0.01) return "$" + perM.toFixed(2).replace(/\.00$/, "");
  return "$" + Number(perM.toPrecision(2));
}
export function formatContext(n) {
  if (!n) return "n/a";
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0).replace(/\.0$/, "") + "M";
  if (n >= 1000) return Math.round(n / 1024) + "K";
  return String(n);
}
export const DISCLOSURE_LABEL = { attested: "Attested", policy: "Policy", "vendor-forwarded": "Vendor-forwarded" };

// ---------------------------------------------------------------- settings and request building

export const TOOL_PRESETS = {
  get_weather: {
    type: "function",
    function: {
      name: "get_weather",
      description: "Current weather for a city.",
      parameters: { type: "object", properties: { city: { type: "string", description: "City name, e.g. Lisbon" }, unit: { type: "string", enum: ["celsius", "fahrenheit"] } }, required: ["city"] },
    },
  },
  calculator: {
    type: "function",
    function: {
      name: "calculator",
      description: "Evaluate an arithmetic expression and return the number.",
      parameters: { type: "object", properties: { expression: { type: "string", description: "For example (12.5 * 4) / 3" } }, required: ["expression"] },
    },
  },
};

export const DEFAULT_SCHEMA = JSON.stringify(
  { name: "answer", schema: { type: "object", properties: { answer: { type: "string" }, confidence: { type: "number" } }, required: ["answer", "confidence"], additionalProperties: false } },
  null,
  2,
);

export const defaultSettings = () => ({
  reasoning: null, // null: model default · true · false
  effort: "medium",
  web: false,
  webSize: "medium",
  format: "text", // text · json · schema
  schema: DEFAULT_SCHEMA,
  tools: false,
  toolsText: JSON.stringify([TOOL_PRESETS.get_weather], null, 2),
  toolChoice: "auto",
  imageOut: false,
  audioOut: false,
  voice: "alloy",
  temperature: null,
  topP: null,
  maxTokens: null,
  seed: null,
  stop: "",
  verbosity: null,
});

/** Which tool panel sections a model can use. The panel shows only these; buildRequest sends only these. */
export function supportFor(m) {
  const p = m?.params || new Set();
  return {
    reasoning: p.has("reasoning") || p.has("include_reasoning") || p.has("reasoning_effort"),
    effort: p.has("reasoning_effort") || p.has("reasoning"),
    web: p.has("web_search_options"),
    json: p.has("response_format"),
    schema: p.has("structured_outputs"),
    tools: p.has("tools"),
    toolChoice: p.has("tool_choice"),
    imageOut: has(m?.outputs, "image"),
    audioOut: has(m?.outputs, "audio"),
    temperature: p.has("temperature"),
    topP: p.has("top_p"),
    maxTokens: p.has("max_tokens") || p.has("max_completion_tokens"),
    seed: p.has("seed"),
    stop: p.has("stop"),
    verbosity: p.has("verbosity"),
    images: has(m?.inputs, "image"),
    files: has(m?.inputs, "file"),
  };
}

/** Parse the function tools editor. Returns { tools } or { error } with a readable message. */
export function parseTools(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { error: "The tools are not valid JSON." };
  }
  const list = Array.isArray(v) ? v : [v];
  const tools = [];
  for (const t of list) {
    const fn = t?.type === "function" ? t.function : t?.function || t;
    if (!fn || typeof fn.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(fn.name)) return { error: "Each tool needs a function name (letters, digits, _ or -)." };
    tools.push({ type: "function", function: { name: fn.name, ...(fn.description ? { description: fn.description } : {}), parameters: fn.parameters || { type: "object", properties: {} } } });
  }
  if (!tools.length) return { error: "Add at least one tool." };
  return { tools };
}

export function parseSchema(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return { error: "The schema is not valid JSON." };
  }
  if (!v || typeof v !== "object") return { error: "The schema must be a JSON object." };
  const wrapped = v.schema && typeof v.schema === "object" ? v : { name: "output", schema: v };
  return { json_schema: { name: String(wrapped.name || "output").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64), strict: wrapped.strict !== false, schema: wrapped.schema } };
}

const parseStopList = (text) =>
  String(text || "")
    .split(/\n|,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((s) => s.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .slice(0, 4);

/** One stored message → the OpenAI wire format this model accepts. Attachments it cannot read are dropped and counted. */
export function toWire(msg, m, dropped = { images: 0, files: 0 }) {
  const s = supportFor(m);
  if (msg.role === "user") {
    const parts = [];
    for (const a of msg.attachments || []) {
      if (a.kind === "image") {
        if (s.images) parts.push({ type: "image_url", image_url: { url: a.url } });
        else dropped.images++;
      } else if (a.kind === "file") {
        if (s.files) parts.push({ type: "file", file: { filename: a.name, file_data: a.url } });
        else dropped.files++;
      }
    }
    if (!parts.length) return { role: "user", content: msg.text };
    return { role: "user", content: [{ type: "text", text: msg.text }, ...parts] };
  }
  if (msg.role === "assistant") {
    const calls = (msg.toolCalls || []).filter((c) => c.name);
    const out = { role: "assistant", content: msg.text || (calls.length ? null : "") };
    if (calls.length) out.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } }));
    return out;
  }
  if (msg.role === "tool") return { role: "tool", tool_call_id: msg.toolCallId, content: msg.text };
  return { role: msg.role, content: msg.text };
}

/** Messages worth sending: finished or partial replies, never an empty failed one. */
const sendable = (msg) => msg.role !== "assistant" || msg.text || (msg.toolCalls || []).length;

/**
 * The chat completion body for one model. Every optional field is gated on the model's declared
 * parameters, so a setting the model does not support is never sent. Returns { body, notes, error }.
 */
export function buildRequest({ model, settings = defaultSettings(), system = "", messages = [] }) {
  const s = supportFor(model);
  const p = model.params;
  const dropped = { images: 0, files: 0 };
  const wire = [];
  if (system.trim()) wire.push({ role: "system", content: system.trim() });
  for (const msg of messages) if (sendable(msg)) wire.push(toWire(msg, model, dropped));
  const body = { model: model.id, messages: wire };
  const notes = [];
  if (dropped.images) notes.push(`${dropped.images} image${dropped.images > 1 ? "s" : ""} left out: this model does not read images.`);
  if (dropped.files) notes.push(`${dropped.files} file${dropped.files > 1 ? "s" : ""} left out: this model does not read files.`);

  if (s.reasoning && settings.reasoning !== null) {
    if (p.has("reasoning")) body.reasoning = settings.reasoning ? (s.effort && settings.effort ? { effort: settings.effort } : { enabled: true }) : { enabled: false };
    else if (settings.reasoning && p.has("reasoning_effort")) body.reasoning_effort = settings.effort;
    if (p.has("include_reasoning")) body.include_reasoning = !!settings.reasoning;
  }
  if (s.web && settings.web) body.web_search_options = { search_context_size: settings.webSize || "medium" };
  if (settings.format === "json" && s.json) body.response_format = { type: "json_object" };
  if (settings.format === "schema" && s.schema) {
    const r = parseSchema(settings.schema);
    if (r.error) return { body, notes, error: r.error };
    body.response_format = { type: "json_schema", json_schema: r.json_schema };
  }
  if (s.tools && settings.tools) {
    const r = parseTools(settings.toolsText);
    if (r.error) return { body, notes, error: r.error };
    body.tools = r.tools;
    if (s.toolChoice && settings.toolChoice && settings.toolChoice !== "auto") body.tool_choice = settings.toolChoice;
  }
  if (s.imageOut && settings.imageOut) body.modalities = ["image", "text"];
  if (s.audioOut && settings.audioOut) {
    body.modalities = ["text", "audio"];
    body.audio = { voice: settings.voice || "alloy", format: "pcm16" };
  }
  if (s.temperature && settings.temperature !== null) body.temperature = settings.temperature;
  if (s.topP && settings.topP !== null) body.top_p = settings.topP;
  if (s.maxTokens && settings.maxTokens) {
    const n = Math.max(1, Math.floor(settings.maxTokens));
    if (p.has("max_tokens")) body.max_tokens = n;
    else body.max_completion_tokens = n;
  }
  if (s.seed && settings.seed !== null && Number.isFinite(settings.seed)) body.seed = Math.floor(settings.seed);
  if (s.stop) {
    const stop = parseStopList(settings.stop);
    if (stop.length) body.stop = stop;
  }
  if (s.verbosity && settings.verbosity) body.verbosity = settings.verbosity;
  return { body, notes, error: "" };
}

/** Settings the person turned on that this model would not receive (for the "not sent" note). */
export function ignoredSettings(model, settings) {
  const s = supportFor(model);
  const out = [];
  if (settings.reasoning !== null && !s.reasoning) out.push("reasoning");
  if (settings.web && !s.web) out.push("web search");
  if (settings.format === "json" && !s.json) out.push("JSON mode");
  if (settings.format === "schema" && !s.schema) out.push("JSON schema");
  if (settings.tools && !s.tools) out.push("function tools");
  if (settings.imageOut && !s.imageOut) out.push("image output");
  if (settings.audioOut && !s.audioOut) out.push("audio output");
  if (settings.temperature !== null && !s.temperature) out.push("temperature");
  if (settings.topP !== null && !s.topP) out.push("top_p");
  if (settings.seed !== null && !s.seed) out.push("seed");
  if (settings.stop.trim() && !s.stop) out.push("stop");
  if (settings.verbosity && !s.verbosity) out.push("verbosity");
  return out;
}

// ---------------------------------------------------------------- the stream accumulator

// `servedModel` (not `model`): a reply is merged into a message whose `model` is the id the person chose.
export const blankReply = () => ({ text: "", reasoning: "", toolCalls: [], images: [], audio: null, finish: null, usage: null, receipt: null, provider: null, servedModel: null, route: null });

/** Fold one SSE chunk into a reply. Returns a new object; content, reasoning, tool calls, images and audio accumulate. */
export function applyChunk(reply, ev) {
  if (!ev || typeof ev !== "object") return reply;
  const r = { ...reply };
  if (ev.provider) r.provider = ev.provider;
  if (ev.model) r.servedModel = ev.model;
  if (ev.route) r.route = ev.route;
  if (ev.usage) r.usage = ev.usage;
  if (ev.receipt) r.receipt = ev.receipt;
  for (const ch of Array.isArray(ev.choices) ? ev.choices : []) {
    const d = ch?.delta || ch?.message || {};
    if (typeof d.content === "string") r.text += d.content;
    if (typeof d.reasoning === "string") r.reasoning += d.reasoning;
    else if (typeof d.reasoning_content === "string") r.reasoning += d.reasoning_content;
    if (Array.isArray(d.tool_calls)) {
      const calls = r.toolCalls.map((c) => ({ ...c }));
      for (const tc of d.tool_calls) {
        const i = Number.isInteger(tc.index) ? tc.index : calls.length;
        const c = calls[i] || (calls[i] = { id: "", name: "", arguments: "" });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (typeof tc.function?.arguments === "string") c.arguments += tc.function.arguments;
      }
      r.toolCalls = calls.filter(Boolean);
    }
    if (Array.isArray(d.images)) r.images = [...r.images, ...d.images.map((x) => x?.image_url?.url || x?.url).filter((u) => typeof u === "string" && /^(data:image\/|https:\/\/)/.test(u))];
    if (d.audio && typeof d.audio === "object") {
      const a = r.audio ? { ...r.audio } : { data: "", transcript: "", format: "pcm16" };
      if (typeof d.audio.data === "string") a.data += d.audio.data;
      if (typeof d.audio.transcript === "string") a.transcript += d.audio.transcript;
      if (d.audio.format) a.format = d.audio.format;
      r.audio = a;
    }
    if (ch?.finish_reason) r.finish = ch.finish_reason;
  }
  return r;
}

/** Signed receipt facts for a reply footer. */
export function replyFacts(reply) {
  const u = reply?.usage || {};
  const p = reply?.receipt?.payload || {};
  return {
    tokensIn: Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : p.tokens?.prompt ?? null,
    tokensOut: Number.isFinite(u.completion_tokens) ? u.completion_tokens : p.tokens?.completion ?? null,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? p.tokens?.reasoning ?? 0,
    cost: Number.isFinite(u.cost) ? u.cost : p.cost != null ? Number(p.cost) : null,
    disclosure: p.disclosure || null,
    receiptId: reply?.receipt?.id || null,
    provider: reply?.provider || null,
  };
}

// ---------------------------------------------------------------- audio

/** 16-bit little-endian mono PCM (base64) → a WAV file's bytes, so the browser can play streamed audio. */
export function pcm16ToWav(base64, sampleRate = 24000) {
  const bin = typeof atob === "function" ? atob(base64) : Buffer.from(base64, "base64").toString("binary");
  const len = bin.length;
  const buf = new ArrayBuffer(44 + len);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + len, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, len, true);
  const out = new Uint8Array(buf);
  for (let i = 0; i < len; i++) out[44 + i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------- attachments

export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Which kind of attachment a file is, or null when the harness does not send it. */
export function attachmentKind(mime, name = "") {
  if (/^image\/(png|jpe?g|webp|gif)$/.test(mime)) return "image";
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "file";
  if (/^text\//.test(mime) || /\.(txt|md|csv|json)$/i.test(name)) return "file";
  return null;
}

// ---------------------------------------------------------------- tool result helpers

/** A safe arithmetic evaluator for the calculator preset: numbers, + - * / % ^ and parentheses only. */
export function evalArithmetic(expr) {
  const src = String(expr ?? "").replace(/\s+/g, "");
  if (!src || src.length > 200 || !/^[\d.+\-*/%^()]+$/.test(src)) return null;
  let i = 0;
  const peek = () => src[i];
  const num = () => {
    const m = src.slice(i).match(/^\d+(\.\d+)?|^\.\d+/);
    if (!m) throw new Error("number");
    i += m[0].length;
    return Number(m[0]);
  };
  const factor = () => {
    if (peek() === "-") return i++, -factor();
    if (peek() === "+") return i++, factor();
    let v;
    if (peek() === "(") {
      i++;
      v = sum();
      if (src[i++] !== ")") throw new Error("paren");
    } else v = num();
    if (peek() === "^") return i++, v ** factor();
    return v;
  };
  const product = () => {
    let v = factor();
    while (peek() !== undefined && "*/%".includes(peek())) {
      const op = src[i++];
      const r = factor();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const sum = () => {
    let v = product();
    while (peek() === "+" || peek() === "-") v = src[i++] === "+" ? v + product() : v - product();
    return v;
  };
  try {
    const v = sum();
    return i === src.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** A plausible result for the preset tools, so the manual tool loop can be tried in one click. */
export function sampleToolResult(call) {
  let args = {};
  try {
    args = JSON.parse(call?.arguments || "{}") || {};
  } catch {
    /* keep {} */
  }
  if (call?.name === "calculator") {
    const v = evalArithmetic(args.expression);
    return JSON.stringify(v === null ? { error: "Could not evaluate the expression." } : { result: v });
  }
  if (call?.name === "get_weather") return JSON.stringify({ city: args.city || "Lisbon", temperature: args.unit === "fahrenheit" ? 70 : 21, unit: args.unit || "celsius", conditions: "clear" });
  return "";
}
