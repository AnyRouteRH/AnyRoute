import { and, count, desc, eq, lt, sql } from "drizzle-orm";
import { getAddress, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { ApiError, fail, isApiError } from "../lib/errors.ts";
import { uid } from "../lib/util.ts";
import { assertNotSanctioned } from "../network/sanctions.ts";
import { facilitatorSellers } from "./schema.ts";
import { caip2 } from "./verify.ts";

// Seller listings and discovery. A seller opts in by signing its listing (resource URL, price hint, output schema, tags)
// with its payTo key, EIP-712 below; the facilitator screens that payTo against the sanctions list and lists it in a
// Bazaar-shaped index. A listing is a hint: the resource's own 402 response stays authoritative for price and payTo.

export const LISTING_TYPES = {
  SellerListing: [
    { name: "payTo", type: "address" },
    { name: "resource", type: "string" },
    { name: "priceHint", type: "uint256" },
    { name: "outputSchema", type: "string" },
    { name: "tags", type: "string[]" },
    { name: "listed", type: "bool" },
    { name: "issuedAt", type: "uint256" },
  ],
} as const;
export const listingDomain = (chainId: number) => ({ name: "Anyroute Facilitator", version: "1", chainId });

/** How long a listing signature stays acceptable around its issuedAt (seconds). */
export const LISTING_SKEW_S = 600;
const MAX_SCHEMA = 16_384;

export type Listing = { payTo: Hex; resource: string; priceHint: bigint; outputSchema: string; tags: string[]; listed: boolean; issuedAt: bigint; signature: Hex };

/** Read a POST /facilitator/sellers body. Anything malformed is a 400. */
export function parseListing(ctx: Pick<Ctx, "cfg">, b: Record<string, unknown>): Listing {
  const bad = (m: string): never => fail(400, m, "invalid_listing");
  if (typeof b.payTo !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(b.payTo)) bad("payTo must be the seller's address.");
  if (typeof b.resource !== "string" || b.resource.length > 2048) bad("resource must be the paid URL (2048 characters at most).");
  let url: URL | null = null;
  try {
    url = new URL(b.resource as string);
  } catch {
    bad("resource must be an absolute URL.");
  }
  if (url!.username || url!.password || url!.hash || (url!.protocol !== "https:" && (ctx.cfg.production || url!.protocol !== "http:"))) bad("resource must be an https URL with no credentials or fragment.");
  const priceHint = b.priceHint === undefined || b.priceHint === null ? "0" : String(b.priceHint);
  if (!/^\d{1,30}$/.test(priceHint)) bad("priceHint must be USDG base units as an integer string.");
  const outputSchema = b.outputSchema === undefined || b.outputSchema === null ? "" : b.outputSchema;
  if (typeof outputSchema !== "string" || outputSchema.length > MAX_SCHEMA) bad(`outputSchema must be JSON text of at most ${MAX_SCHEMA} characters (the exact string you signed).`);
  if (outputSchema) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(outputSchema as string);
    } catch {
      bad("outputSchema must be valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) bad("outputSchema must be a JSON object.");
  }
  const tags = b.tags === undefined ? [] : b.tags;
  if (!Array.isArray(tags) || tags.length > 10 || tags.some((t) => typeof t !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(t)) || new Set(tags).size !== tags.length) bad("tags must be up to 10 distinct lowercase words (a-z, 0-9, -).");
  const listed = b.listed === undefined ? true : b.listed;
  if (typeof listed !== "boolean") bad("listed must be true or false.");
  const issuedAt = typeof b.issuedAt === "number" && Number.isSafeInteger(b.issuedAt) ? BigInt(b.issuedAt) : typeof b.issuedAt === "string" && /^\d{1,12}$/.test(b.issuedAt) ? BigInt(b.issuedAt) : null;
  if (issuedAt === null) bad("issuedAt must be the signing time in unix seconds.");
  if (typeof b.signature !== "string" || !/^0x[0-9a-fA-F]{2,8192}$/.test(b.signature) || b.signature.length % 2 !== 0) bad("signature must be the payTo key's EIP-712 signature of the listing.");
  return { payTo: (b.payTo as string).toLowerCase() as Hex, resource: b.resource as string, priceHint: BigInt(priceHint), outputSchema: outputSchema as string, tags: tags as string[], listed: listed as boolean, issuedAt: issuedAt!, signature: b.signature as Hex };
}

/** The EIP-712 message a seller signs for a listing. */
export const listingTypedData = (chainId: number, l: Omit<Listing, "signature">) => ({
  domain: listingDomain(chainId),
  types: LISTING_TYPES,
  primaryType: "SellerListing" as const,
  message: { payTo: getAddress(l.payTo), resource: l.resource, priceHint: l.priceHint, outputSchema: l.outputSchema, tags: l.tags, listed: l.listed, issuedAt: l.issuedAt },
});

/** Create or update a listing signed by its payTo key. The first payTo to list a resource owns it; a later signature replaces an earlier one. */
export async function upsertListing(ctx: Ctx, l: Listing) {
  const now = Math.floor(Date.now() / 1000);
  if (l.issuedAt > BigInt(now + LISTING_SKEW_S) || l.issuedAt < BigInt(now - LISTING_SKEW_S)) fail(400, `issuedAt must be within ${LISTING_SKEW_S} seconds of now.`, "invalid_listing");
  const { signature, ...unsigned } = l;
  if (!(await ctx.chain.verifyWalletSignature(l.payTo, listingTypedData(ctx.cfg.chain.id, unsigned) as never, signature))) fail(401, "The listing is not signed by its payTo key.", "invalid_listing_signature");
  // Screening covers listings only: the facilitator holds no funds, so payers are not screened.
  if (l.listed && ctx.cfg.sanctions.enabled) {
    try {
      await assertNotSanctioned(ctx, l.payTo);
    } catch (e) {
      if (isApiError(e) && e.type === "sanctioned_address") throw new ApiError(403, "This payTo address is on the public OFAC SDN list, so it cannot be listed.", "sanctioned_address");
      throw e;
    }
  }
  const signedAt = new Date(Number(l.issuedAt) * 1000);
  const values = { payTo: l.payTo, priceHint: l.priceHint > 0n ? l.priceHint : null, outputSchema: l.outputSchema ? JSON.parse(l.outputSchema) : null, tags: l.tags, listed: l.listed, signature, signedAt, updatedAt: new Date() };
  const [existing] = await ctx.db.select().from(facilitatorSellers).where(eq(facilitatorSellers.resource, l.resource));
  if (existing) {
    if (existing.payTo !== l.payTo) fail(409, "Another payTo already lists this resource.", "resource_taken");
    if (existing.signedAt >= signedAt) fail(409, "A newer signed listing for this resource is already stored; sign again with a later issuedAt.", "stale_listing");
    const [row] = await ctx.db.update(facilitatorSellers).set(values).where(and(eq(facilitatorSellers.id, existing.id), lt(facilitatorSellers.signedAt, signedAt))).returning();
    if (!row) fail(409, "A newer signed listing for this resource is already stored; sign again with a later issuedAt.", "stale_listing");
    return { row, created: false };
  }
  const [row] = await ctx.db.insert(facilitatorSellers).values({ id: uid("fsl_"), resource: l.resource, ...values }).onConflictDoNothing().returning();
  if (!row) fail(409, "Another listing for this resource was stored at the same time; retry.", "resource_taken");
  return { row, created: true };
}

export const listingJson = (r: typeof facilitatorSellers.$inferSelect) => ({
  id: r.id,
  payTo: getAddress(r.payTo),
  resource: r.resource,
  priceHint: r.priceHint?.toString() ?? null,
  outputSchema: r.outputSchema ?? null,
  tags: r.tags,
  listed: r.listed,
  signedAt: r.signedAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/** GET /facilitator/discovery/resources: listed sellers as Bazaar items. `accepts` is built from the price hint. */
export async function discoverResources(ctx: Ctx, q: { type?: string; network?: string; limit?: string; offset?: string; tag?: string; x402Version?: string }) {
  const version = q.x402Version === "1" ? 1 : 2;
  const limit = Math.min(100, Math.max(1, Number.parseInt(q.limit ?? "20", 10) || 20));
  const offset = Math.max(0, Number.parseInt(q.offset ?? "0", 10) || 0);
  const network = caip2(ctx.cfg.chain.id);
  const empty = { x402Version: version, items: [], pagination: { limit, offset, total: 0 } };
  if (q.type && q.type !== "http") return empty;
  if (q.network && q.network !== network && q.network !== ctx.cfg.x402.network) return empty;
  if (q.tag !== undefined && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(q.tag)) fail(400, "tag must be a lowercase word.", "invalid_request");
  const where = and(eq(facilitatorSellers.listed, true), q.tag ? sql`${facilitatorSellers.tags} @> ARRAY[${q.tag}]::text[]` : undefined);
  const [{ total }] = await ctx.db.select({ total: count() }).from(facilitatorSellers).where(where);
  const rows = await ctx.db.select().from(facilitatorSellers).where(where).orderBy(desc(facilitatorSellers.updatedAt), facilitatorSellers.id).limit(limit).offset(offset);
  const domain = await ctx.chain.usdgDomain();
  const asset = getAddress(ctx.cfg.chain.usdg);
  const items = rows.map((r) => {
    const payTo = getAddress(r.payTo);
    const extra = { name: domain.name, version: domain.version };
    const accepts = !r.priceHint
      ? []
      : version === 1
        ? [{ scheme: "exact", network, maxAmountRequired: r.priceHint.toString(), resource: r.resource, description: "", mimeType: "", payTo, maxTimeoutSeconds: 300, asset, ...(r.outputSchema ? { outputSchema: r.outputSchema } : {}), extra }]
        : [{ scheme: "exact", network, amount: r.priceHint.toString(), asset, payTo, maxTimeoutSeconds: 300, extra }];
    return { resource: r.resource, type: "http", x402Version: version, accepts, lastUpdated: r.updatedAt.toISOString(), metadata: { sellerId: r.id, tags: r.tags, outputSchema: r.outputSchema ?? null, facilitator: `${ctx.cfg.publicUrl}/facilitator` } };
  });
  return { x402Version: version, items, pagination: { limit, offset, total: Number(total) } };
}
