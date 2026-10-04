// Docs claims check: the public docs must not call a feature live while the router says it is off.
//
// Each capability below names the GET /api/v1/status field (or, where status has none, the config flag) that says
// whether it is on. The check reads the published docs (README.md, WHITEPAPER.md, the /docs page and its sections,
// the homepage roadmap and the changelog; docs/ stays local), finds every clause that mentions a capability, and
// fails when a clause claims it is live (or, in a capability table row or changelog entry, simply lists it) while
// its field is false or absent. A clause that qualifies the claim ("not switched on", "switches on when configured", "switching on",
// "where enabled", "defaults to false", ...) is not a live claim. A clause that calls a feature off while status says it
// is on is reported as a warning, so stale "not switched on yet" copy shows up too.
//
// Usage:
//   bun scripts/docs-claims-check.ts                      offline, against test/fixtures/docs-claims/status.json
//   bun scripts/docs-claims-check.ts --status file.json   against another snapshot ({ data, config })
//   bun scripts/docs-claims-check.ts --live https://api-production-70da.up.railway.app
//                                                         against that router's live GET /api/v1/status, and reports
//                                                         where the fixture has drifted from it
// Exit code 1 when any doc claims a switched-off feature is live (or the live status cannot be read).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type Status = Record<string, any>;
export type Snapshot = { data: Status; config?: Record<string, boolean> };
export type Capability = {
  id: string;
  label: string;
  /** Where the truth lives: a status field path, a job in status.jobs, or a config flag that status does not expose. */
  field: string;
  on: (s: Status, config: Record<string, boolean>) => boolean | undefined;
  /** Text that names the capability. */
  mention: RegExp;
};

const ROOT = resolve(import.meta.dir, "..");
export const FIXTURE = "test/fixtures/docs-claims/status.json";

const get = (s: Status, path: string): unknown => path.split(".").reduce<any>((v, k) => (v == null ? undefined : v[k]), s);
const field = (path: string) => (s: Status) => { const v = get(s, path); return typeof v === "boolean" ? v : undefined; };
/** status.jobs lists the jobs the API process registered; each job used here is registered only when its feature flag is on. */
const job = (name: string) => (s: Status) => (Array.isArray(s.jobs) ? s.jobs.some((j: any) => j?.name === name) : undefined);
const flag = (name: string) => (_: Status, config: Record<string, boolean>) => (typeof config[name] === "boolean" ? config[name] : undefined);

