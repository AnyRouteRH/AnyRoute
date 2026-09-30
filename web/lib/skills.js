// Helpers for the Skills tab (components/features/Skills.jsx). Scan levels are shown as text labels.

export const SKILL_LEVELS = ["trusted", "caution", "dangerous"];
export const LEVEL_LABEL = { trusted: "Trusted", caution: "Caution", dangerous: "Dangerous" };

/** Query string for GET /api/v1/skills. */
export function skillsQuery({ q = "", level = "" } = {}) {
  const p = new URLSearchParams();
  if (q.trim()) p.set("q", q.trim().slice(0, 100));
  if (SKILL_LEVELS.includes(level)) p.set("level", level);
  const s = p.toString();
  return s ? "?" + s : "";
}

export const formatPrice = (usd) => (!usd ? "Free" : "$" + Number(usd).toFixed(2));

/** One finding as a line: severity, rule, file and line, excerpt. */
export const findingLine = (f) => `${f.severity.toUpperCase()} ${f.rule} ${f.file}${f.line ? ":" + f.line : ""} ${f.excerpt}`.trim();

/** Why the install button is off, or what it does. */
export function installLabel(s, live) {
  if (!live) return "Sign in with an API key to install";
  if (s.revoked) return "Revoked";
  if (s.level === "dangerous") return "Blocked: scanned as dangerous";
  return s.price_usd > 0 ? `Install for ${formatPrice(s.price_usd)} (90% to the author)` : "Install (free)";
}
