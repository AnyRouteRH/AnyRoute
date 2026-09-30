import type { Hono, Context } from "hono";
import { and, eq, sql, asc } from "drizzle-orm";
import { createHmac, randomBytes, randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { addressBucket } from "../api/common.ts";
import { fail, ApiError } from "../lib/errors.ts";
import { networkWaitlist } from "./schema.ts";

export const ROLES = ["host_gpu", "host_cpu", "relay", "witness", "developer"] as const;
export const REGIONS = ["africa", "antarctica", "asia", "europe", "north_america", "oceania", "south_america"] as const;
export const waitlistInput = z.strictObject({
  role: z.enum(ROLES), hardware: z.string().max(200), readiness: z.string().max(300).default(""),
  region: z.enum(REGIONS), contact: z.string().max(120).optional(),
  paid_in: z.enum(["usdg", "anyr", "any"]), website: z.string().max(200).default(""),
});
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const BASE = "/api/v1/network/waitlist";

// Read at most 4 KiB even without Content-Length. Never include body text in errors or logs.
async function body(c: Context): Promise<unknown> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) fail(400, "JSON body required.");
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) { await reader.cancel(); fail(413, "Waitlist body exceeds 4 KiB."); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(400, "Valid UTF-8 JSON required.");
  } finally { reader.releaseLock(); }
  try { return JSON.parse(text); } catch { fail(400, "Valid JSON required."); }
}

async function limited(c: Context, ctx: Ctx) {
  const from = addressBucket(c, ctx.cfg);
  // Secret-keyed digest rotates each minute; the raw address never enters storage or logs.
  const bucket = from.onion ? "onion" : createHmac("sha256", ctx.cfg.appSecret).update(`network:${Math.floor(Date.now() / 60_000)}:${from.id}`).digest("hex");
  const result = await ctx.limiter.take(`network-waitlist:${bucket}`, 1, from.scale(10), 60_000);
  if (!result.ok) { c.header("retry-after", String(Math.ceil(result.retryAfterMs / 1000))); fail(429, "Too many waitlist requests. Try again later."); }
}

// Read-only owner export. Pagination avoids returning the entire list in one response.
export async function exportWaitlist(ctx: Pick<Ctx, "db">, input: { after?: string; limit: number }) {
  return ctx.db.select().from(networkWaitlist).where(input.after ? sql`${networkWaitlist.id} > ${input.after}` : sql`true`).orderBy(asc(networkWaitlist.id)).limit(input.limit);
}

export function networkRoutes(app: Hono, ctx: Ctx) {
  app.use(`${BASE}*`, async (c, next) => { c.header("cache-control", "no-store"); await next(); });
  app.post(BASE, async (c) => {
    await limited(c, ctx);
    const raw = await body(c);
    // Discard filled honeypots even if the other fields are malformed; never explain the rejection.
    if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).website === "string" && (raw as Record<string, unknown>).website !== "") return c.json({ id: randomUUID(), delete_code: randomBytes(32).toString("hex") });
    const parsed = waitlistInput.safeParse(raw);
    if (!parsed.success) fail(400, "Invalid waitlist fields.");
    const spec = parsed.data;
    const id = randomUUID();
    const delete_code = randomBytes(32).toString("hex");
    try {
      await ctx.db.insert(networkWaitlist).values({ id, role: spec.role, hardware: spec.hardware, readiness: spec.readiness, region: spec.region, contact: spec.contact?.trim() ? spec.contact : null, paidIn: spec.paid_in, deleteCodeHash: digest(delete_code) });
    } catch { fail(503, "Waitlist unavailable. Try again later."); }
    return c.json({ id, delete_code });
  });
  app.delete(`${BASE}/:id`, async (c) => {
    await limited(c, ctx);
    const id = z.uuid().safeParse(c.req.param("id"));
    const code = z.strictObject({ delete_code: z.string().regex(/^[0-9a-f]{64}$/) }).safeParse(await body(c));
    if (!id.success || !code.success) fail(400, "Valid id and delete code required.");
    try {
      const deleted = await ctx.db.delete(networkWaitlist).where(and(eq(networkWaitlist.id, id.data), eq(networkWaitlist.deleteCodeHash, digest(code.data.delete_code)))).returning({ id: networkWaitlist.id });
      if (!deleted.length) return c.json({ deleted: false }, 404);
    } catch { fail(503, "Waitlist unavailable. Try again later."); }
    return c.json({ deleted: true });
  });
  app.get(`${BASE}/stats`, async (c) => {
    try {
      // SQL returns only counts. Readiness is self-reported, never attestation or eligibility.
      const roles = await ctx.db.select({ role: networkWaitlist.role, count: sql<number>`count(*)::int` }).from(networkWaitlist).groupBy(networkWaitlist.role);
      const regions = await ctx.db.select({ region: networkWaitlist.region, count: sql<number>`count(*)::int` }).from(networkWaitlist).groupBy(networkWaitlist.region);
      const [totals] = await ctx.db.select({ total: sql<number>`count(*)::int`, readiness_mentions: sql<number>`count(*) filter (where ${networkWaitlist.readiness} ~* '(TDX|SEV[ -]?SNP|GPU[ -]?CC)')::int` }).from(networkWaitlist);
      return c.json({ ...totals, by_role: Object.fromEntries(ROLES.map((r) => [r, roles.find((x) => x.role === r)?.count ?? 0])), by_region: Object.fromEntries(REGIONS.map((r) => [r, regions.find((x) => x.region === r)?.count ?? 0])) });
    } catch { fail(503, "Waitlist counts unavailable."); }
  });
}