export const CAPABILITIES: Capability[] = [
  { id: "agent-guard", label: "Agent Guard", field: "agent_guard.enabled", on: field("agent_guard.enabled"), mention: /\bagent guard\b/i },
  { id: "x402", label: "x402 per-call payments", field: "per_call.x402.configured", on: field("per_call.x402.configured"), mention: /\bx402\b(?! (?:facilitator|tools?)\b)/i },
  { id: "facilitator", label: "hosted x402 facilitator", field: "facilitator.enabled", on: field("facilitator.enabled"), mention: /\bfacilitator\b/i },
  { id: "tools", label: "paying x402 tools from a balance", field: "tools.ready", on: field("tools.ready"), mention: /\bx402 tools?\b|\btool market\b|\bpaid tools?\b/i },
  { id: "commerce", label: "commerce ledger", field: "commerce.enabled", on: field("commerce.enabled"), mention: /\bcommerce ledger\b/i },
  { id: "makegood", label: "make-good refunds", field: "makegood.enabled", on: field("makegood.enabled"), mention: /\bmake-good refunds?\b|\brefunds? by rule\b/i },
  { id: "per-call", label: "per-call payment (CallPay or x402)", field: "per_call.configured", on: field("per_call.configured"), mention: /\bper[- ]call (?:payments?|pay)\b|\bCallPay\b/i },
  { id: "paywith", label: "Stock Token pay-with sessions", field: "paywith.configured", on: field("paywith.configured"), mention: /\bpay[- ]with (?:a )?Stock Tokens?\b|\bStock Token pay-with\b|\bPayWithStock\b/i },
  { id: "escrow", label: "Stock Token escrow deposits", field: "escrow.enabled", on: field("escrow.enabled"), mention: /\bescrow deposits?\b|\bStock Token escrow\b/i },
  {
    // Routers from before the agreements status section show it only through the registered agreement-indexer job.
    id: "agreements", label: "agent agreements (API, MCP tools, indexing)", field: "agreements.enabled", on: (s) => (s.agreements && typeof s.agreements === "object" ? field("agreements.enabled")(s) : job("agreement-indexer")(s)),
    mention: /\bagent agreements?\b|\bagreements? between agents\b|\bagreements? (?:contracts?|service|API|endpoints?|tools?|events?|tab)\b|\bagreements (?:are|is)\b|\bagreement system\b|\bAgreementEscrow\b/i,
  },
  { id: "rulings", label: "automatic agreement jury rulings", field: "agreements.rulings.enabled (a fresh heartbeat from the isolated jury worker)", on: field("agreements.rulings.enabled"), mention: /\brulings?\b|\bruled\b|\bjury\b/i },
  { id: "hosts", label: "network open to hosts", field: "network.hosts_open", on: field("network.hosts_open"), mention: /\bopen for (?:early )?hosts\b|\bnetwork is open\b/i },
  { id: "payouts", label: "network host payouts", field: "network.payouts_open", on: field("network.payouts_open"), mention: /\bpayouts?\b(?!\s+(?:address|information|wallet))/i },
  { id: "fee-burn", label: "network-fee purchase and burn of $ANYR", field: "jobs[network-fee-burn]", on: job("network-fee-burn"), mention: /\bfee[- ]burn\b|\bbuy[- ]and[- ]burn\b|\bpurchase and burn\b/i },
  { id: "slashing", label: "host-bond slashing", field: "config NETWORK_SLASHING_ENABLED (not in status)", on: flag("NETWORK_SLASHING_ENABLED"), mention: /\bslashing\b/i },
  { id: "email-alerts", label: "email alerts", field: "none: not part of the hosted service", on: () => undefined, mention: /\bemail alerts?\b/i },
  { id: "sdk-registries", label: "SDK releases on npm and PyPI", field: "none: packages are not published", on: () => undefined, mention: /\bSDK releases?\b|\bon npm\b|\bon PyPI\b/i },
  { id: "onion", label: "Tor onion access", field: "onion", on: (s) => (s.onion === undefined ? undefined : s.onion !== null), mention: /\bonion\b/i },
  { id: "unlinkable", label: "unlinkable lane", field: "lanes.unlinkable.available", on: field("lanes.unlinkable.available"), mention: /\bunlinkable\b/i },
  { id: "attested", label: "attested lane", field: "lanes.attested.available", on: field("lanes.attested.available"), mention: /\battested (?:lane|serving)\b/i },
  { id: "blind-tokens", label: "blind tokens", field: "jobs[blind-key-rotation]", on: job("blind-key-rotation"), mention: /\bblind[- ]tokens?\b/i },
  { id: "key-log", label: "key transparency log", field: "jobs[tlog]", on: job("tlog"), mention: /\bkey transparency\b|\btransparency log\b|\bkey log\b/i },
  { id: "holders", label: "$ANYR holder tiers", field: "holders.enabled", on: field("holders.enabled"), mention: /\bholder tiers?\b/i },
  { id: "rulebook", label: "agent rulebook", field: "jobs[agent-alerts] (AGENT_POLICY_ENABLED)", on: job("agent-alerts"), mention: /\brulebooks?\b/i },
  { id: "webhooks", label: "signed webhooks", field: "jobs[webhooks] (WEBHOOK_SIGNING_ENABLED)", on: job("webhooks"), mention: /\bsigned webhooks?\b|\bwebhook signing\b/i },
  { id: "bond-index", label: "host bond indexing", field: "jobs[host-bond-indexer]", on: job("host-bond-indexer"), mention: /\bbond index(?:ing|ed)?\b|\blive bonds\b/i },
  { id: "sanctions", label: "sanctions screening", field: "jobs[sanctions-refresh]", on: job("sanctions-refresh"), mention: /\bsanctions screening\b/i },
  { id: "host-anchor", label: "per-host receipt anchoring", field: "jobs[host-anchor]", on: job("host-anchor"), mention: /\bper-host receipt anchoring\b|\banchored per host\b/i },
  { id: "onchain-anchor", label: "receipt roots anchored on chain", field: "chain.contracts.receiptAnchor", on: (s) => { const c = get(s, "chain.contracts"); return c && typeof c === "object" ? !!(c as Record<string, unknown>).receiptAnchor : undefined; }, mention: /\banchored on[- ]chain\b|\banchored on chain \d+\b|\bon-chain anchor(?:ing|ed)?\b/i },
  { id: "batches", label: "Batch API", field: "jobs[batches]", on: job("batches"), mention: /\bBatch API\b/i },
];

