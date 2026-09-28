import { fail } from "../lib/errors.ts";

// Opt-in input guardrails (per key, or per request via body.guardrails):
//   { pii: "redact" | "block", deny_patterns: ["substring", ...], max_input_chars: number, redact_output: bool }

export const MAX_PATTERNS = 50;
export const MAX_PATTERN_LEN = 200;

export type GuardrailConfig = { pii?: "redact" | "block"; deny_patterns?: string[]; max_input_chars?: number; redact_output?: boolean };

/** Request-level controls may add restrictions, but cannot weaken an authenticated key's policy. */
export function mergeGuardrails(key: GuardrailConfig | null | undefined, request: GuardrailConfig | null | undefined): GuardrailConfig | null {
  if (!key && !request) return null;
  const validatePatterns = (value: unknown, label: string) => {
    if (value === undefined) return [] as string[];
    if (!Array.isArray(value) || value.length > MAX_PATTERNS || value.some((p) => typeof p !== "string" || p.length < 1 || p.length > MAX_PATTERN_LEN))
      fail(400, `${label} deny_patterns must contain at most ${MAX_PATTERNS} non-empty strings of at most ${MAX_PATTERN_LEN} characters.`, "invalid_guardrails");
    return value as string[];
  };
  // Preserve legacy key-policy matching: first 50, truncate each at 200 chars,
  // and skip empty values. Request-supplied rules remain strictly validated.
  const keyPatterns = Array.isArray(key?.deny_patterns)
    ? key.deny_patterns.slice(0, MAX_PATTERNS).filter((p): p is string => typeof p === "string").map((p) => p.slice(0, MAX_PATTERN_LEN)).filter(Boolean)
    : [];
  const requestPatterns = validatePatterns(request?.deny_patterns, "Request");
  const patterns: string[] = [];
  const seen = new Set<string>();
  for (const pattern of [...keyPatterns, ...requestPatterns]) {
    const id = pattern.toLowerCase();
    if (seen.has(id)) continue;
    if (patterns.length >= MAX_PATTERNS)
      fail(400, `Combined key and request deny_patterns cannot exceed ${MAX_PATTERNS} unique entries.`, "invalid_guardrails");
    seen.add(id);
    patterns.push(pattern);
  }
  const limits = [key?.max_input_chars, request?.max_input_chars].filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0);
  const pii = key?.pii === "block" || request?.pii === "block" ? "block" : key?.pii === "redact" || request?.pii === "redact" ? "redact" : undefined;
  return {
    ...(pii ? { pii } : {}),
    ...(patterns.length ? { deny_patterns: patterns } : {}),
    ...(limits.length ? { max_input_chars: Math.min(...limits) } : {}),
    ...((key?.redact_output === true || request?.redact_output === true) ? { redact_output: true } : {}),
  };
}

const luhn = (digits: string) => {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
};

const DETECTORS: { name: string; re: RegExp; valid?: (m: string) => boolean }[] = [
  { name: "EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: "PRIVATE_KEY", re: /\b0x[0-9a-fA-F]{64}\b/g },
  { name: "API_KEY", re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g },
  { name: "CARD", re: /\b(?:\d[ -]?){12,18}\d\b/g, valid: (m) => luhn(m.replace(/\D/g, "")) },
  { name: "SSN", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: "IBAN", re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g },
  { name: "PHONE", re: /(?<![\w])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{3}[ .-]?\d{3,4}(?:[ .-]?\d{2,4})?(?![\w])/g, valid: (m) => m.replace(/\D/g, "").length >= 10 },
];

export function findPii(text: string) {
  const hits: { type: string; value: string }[] = [];
  for (const d of DETECTORS) for (const m of text.matchAll(d.re)) if (!d.valid || d.valid(m[0])) hits.push({ type: d.name, value: m[0] });
  return hits;
}

export function redactText(text: string) {
  let out = text;
  let count = 0;
  for (const d of DETECTORS)
    out = out.replace(d.re, (m) => {
      if (d.valid && !d.valid(m)) return m;
      count++;
      return `[REDACTED_${d.name}]`;
    });
  return { text: out, count };
}

function mapText(body: Record<string, unknown>, fn: (s: string) => string) {
  if (Array.isArray(body.messages))
    body.messages = (body.messages as any[]).map((m) => {
      if (typeof m?.content === "string") return { ...m, content: fn(m.content) };
      if (Array.isArray(m?.content)) return { ...m, content: m.content.map((p: any) => (p?.type === "text" ? { ...p, text: fn(String(p.text ?? "")) } : p)) };
      return m;
    });
  if (typeof body.prompt === "string") body.prompt = fn(body.prompt);
}

function allText(body: Record<string, unknown>) {
  const parts: string[] = [];
  mapText(structuredClone(body), (s) => {
    parts.push(s);
    return s;
  });
  return parts.join("\n");
}

/** Apply input guardrails in place. Returns what happened (for response metadata). */
export function applyGuardrails(body: Record<string, unknown>, g: GuardrailConfig | null | undefined) {
  if (!g) return null;
  const report: { redactions: number; blocked?: string } = { redactions: 0 };
  const text = allText(body);
  if (g.max_input_chars && text.length > g.max_input_chars)
    fail(400, `Input exceeds this key's guardrail limit of ${g.max_input_chars} characters.`, "guardrail_blocked", { guardrail: "max_input_chars" });
  // Deny patterns are case-insensitive substrings, never regexes: caller-supplied regexes could pin
  // the event loop (catastrophic backtracking). Bounded in count and length.
  const lower = text.toLowerCase();
  for (const p of (g.deny_patterns ?? []).slice(0, MAX_PATTERNS)) {
    const needle = String(p).slice(0, MAX_PATTERN_LEN).toLowerCase();
    if (needle && lower.includes(needle)) fail(400, "Input matched a blocked pattern for this key.", "guardrail_blocked", { guardrail: "deny_patterns" });
  }
  if (g.pii === "block") {
    const hits = findPii(text);
    if (hits.length) fail(400, `Input contains personal data (${[...new Set(hits.map((h) => h.type))].join(", ")}) and this key blocks it.`, "guardrail_blocked", { guardrail: "pii" });
  } else if (g.pii === "redact") {
    mapText(body, (s) => {
      const r = redactText(s);
      report.redactions += r.count;
      return r.text;
    });
  }
  return report;
}

export function redactOutput(json: any) {
  let n = 0;
  for (const ch of json?.choices ?? []) {
    if (typeof ch?.text === "string") { const r = redactText(ch.text); ch.text = r.text; n += r.count; }
    if (typeof ch?.message?.content === "string") {
      const r = redactText(ch.message.content);
      ch.message.content = r.text;
      n += r.count;
    }
  }
  return n;
}
