import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import type { ProviderRow } from "../catalog/catalog.ts";
import { buildSummary } from "../services/attestation-events.ts";
import { disclosureView, servedDisclosure, servedPolicyHash } from "./disclosure.ts";
import { modelJson, servable } from "./models.ts";

// GET /api/v1/badge/{provider id or model id}.svg[?theme=light|dark]
// A static attestation badge for an <img> tag: the status a prompt is served under right now (attested, policy,
// vendor-forwarded or unverified), the measurement and policy hash the router verified, and the share of the last
// 7 days in which it held a fresh attestation. Every value is the router's own record; anything it cannot back is left
// off, and an unknown id reads Unverified. The image cannot check anything in the viewer's browser: the script badge
// (/badge.js) does that.

export type BadgeState = "attested" | "policy" | "vendor-forwarded" | "unverified";
export type BadgeView = {
  id: string;
  kind: "provider" | "model" | "unknown";
  state: BadgeState;
  /** Why an endpoint is unverified, in a few words. */
  note: string | null;
  /** First 8 hex characters of the measured compose hash (or image digest) the router verified, while attested. */
  measurement: string | null;
  /** First 8 hex characters of the classifier policy hash the fresh attestation bound, while attested. */
  policy: string | null;
  /** Share (0..1) of the observed part of the last 7 days with a fresh attestation, and how long that part is. */
  share: number | null;
  observedMs: number;
  complete: boolean;
  /** The provider whose record backs the badge (for a model, its strongest attested endpoint). */
  provider: string | null;
  generatedAt: string;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const HEX = /^(?:sha256:|0x)?([0-9a-f]{8})[0-9a-f]*$/i;
const MIN_OBSERVED_MS = 3_600_000;
const short = (v: unknown) => (typeof v === "string" && HEX.test(v) ? HEX.exec(v)![1].toLowerCase() : null);

type SummaryEntry = { provider: string; status: string; measurement: { digests: Record<string, string> | null } | null; fresh: Record<string, { share: number | null; observed_ms: number; history_complete: boolean }> };

// The summary is the same work GET /api/v1/attestation/summary does; a badge on a busy page must not repeat it per view.
const cache = new WeakMap<Ctx, { at: number; data: Promise<Map<string, SummaryEntry>> }>();
function summaryByProvider(ctx: Ctx): Promise<Map<string, SummaryEntry>> {
  if (ctx.cfg.attestation.historyDays <= 0) return Promise.resolve(new Map());
  const hit = cache.get(ctx);
  if (hit && Date.now() - hit.at < 30_000) return hit.data;
  const data = buildSummary(ctx).then((s) => new Map((s.providers as unknown as SummaryEntry[]).map((p) => [p.provider, p])));
  data.catch(() => cache.delete(ctx));
  cache.set(ctx, { at: Date.now(), data });
  return data;
}

function fromSummary(entry: SummaryEntry | undefined, attested: boolean) {
  const w = entry?.fresh?.["7d"];
  const observed = typeof w?.observed_ms === "number" ? w.observed_ms : 0;
  const d = entry?.measurement?.digests ?? null;
  return {
    measurement: attested && entry?.status === "attested" && d ? short(d.compose_hash) ?? short(d.image_digest) ?? short(d.model_digest) : null,
    share: typeof w?.share === "number" && observed >= MIN_OBSERVED_MS ? w.share : null,
    observedMs: observed,
    complete: !!w?.history_complete,
  };
}

const unknown = (id: string, note: string): BadgeView => ({ id, kind: "unknown", state: "unverified", note, measurement: null, policy: null, share: null, observedMs: 0, complete: false, provider: null, generatedAt: new Date().toISOString() });

/** What the badge for a provider id or model id says, from the router's own records only. */
export async function badgeView(ctx: Ctx, id: string): Promise<BadgeView> {
  if (!ID.test(id)) return unknown(id.slice(0, 60), "not listed");
  await ctx.catalog.ensureFresh();
  const p = ctx.catalog.providers.get(id);
  if (p && (p.status === "live" || p.status === "shadow")) return providerView(ctx, p, await summaryByProvider(ctx));
  const r = ctx.catalog.resolve(id);
  if (r && !r.model.hidden) {
    const offers = servable(ctx, r.model);
    if (!offers.length) return unknown(r.model.id, "not served now");
    const a = modelJson(ctx, r.model).attestation;
    // The endpoint the model's attestation object describes: attested, not simulated, with the policy hash it reports.
    const ref = offers
      .map((o) => ({ o, d: servedDisclosure(ctx, o), policy: servedPolicyHash(ctx, o) }))
      .filter((x) => x.d.class === "attested" && !x.d.simulated)
      .sort((x, y) => Number(y.policy === a?.policy_hash) - Number(x.policy === a?.policy_hash) || x.o.providerId.localeCompare(y.o.providerId))[0];
    const best = a?.best ?? "vendor-forwarded";
    const state: BadgeState = best === "attested" ? (ref ? "attested" : "unverified") : best;
    const s = fromSummary(ref ? (await summaryByProvider(ctx)).get(ref.o.providerId) : undefined, state === "attested");
    return {
      id: r.model.id,
      kind: "model",
      state,
      note: state === "unverified" ? "simulated evidence" : state === "attested" ? null : "no fresh attestation",
      ...s,
      policy: state === "attested" && ref && ref.policy === a?.policy_hash ? short(ref.policy) : null,
      provider: ref?.o.providerId ?? null,
      generatedAt: new Date().toISOString(),
    };
  }
  return unknown(id, "not listed");
}

function providerView(ctx: Ctx, p: ProviderRow, summary: Map<string, SummaryEntry>): BadgeView {
  const cur = disclosureView(ctx, p).current;
  const state: BadgeState = cur.simulated ? "unverified" : cur.class;
  const s = fromSummary(summary.get(p.id), state === "attested");
  return {
    id: p.id,
    kind: "provider",
    state,
    note: cur.simulated ? "simulated evidence" : state === "attested" ? null : cur.attestation_fresh ? "attested, retention not declared" : "no fresh attestation",
    ...s,
    policy: state === "attested" ? short(servedPolicyHash(ctx, { provider: p })) : null,
    provider: p.id,
    generatedAt: new Date().toISOString(),
  };
}

// ---- rendering ----------------------------------------------------------------------------------------------------

export const BADGE_LABEL: Record<BadgeState, string> = { attested: "Attested", policy: "Policy", "vendor-forwarded": "Vendor-forwarded", unverified: "Unverified" };
const MEANING: Record<BadgeState, string> = {
  attested: "The router holds a fresh hardware attestation it verified itself, and the provider declares attested retention.",
  policy: "No fresh attestation. The provider documents a no-retention policy with no legal hold. Not verified.",
  "vendor-forwarded": "No fresh attestation or documented policy. The prompt reaches a vendor that may log it.",
  unverified: "The router has nothing current that it verified for this endpoint.",
};

// Ink, paper, the signal green and the greys of the site (web/app/globals.css). Nothing else.
const THEMES = {
  light: { bg: "#f5f5f0", fg: "#0b0c0b", muted: "#5b605a", signal: "#0a7d31" },
  dark: { bg: "#0b0c0b", fg: "#f5f5f0", muted: "#979d96", signal: "#1fe15a" },
} as const;
export type BadgeTheme = keyof typeof THEMES;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** "99.8%": truncated to one decimal, so only a full share reads 100%. */
export function shareText(share: number) {
  const tenth = Math.floor(Math.min(1, Math.max(0, share)) * 1000 + 1e-9) / 10;
  return `${Number.isInteger(tenth) ? tenth : tenth.toFixed(1)}%`;
}
const span = (ms: number) => (ms >= 48 * 3_600_000 ? `${Math.floor(ms / 86_400_000)} d` : `${Math.floor(ms / 3_600_000)} h`);

/** The second line: what the router verified, or why there is nothing to show. */
export function badgeFacts(v: BadgeView): string[] {
  if (v.state !== "attested") return [v.note ?? "no fresh attestation"];
  const out: string[] = [];
  if (v.measurement) out.push(`measure ${v.measurement}`);
  out.push(v.policy ? `policy ${v.policy}` : "no policy hash");
  if (v.share !== null) out.push(`${shareText(v.share)} of ${v.complete ? "7 d" : span(v.observedMs)}`);
  return out;
}

/** The badge as a self-contained SVG: a colour field and type, no script, no external reference. */
export function renderBadgeSvg(v: BadgeView, theme: BadgeTheme = "light"): string {
  const t = THEMES[theme] ?? THEMES.light;
  const label = BADGE_LABEL[v.state];
  const id = v.id.length > 48 ? v.id.slice(0, 47) + "…" : v.id;
  const facts = badgeFacts(v).join("  ·  ");
  // Widths are estimated generously for the fallback fonts (sans 13px about 7.6px a glyph, mono 10px about 6.6px).
  const line1 = 30 + label.length * 7.8 + 10 + id.length * 6.6 + 24 + 8 * 6.2;
  const line2 = 14 + facts.length * 6.4;
  const w = Math.ceil(Math.max(200, line1, line2) + 14);
  const h = 48;
  const mark =
    v.state === "attested"
      ? `<rect x="14" y="13" width="9" height="9" fill="${t.signal}"/>`
      : v.state === "policy"
        ? `<rect x="14" y="13" width="9" height="9" fill="${t.muted}"/>`
        : `<rect x="14.75" y="13.75" width="7.5" height="7.5" fill="none" stroke="${t.muted}" stroke-width="1.5"/>`;
  const title = `Anyroute: ${v.id} is ${label}. ${MEANING[v.state]}${v.state === "attested" ? " Checked by the router, not by your browser." : ""} As of ${v.generatedAt}.`;
  const sans = `'Host Grotesk Variable','Host Grotesk',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif`;
  const mono = `'Martian Mono Variable','Martian Mono',ui-monospace,SFMono-Regular,Menlo,monospace`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">` +
    `<title>${esc(title)}</title>` +
    `<rect width="${w}" height="${h}" fill="${t.bg}"/>` +
    mark +
    `<text x="30" y="22" fill="${t.fg}" font-family="${sans}" font-size="13" font-weight="620" letter-spacing="-0.2">${esc(label)}` +
    `<tspan dx="10" fill="${t.muted}" font-family="${mono}" font-size="10" font-weight="400" letter-spacing="0">${esc(id)}</tspan></text>` +
    `<text x="${w - 14}" y="21" text-anchor="end" fill="${t.muted}" font-family="${mono}" font-size="8" letter-spacing="0.9">ANYROUTE</text>` +
    `<text x="14" y="37" fill="${t.muted}" font-family="${mono}" font-size="9.5">${esc(facts)}</text>` +
    `</svg>`
  );
}

export function badgeRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/badge/*", async (c) => {
    const raw = c.req.path.slice("/api/v1/badge/".length);
    let id = "";
    try {
      id = decodeURIComponent(raw);
    } catch {
      id = "";
    }
    const theme: BadgeTheme = c.req.query("theme") === "dark" ? "dark" : "light";
    const view = id.endsWith(".svg") ? await badgeView(ctx, id.slice(0, -4)) : unknown(id.slice(0, 60), "not listed");
    c.header("Content-Type", "image/svg+xml; charset=utf-8");
    c.header("Cache-Control", "public, max-age=60");
    c.header("Cross-Origin-Resource-Policy", "cross-origin");
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    return c.body(renderBadgeSvg(view, theme), view.kind === "unknown" && view.note === "not listed" ? 404 : 200);
  });
}
