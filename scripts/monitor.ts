// Read-only probe for monitoring agents (on a laptop, phone shortcut, cron or uptime checker).
// It only GETs public endpoints: /health, /ready, /api/v1/escrow and, when reachable, /ready/metrics.
// No credentials, no writes, no side effects. The base URL is never echoed.
// Usage: bun scripts/monitor.ts <baseUrl> [--watch <seconds>] [--timeout <seconds>]
// Prints one JSON line per probe: { ok, at, failing: [...], checks: {...}, escrow?, metrics? }
// Exit codes: 0 every check passes, 1 at least one check fails, 2 unreachable (or invalid usage).

export type ProbeResult = {
  ok: boolean;
  at: string;
  failing: string[];
  checks: Record<string, boolean>;
  escrow?: { enabled: boolean; tokens?: number; stale_prices?: string[] };
  metrics?: { reachable: boolean; ready?: boolean };
};
export type ProbeOptions = { timeoutMs?: number; fetch?: typeof fetch; now?: () => Date };

const CHECK = /^[a-z][a-z0-9_-]{0,63}$/;
const SYMBOL = /^[A-Za-z0-9._-]{1,16}$/;

export function normalizeBase(input: string | undefined) {
  if (!input) return null;
  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/+$/, "");
  } catch { return null; }
}

async function get(url: string, opts: ProbeOptions) {
  try {
    const response = await (opts.fetch ?? fetch)(url, { method: "GET", headers: { accept: "application/json, text/plain" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    return { status: response.status, text: (await response.text()).slice(0, 1_000_000) };
  } catch { return null; }
}
function json(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

export async function probe(base: string, opts: ProbeOptions = {}): Promise<{ code: 0 | 1 | 2; result: ProbeResult }> {
  const at = (opts.now?.() ?? new Date()).toISOString();
  const checks: Record<string, boolean> = {};
  const health = await get(`${base}/health`, opts);
  if (!health) return { code: 2, result: { ok: false, at, failing: ["health"], checks: { health: false } } };
  checks.health = health.status === 200 && json(health.text)?.ok === true;

  const ready = await get(`${base}/ready`, opts);
  const readyBody = ready && (ready.status === 200 || ready.status === 503) ? json(ready.text) : null;
  checks.ready = !!readyBody && ready!.status === 200 && readyBody.ok === true;
  if (readyBody && typeof readyBody.checks === "object" && readyBody.checks)
    for (const [name, value] of Object.entries(readyBody.checks as Record<string, unknown>)) {
      const key = `ready.${CHECK.test(name) ? name : "unnamed_check"}`;
      checks[key] = (checks[key] ?? true) && value === true;
    }

  const result: ProbeResult = { ok: false, at, failing: [], checks };
  const escrow = await get(`${base}/api/v1/escrow`, opts);
  const data = escrow?.status === 200 ? json(escrow.text)?.data : null;
  if (!data || typeof data.enabled !== "boolean") checks.escrow = false;
  else if (!data.enabled) result.escrow = { enabled: false };
  else {
    const tokens: { symbol?: unknown; price_usd?: unknown }[] = Array.isArray(data.tokens) ? data.tokens : [];
    const stale = tokens.filter((t) => typeof t.price_usd !== "number" || !(t.price_usd > 0)).map((t) => (typeof t.symbol === "string" && SYMBOL.test(t.symbol) ? t.symbol : "unknown"));
    checks["escrow.tokens"] = tokens.length > 0;
    checks["escrow.prices"] = stale.length === 0;
    result.escrow = { enabled: true, tokens: tokens.length, stale_prices: stale };
  }

  // Optional: some proxies do not expose it. Informational only, never a failing check.
  const metrics = await get(`${base}/ready/metrics`, opts);
  const readyGauge = metrics?.status === 200 ? /^anyroute_ready\s+([01])\s*$/m.exec(metrics.text) : null;
  result.metrics = readyGauge ? { reachable: true, ready: readyGauge[1] === "1" } : { reachable: false };

  result.failing = Object.keys(checks).filter((k) => !checks[k]).sort();
  result.ok = result.failing.length === 0;
  return { code: result.ok ? 0 : 1, result };
}

function parseArgs(argv: string[]) {
  let base: string | undefined, watch: number | undefined, timeout = 10;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--watch") watch = Number(argv[++i]);
    else if (arg === "--timeout") timeout = Number(argv[++i]);
    else if (!base && !arg.startsWith("--")) base = arg;
    else return null;
  }
  const normalized = normalizeBase(base);
  if (!normalized || (watch !== undefined && !(watch >= 1)) || !(timeout >= 1 && timeout <= 60)) return null;
  return { base: normalized, watch, timeoutMs: timeout * 1000 };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("Usage: bun scripts/monitor.ts <https://your-domain> [--watch <seconds>] [--timeout <seconds>]");
    process.exit(2);
  }
  let last: 0 | 1 | 2 = 2;
  process.on("SIGINT", () => process.exit(last));
  process.on("SIGTERM", () => process.exit(last));
  for (;;) {
    const { code, result } = await probe(args.base, { timeoutMs: args.timeoutMs });
    last = code;
    console.log(JSON.stringify(result));
    if (args.watch === undefined) process.exit(code);
    await Bun.sleep(args.watch * 1000);
  }
}
