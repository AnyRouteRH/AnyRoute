// Model names for the Anthropic Messages endpoint. Any model id in the AnyRoute catalog works as sent. An operator can
// also map the names an Anthropic client insists on sending (claude-sonnet-4-5, claude-haiku-4-5, ...) to catalog models
// with ANTHROPIC_MODEL_MAP, a JSON object:
//   {"claude-sonnet-4-5": "meta-llama/llama-3.3-70b-instruct", "claude-haiku-*": "qwen/qwen3-32b", "*": "qwen/qwen3-32b"}
// An exact name wins over a prefix ("claude-haiku-*" matches every name that starts with "claude-haiku-", the longest
// prefix wins), and a lone "*" answers any name nothing else matched.

export type ModelMap = { exact: Map<string, string>; prefixes: [prefix: string, target: string][]; fallback: string | null };

export const EMPTY_MODEL_MAP: ModelMap = { exact: new Map(), prefixes: [], fallback: null };

const MAX_ENTRIES = 100;

/** Parse ANTHROPIC_MODEL_MAP. Throws a message an operator can act on: a bad map must stop the router, not route silently elsewhere. */
export function parseModelMap(raw: string | null | undefined): ModelMap {
  if (raw == null || !raw.trim()) return EMPTY_MODEL_MAP;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ANTHROPIC_MODEL_MAP must be a JSON object such as {"claude-sonnet-4-5":"<catalog model id>"}.');
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("ANTHROPIC_MODEL_MAP must be a JSON object of names to catalog model ids.");
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_ENTRIES) throw new Error(`ANTHROPIC_MODEL_MAP may have at most ${MAX_ENTRIES} entries.`);
  const map: ModelMap = { exact: new Map(), prefixes: [], fallback: null };
  for (const [name, target] of entries) {
    if (!name.trim() || name.length > 200) throw new Error("ANTHROPIC_MODEL_MAP names must be 1 to 200 characters.");
    if (typeof target !== "string" || !target.trim() || target.length > 200) throw new Error(`ANTHROPIC_MODEL_MAP: "${name}" must map to a catalog model id (a string of 1 to 200 characters).`);
    if (name === "*") map.fallback = target.trim();
    else if (name.endsWith("*")) map.prefixes.push([name.slice(0, -1), target.trim()]);
    else map.exact.set(name, target.trim());
  }
  map.prefixes.sort((a, b) => b[0].length - a[0].length);
  return map;
}

/** The catalog model an operator mapped `name` to, or null when the map says nothing about it. */
export function mappedModel(map: ModelMap, name: string): string | null {
  const exact = map.exact.get(name);
  if (exact) return exact;
  for (const [prefix, target] of map.prefixes) if (name.startsWith(prefix)) return target;
  return map.fallback;
}

/** A name only Anthropic serves. AnyRoute serves open models, so an unmapped one gets an explanation instead of a bare 404. */
export const isAnthropicName = (name: string) => /^claude([-._\s]|$)/i.test(name.trim());
