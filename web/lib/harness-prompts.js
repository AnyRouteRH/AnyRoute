// V81: browser prompt data only. Values are inserted literally, never evaluated.
export const PROMPT_FORMAT = "anyroute-harness-prompts";
export const PROMPT_VERSION = 1;
export const PROMPT_KEY = "anyroute-harness-prompts-v1";
export const MAX_PROMPTS = 200;
export const MAX_PROMPT_BYTES = 2_000_000;
const bytes = (s) => new TextEncoder().encode(s).length;
const bad = () => { throw new Error("Choose a valid Anyroute prompt library JSON file (version 1, up to 2 MB)."); };
const field = (value, max, required = false) => {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) bad();
  return value;
};

export function validatePrompts(prompts) {
  if (!Array.isArray(prompts) || prompts.length > MAX_PROMPTS) bad();
  const ids = new Set();
  const clean = prompts.map((p) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) bad();
    const id = field(p.id, 200, true);
    if (ids.has(id)) bad();
    ids.add(id);
    if (p.pinned !== undefined && typeof p.pinned !== "boolean") bad();
    if (p.tags !== undefined && (!Array.isArray(p.tags) || p.tags.length > 20)) bad();
    return { id, name: field(p.name, 80, true).trim(), text: field(p.text, 100_000, true),
      tags: [...new Set((p.tags || []).map((t) => field(t, 40, true).trim()))], pinned: p.pinned === true,
      ...(p.system === undefined ? {} : { system: field(p.system, 100_000) }),
      ...(p.model === undefined ? {} : { model: field(p.model, 300, true) }) };
  });
  if (bytes(JSON.stringify({ format: PROMPT_FORMAT, version: PROMPT_VERSION, prompts: clean })) > MAX_PROMPT_BYTES) bad();
  return clean;
}

export function exportPrompts(prompts) {
  return JSON.stringify({ format: PROMPT_FORMAT, version: PROMPT_VERSION, prompts: validatePrompts(prompts) });
}
export function importPrompts(source) {
  if (typeof source !== "string" || bytes(source) > MAX_PROMPT_BYTES) bad();
  let doc;
  try { doc = JSON.parse(source); } catch { bad(); }
  if (doc?.format !== PROMPT_FORMAT || doc.version !== PROMPT_VERSION) bad();
  return validatePrompts(doc.prompts);
}
export function mergePrompts(existing, incoming) {
  const ids = new Set(existing.map((p) => p.id));
  return validatePrompts([...existing, ...incoming.filter((p) => !ids.has(p.id) && !!ids.add(p.id))]);
}
export function readPrompts(storage) {
  const stored = storage.getItem(PROMPT_KEY);
  return stored === null ? structuredClone(STARTER_PROMPTS) : importPrompts(stored);
}
export function writePrompts(storage, prompts) { storage.setItem(PROMPT_KEY, exportPrompts(prompts)); }

// An odd backslash escapes a variable; pairs become literal backslashes. JSON braces are untouched.
const pattern = () => /(\\*)\{\{([ \t]*[A-Za-z_][A-Za-z0-9_. -]{0,63})\}\}/g;
export function promptVariables(...sources) {
  const names = new Set();
  for (const source of sources) for (const m of (source || "").matchAll(pattern())) {
    if (m[1].length % 2 === 0) names.add(m[2].trim());
  }
  return [...names];
}
export function fillPrompt(source, values) {
  return source.replace(pattern(), (_, slashes, raw) => {
    const prefix = "\\".repeat(Math.floor(slashes.length / 2));
    if (slashes.length % 2) return prefix + "{{" + raw + "}}";
    const name = raw.trim();
    if (!Object.hasOwn(values, name) || typeof values[name] !== "string" || !values[name].trim()) throw new Error(`Fill in ${name}.`);
    return prefix + values[name];
  });
}
export function searchPrompts(prompts, query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return prompts.filter((p) => {
    const hay = [p.name, ...p.tags, p.text, p.system || ""].join("\n").toLowerCase();
    return words.every((w) => hay.includes(w));
  }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
}
export function promptShortcut(e) {
  return !!((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p" && !e.altKey && !e.repeat && !e.isComposing);
}
export function slashPrompts(prompts, draft) {
  if (!/^\/[^\n]*$/.test(draft)) return [];
  const name = draft.slice(1).trim().toLowerCase();
  return searchPrompts(prompts, "").filter((p) => p.name.toLowerCase().startsWith(name)).slice(0, 8);
}

export const STARTER_PROMPTS = [
  ["summarise", "Summarise a document", "Summarise the document below in five bullets. Include its main point, supporting evidence, decisions and open questions. Do not add facts absent from the document.\n\n{{document}}", ["writing", "summary"]],
  ["code", "Explain code", "Explain what this code does, its inputs and outputs, and any assumptions or edge cases. Use plain language, then walk through one example.\n\n{{code}}", ["code"]],
  ["checks", "Write checks", "Write unit checks for this code in {{framework}}. Cover normal inputs, boundaries and failure cases. State assumptions and show how to run the checks.\n\n{{code}}", ["code", "quality"]],
  ["clarity", "Rewrite for clarity", "Rewrite this text for {{audience}}. Keep its meaning and facts, use direct sentences, and remove repetition. Return the rewrite followed by a short list of changes.\n\n{{text}}", ["writing"]],
  ["json", "Extract JSON", "Extract only information supported by the text into JSON matching the schema below. Use null for unknown values where the schema allows it. If the schema cannot represent missing information, explain the conflict. Return no surrounding prose when valid JSON is possible.\n\nSchema:\n{{schema}}\n\nText:\n{{text}}", ["data", "json"]],
  ["options", "Compare two options", "Compare {{option_a}} and {{option_b}} for {{goal}}. List tradeoffs, costs and uncertainties. Separate known facts from assumptions and explain what information would change the decision.", ["decisions"]],
  ["translate", "Translate text", "Translate the text below into {{language}}. Preserve tone, meaning and formatting. Flag ambiguous terms briefly after the translation.\n\n{{text}}", ["language", "writing"]],
  ["reply", "Draft a reply", "Draft a {{tone}} reply to the message below. Address its questions, do not invent commitments or facts, and keep it concise.\n\n{{message}}", ["writing"]],
].map(([id, name, text, tags]) => ({ id: "starter-" + id, name, text, tags, pinned: false }));
