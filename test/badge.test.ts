import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ADMIN, MODELS, startRouter, type Harness } from "./helpers.ts";
import { providers } from "../src/db/schema.ts";
import { badgeFacts, renderBadgeSvg, shareText, type BadgeView } from "../src/api/badge.ts";

// GET /api/v1/badge/{id}.svg: a static badge that says only what the router's own records back. An unknown id, a
// stale attestation or simulated evidence never reads Attested.

const HASH = "0x" + "ab".repeat(32);
const view = (v: Partial<BadgeView> = {}): BadgeView => ({ id: "alpha", kind: "provider", state: "attested", note: null, measurement: "1a2b3c4d", policy: "55555555", share: 0.9987, observedMs: 7 * 86_400_000, complete: true, provider: "alpha", generatedAt: "2026-09-29T12:00:00.000Z", ...v });

describe("rendering", () => {
  test("an attested badge names the measurement, the policy hash and the share, truncated, never rounded up", () => {
    expect(badgeFacts(view())).toEqual(["measure 1a2b3c4d", "policy 55555555", "99.8% of 7 d"]);
    expect(shareText(0.99999)).toBe("99.9%");
    expect(shareText(1)).toBe("100%");
    expect(badgeFacts(view({ policy: null, share: null, measurement: null }))).toEqual(["no policy hash"]);
    expect(badgeFacts(view({ complete: false, observedMs: 30 * 3_600_000 }))).toEqual(["measure 1a2b3c4d", "policy 55555555", "99.8% of 30 h"]);
  });

  test("anything but attested shows no digests, only why", () => {
    expect(badgeFacts(view({ state: "unverified", note: "not listed" }))).toEqual(["not listed"]);
    expect(badgeFacts(view({ state: "policy", note: "no fresh attestation" }))).toEqual(["no fresh attestation"]);
  });

  test("the SVG is self-contained, escaped and uses only the site palette", () => {
    const svg = renderBadgeSvg(view({ id: 'x"><script>alert(1)</script>', state: "unverified", note: "<b>" }));
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<b>");
    expect(svg).not.toMatch(/href|xlink|<image|url\(/);
    const colours = new Set([...renderBadgeSvg(view()).matchAll(/#[0-9a-f]{6}/gi), ...renderBadgeSvg(view(), "dark").matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0].toLowerCase()));
    for (const c of colours) expect(["#f5f5f0", "#0b0c0b", "#5b605a", "#979d96", "#0a7d31", "#1fe15a"]).toContain(c);
    expect(renderBadgeSvg(view(), "dark")).toContain('fill="#0b0c0b"');
    expect(renderBadgeSvg(view())).toContain("Checked by the router, not by your browser.");
  });
});

describe("GET /api/v1/badge/{id}.svg", () => {
  let h: Harness;
  const svg = async (path: string) => {
    const r = await h.request(path);
    return { status: r.status, type: r.headers.get("content-type"), corp: r.headers.get("cross-origin-resource-policy"), body: await r.text() };
  };

  beforeAll(async () => {
    h = await startRouter({
      providers: [
        { id: "alpha", name: "Alpha", models: [MODELS.llama] },
        { id: "beta", name: "Beta", models: [MODELS.llamaPricey] },
        { id: "stale", name: "Stale", models: [MODELS.qwen] },
      ],
    });
    const set = (id: string, v: Partial<typeof providers.$inferInsert>) => h.ctx.db.update(providers).set(v).where(eq(providers.id, id));
    await set("alpha", { teeKind: "tdx", attestationUrl: "https://internal.example/attest", attested: true, attestationHash: HASH, attestedAt: new Date(Date.now() - 60_000) });
    await set("stale", { teeKind: "tdx", attestationUrl: "https://internal.example/attest", attested: true, attestationHash: HASH, attestedAt: new Date(Date.now() - h.ctx.cfg.attestation.intervalMs * 10) });
    const claim = { source: "https://badge.example/terms", as_of: "2025-01-15" };
    for (const id of ["alpha", "stale"]) {
      const put = await h.request(`/api/v1/disclosure/${id}`, { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } });
      expect(put.status).toBe(200);
    }
    await h.ctx.catalog.refresh();
  });
  afterAll(async () => h.close());

  test("a provider with a fresh attestation and attested retention reads Attested, as an embeddable image", async () => {
    const r = await svg("/api/v1/badge/alpha.svg");
    expect(r.status).toBe(200);
    expect(r.type).toContain("image/svg+xml");
    expect(r.corp).toBe("cross-origin");
    expect(r.body).toStartWith("<svg");
    expect(r.body).toContain(">Attested<");
    expect(r.body).toContain("no policy hash"); // nothing bound one, and nothing is made up
  });

  test("a stale attestation is not attested: it falls back to the documented policy and shows no digests", async () => {
    const r = await svg("/api/v1/badge/stale.svg");
    expect(r.status).toBe(200);
    expect(r.body).not.toContain(">Attested<");
    expect(r.body).toContain(">Policy<");
    expect(r.body).toContain("no fresh attestation");
    expect(r.body).not.toMatch(/measure |policy [0-9a-f]{8}/);
  });

  test("a provider with no attestation and no documented policy is vendor-forwarded", async () => {
    expect((await svg("/api/v1/badge/beta.svg")).body).toContain(">Vendor-forwarded<");
  });

  test("a model id reads its strongest endpoint", async () => {
    const r = await svg(`/api/v1/badge/${MODELS.llama.slug}.svg?theme=dark`);
    expect(r.status).toBe(200);
    expect(r.body).toContain(">Attested<");
    expect(r.body).toContain('fill="#0b0c0b"');
    expect((await svg(`/api/v1/badge/${MODELS.qwen.slug}.svg`)).body).toContain(">Policy<"); // served only by the stale provider
  });

  test("an unknown or malformed id is Unverified with a 404, never an error page", async () => {
    for (const path of ["/api/v1/badge/nobody.svg", "/api/v1/badge/%3Cscript%3E.svg", "/api/v1/badge/alpha.png"]) {
      const r = await svg(path);
      expect(r.status).toBe(404);
      expect(r.type).toContain("image/svg+xml");
      expect(r.body).toContain(">Unverified<");
      expect(r.body).not.toContain("<script");
    }
  });

  test("the attestation record names the policy hash only while attested", async () => {
    const a = (await (await h.request("/api/v1/attestation/alpha")).json()).data;
    expect(a).toHaveProperty("policy_hash", null);
    const s = (await (await h.request("/api/v1/attestation/stale")).json()).data;
    expect(s).toMatchObject({ status: "unverified", policy_hash: null });
  });
});