/** Words that make a clause a claim that something is on now. */
const LIVE = /\blive\b(?! in (?:src|packages|web|contracts|the repository)\b)|\b(?:switched on|turned on|is on|are on|now on|enabled|available|open for)\b|\banchored on[- ]chain\b|\banchored on chain \d+\b/i;
/** Words that qualify a clause, so it is not a claim that the feature is on now. */
const QUALIFIED = /\bnot\b|n['’]t\b|\bnever\b|\bno\b|\bnone\b|\bwhen\b|\bwhere(?:ver)?\b|\bonce\b|\bif\b|\bunless\b|\buntil\b|\bonly\b|\bswitch(?:es|ing)? on\b|\bdefaults? (?:to )?false\b|\boff\b|\bplanned\b|\bnext\b|\b(?:is|are) built\b|\bbuilt\b(?! and live)|\bawait|\boptional\b|\bself-host|\brequires?\b|\breported as\b/i;
/** A changelog entry that says anywhere that it is not on yet lists nothing as on; its clauses are judged as prose. */
const ENTRY_QUALIFIED = /\bnot (?:yet )?switched on\b|\bnot switched on\b|\boff until\b|\boff by default\b|\bswitch(?:es)? on when\b|\buntil an operator\b/i;
/** Words that say a feature is off now; with status on they are stale. */
const OFF = /\bnot (?:yet )?(?:switched on|live|deployed|on)\b|\b(?:is|are)n['’]t (?:live|on|switched on)\b|^Next(?: are)?:?\s|\bNext are\b/i;

export type Source = { path: string; kind: "markdown" | "jsx" | "changelog" };
export type Clause = { file: string; line: number; text: string; implicit: boolean };
export type Finding = { level: "fail" | "warn"; capability: Capability; value: boolean | undefined; clause: Clause };

export function defaultSources(root = ROOT): Source[] {
  const components = readdirSync(resolve(root, "web/components")).filter((n) => /Docs\.jsx$|^DocsFeatureIndex\.jsx$/.test(n)).sort().map((n): Source => ({ path: `web/components/${n}`, kind: "jsx" }));
  const sources: Source[] = [
    { path: "README.md", kind: "markdown" },
    { path: "WHITEPAPER.md", kind: "markdown" },
    { path: "web/app/docs/page.jsx", kind: "jsx" },
    ...components,
    { path: "web/components/Extensions.jsx", kind: "jsx" },
    { path: "web/lib/changelog-data.js", kind: "changelog" },
  ];
  return sources.filter((s) => existsSync(resolve(root, s.path)));
}

const ENTITIES: Record<string, string> = { "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">", "&apos;": "'", "&#123;": "{", "&#125;": "}", "&nbsp;": " " };
const plain = (s: string) => s.replace(/<\/(?:h[1-6]|p|li|td|th|dt|dd|summary|caption|figcaption|div|section|article)>/g, "\n").replace(/<[^>]*>/g, " ").replace(/&(?:quot|amp|lt|gt|apos|nbsp|#123|#125);/g, (e) => ENTITIES[e] ?? e).replace(/\{['"`] ?['"`]\}/g, " ");
// A run of links that ends a cell after a full stop is a list of references, not part of a claim.
const references = (s: string) => s.replace(/(^|[.!?]\s+)((?:!?\[[^\]]*\]\([^)]*\)\s*(?:·\s*)?)+)\.?\s*(\|?\s*)$/, "$1$3");
// Inline code names fields, paths and addresses; it is never itself a claim.
const markdown = (s: string) => references(s).replace(/`[^`]*`/g, "(code)").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__/g, "");

/** Sentences, then clauses split at semicolons and ", but": each is judged on its own. */
export function clauses(text: string): string[] {
  return text
    .split(/\n|(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
    .flatMap((s) => s.split(/;\s+|,\s+but\s+/))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export async function extract(source: Source, root = ROOT): Promise<Clause[]> {
  const abs = resolve(root, source.path);
  if (source.kind === "changelog") {
    const raw = readFileSync(abs, "utf8");
    const entries = (await import(pathToFileURL(abs).href)).default as { id: string; title: string; summary: string }[];
    return entries.flatMap((e) => {
      const line = raw.split("\n").findIndex((l) => l.includes(`"id": "${e.id}"`)) + 1;
      // A changelog entry says it shipped, so anything it names is listed as on, unless the entry says it is not on yet.
      const text = `${e.title}. ${e.summary}`, implicit = !ENTRY_QUALIFIED.test(text);
      return clauses(text).map((c) => ({ file: `${source.path}#${e.id}`, line, text: c, implicit }));
    });
  }
  const out: Clause[] = [];
  let fenced = false;
  readFileSync(abs, "utf8").split("\n").forEach((raw, i) => {
    if (source.kind === "markdown" && /^\s*```/.test(raw)) { fenced = !fenced; return; }
    if (fenced) return;
    // A capability table row (bold first cell, as in the README) lists what you can use today.
    const implicit = source.kind === "markdown" && /^\|\s*\*\*/.test(raw);
    const text = source.kind === "markdown" ? markdown(raw) : plain(raw);
    for (const cell of implicit ? text.split("|").slice(2) : [text]) for (const c of clauses(cell)) out.push({ file: source.path, line: i + 1, text: c, implicit });
  });
  return out;
}

export function judge(clause: Clause, snapshot: Snapshot): Finding[] {
  const findings: Finding[] = [];
  const qualified = QUALIFIED.test(clause.text);
  const live = (clause.implicit || LIVE.test(clause.text)) && !qualified;
  const off = OFF.test(clause.text);
  for (const capability of CAPABILITIES) {
    if (!capability.mention.test(clause.text)) continue;
    const value = capability.on(snapshot.data, snapshot.config ?? {});
    if (live && value !== true) findings.push({ level: "fail", capability, value, clause });
    else if (off && value === true) findings.push({ level: "warn", capability, value, clause });
  }
  return findings;
}

export async function check(snapshot: Snapshot, sources = defaultSources(), root = ROOT) {
  const findings: Finding[] = [];
  let count = 0;
  for (const source of sources) for (const clause of await extract(source, root)) { count++; findings.push(...judge(clause, snapshot)); }
  return { findings, clauses: count, sources: sources.length };
}

export async function liveSnapshot(origin: string, fetcher: typeof fetch = fetch): Promise<Snapshot> {
  const url = new URL("/api/v1/status", origin);
  const res = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
  const body = (await res.json()) as { data?: Status };
  if (!body?.data || typeof body.data !== "object") throw new Error(`GET ${url} returned no data object`);
  return { data: body.data };
}

/** Capabilities whose value differs between two snapshots (fixture vs live). */
export function drift(a: Snapshot, b: Snapshot) {
  return CAPABILITIES.flatMap((c) => {
    const x = c.on(a.data, a.config ?? {}), y = c.on(b.data, b.config ?? {});
    return x === y ? [] : [{ capability: c, fixture: x, live: y }];
  });
}

const show = (v: boolean | undefined) => (v === undefined ? "absent" : String(v));

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const fixturePath = resolve(ROOT, opt("--status") ?? FIXTURE);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Snapshot;
  const origin = opt("--live");
  let snapshot = fixture, against = relative(ROOT, fixturePath);
  if (origin) {
    try {
      // Config flags that status does not expose are taken from the fixture, which is reviewed with the docs.
      snapshot = { ...(await liveSnapshot(origin)), config: fixture.config };
      against = `${new URL("/api/v1/status", origin)}`;
    } catch (e) {
      console.error(`docs-claims-check: ${(e as Error).message}`);
      process.exit(1);
    }
  }
  const { findings, clauses: count, sources } = await check(snapshot);
  const fails = findings.filter((f) => f.level === "fail"), warns = findings.filter((f) => f.level === "warn");
  for (const f of findings) {
    const where = `${f.clause.file}:${f.clause.line}`;
    const what = f.level === "fail" ? `claims ${f.capability.label} is on` : `says ${f.capability.label} is off`;
    console.log(`${f.level === "fail" ? "FAIL" : "warn"} ${where} ${what}, but ${f.capability.field} is ${show(f.value)}\n     “${f.clause.text.slice(0, 220)}”`);
  }
  if (origin) for (const d of drift(fixture, snapshot)) console.log(`note fixture ${FIXTURE} has ${d.capability.field} = ${show(d.fixture)}, live has ${show(d.live)}; update the fixture with the docs`);
  console.log(`docs-claims-check: ${count} clauses in ${sources} files against ${against}: ${fails.length} false live claims, ${warns.length} stale "off" claims`);
  process.exit(fails.length ? 1 : 0);
}
