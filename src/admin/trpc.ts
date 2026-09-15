import type { Hono } from "hono";
import { trpcServer } from "@hono/trpc-server";
import { initTRPC, TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { generations, keys, models, payouts, providers, royalties, settlements, slashes, kv } from "../db/schema.ts";
import { bearer, resolveKey, type KeyRow } from "../api/auth.ts";
import { keyJson } from "../api/keys.ts";
import { modelJson } from "../api/models.ts";
import { verifyReceipt, anchorProof } from "../api/generation.ts";
import { providerApplication } from "../api/public.ts";
import { statement } from "../pay/paywith.ts";
import { importLiteLLM } from "../gateway/litellm.ts";
import { verifyInvariants } from "../ledger/ledger.ts";
import { encrypt, safeEqual } from "../lib/util.ts";
import { picoToUsd } from "../lib/money.ts";
import { chainKeyHashOf } from "../chain/keys.ts";

// Admin / account API over tRPC v11 at /trpc. Operator procedures need the ADMIN_TOKEN
// (Authorization: Bearer <ADMIN_TOKEN> or x-admin-token); account procedures accept an API key.

type TCtx = { app: Ctx & { appFetch: (path: string, init: RequestInit) => Promise<Response> }; admin: boolean; key: KeyRow | null; secret: string | null };
const t = initTRPC.context<TCtx>().create();
const operator = t.procedure.use(({ ctx, next }) => {
  if (!ctx.admin) throw new TRPCError({ code: "UNAUTHORIZED", message: "Operator token required." });
  return next({ ctx });
});
const account = t.procedure.use(({ ctx, next }) => {
  if (!ctx.key && !ctx.admin) throw new TRPCError({ code: "UNAUTHORIZED", message: "API key required." });
  return next({ ctx });
});
const ser = <T>(v: T): T => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

export const adminRouter = t.router({
  providers: t.router({
    // "apply" is a reserved word in tRPC routers; REST keeps POST /api/v1/providers/apply.
    onboard: t.procedure.input(providerApplication).mutation(async ({ ctx, input }) => {
      const row = {
        id: input.id,
        name: input.name,
        baseUrl: input.base_url,
        apiKeyEnc: input.api_key ? encrypt(ctx.app.cfg.appSecret, input.api_key) : null,
        dataPolicy: input.data_policy,
        datacenter: input.datacenters ?? [],
        teeKind: input.tee?.kind ?? null,
        attestationUrl: input.tee?.attestation_url ?? null,
        payoutAddress: input.payout_address?.toLowerCase() ?? null,
        payoutMode: input.payout_address ? "usdg" : "invoice",
        headers: input.headers ?? null,
        status: "applied",
      };
      await ctx.app.db.insert(providers).values(row).onConflictDoNothing();
      const res = await ctx.app.jobs.run("provider-registry").catch((e) => ({ error: (e as Error).message }));
      return ser({ id: input.id, status: "applied", registry: res });
    }),
    get: t.procedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
      const [p] = await ctx.app.db.select().from(providers).where(eq(providers.id, input.id));
      if (!p) throw new TRPCError({ code: "NOT_FOUND" });
      const { apiKeyEnc: _secret, ...pub } = p;
      return ser(pub);
    }),
    list: operator.query(async ({ ctx }) => ser((await ctx.app.db.select().from(providers)).map(({ apiKeyEnc: _s, ...p }) => p))),
    slashes: t.procedure.input(z.object({ id: z.string().optional() })).query(async ({ ctx, input }) =>
      ser(await ctx.app.db.select().from(slashes).where(input.id ? eq(slashes.providerId, input.id) : sql`true`).orderBy(desc(slashes.proposedAt)).limit(200)),
    ),
    /** Operator onboarding for public inference APIs (router is a usage-reconciled customer): skip bond. */
    approve: operator.input(z.object({ id: z.string(), live: z.boolean().default(false), api_key: z.string().optional() })).mutation(async ({ ctx, input }) => {
      const status = input.live ? "live" : "shadow";
      await ctx.app.db
        .update(providers)
        .set({ status, shadowUntil: input.live ? null : new Date(Date.now() + ctx.app.cfg.canaries.shadowDays * 86_400_000), ...(input.api_key ? { apiKeyEnc: encrypt(ctx.app.cfg.appSecret, input.api_key) } : {}), updatedAt: new Date() })
        .where(eq(providers.id, input.id));
      await ctx.app.jobs.run("provider-registry").catch(() => undefined);
      return { id: input.id, status };
    }),
    setStatus: operator.input(z.object({ id: z.string(), status: z.enum(["applied", "shadow", "live", "suspended", "delisted"]) })).mutation(async ({ ctx, input }) => {
      await ctx.app.db.update(providers).set({ status: input.status, updatedAt: new Date() }).where(eq(providers.id, input.id));
      await ctx.app.catalog.refresh();
      return input;
    }),
    setAttestationAllowlist: operator.input(z.object({ id: z.string(), mrtd: z.array(z.string()).optional(), rtmr3: z.array(z.string()).optional(), measurement: z.array(z.string()).optional() })).mutation(async ({ ctx, input }) => {
      const { id, ...value } = input;
      await ctx.app.db.insert(kv).values({ key: `attest-allow:${id}`, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
      return { id, ...value };
    }),
  }),
  models: t.router({
    list: t.procedure.query(async ({ ctx }) => {
      await ctx.app.catalog.ensureFresh();
      return ser([...ctx.app.catalog.models.values()].map((m) => modelJson(ctx.app, m)));
    }),
    get: t.procedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
      await ctx.app.catalog.ensureFresh();
      const m = ctx.app.catalog.models.get(input.id);
      if (!m) throw new TRPCError({ code: "NOT_FOUND" });
      return ser({ ...modelJson(ctx.app, m), offers: ctx.app.catalog.offers(m.id).map(({ provider, ...o }) => ({ ...o, provider: provider.id })) });
    }),
    setCreator: operator.input(z.object({ id: z.string(), creator: z.string().regex(/^0x[0-9a-fA-F]{40}$/), royalty_bps: z.number().int().min(0).max(2000) })).mutation(async ({ ctx, input }) => {
      await ctx.app.db.update(models).set({ creator: input.creator.toLowerCase(), royaltyBps: input.royalty_bps }).where(eq(models.id, input.id));
      await ctx.app.catalog.refresh();
      return input;
    }),
  }),
  keys: t.router({
    usage: account.input(z.object({ hash: z.string().optional(), days: z.number().int().min(1).max(90).default(30) })).query(async ({ ctx, input }) => {
      const hash = input.hash ?? ctx.key?.keyHash;
      if (!hash) throw new TRPCError({ code: "BAD_REQUEST" });
      const [k] = await ctx.app.db.select().from(keys).where(eq(keys.keyHash, hash));
      if (!k || (!ctx.admin && k.accountId !== ctx.key?.accountId)) throw new TRPCError({ code: "NOT_FOUND" });
      const rows = await ctx.app.db
        .select({ day: sql<string>`to_char(${generations.ts}, 'YYYY-MM-DD')`, model: generations.modelId, requests: sql<string>`count(*)`, tokens: sql<string>`sum(${generations.tokensIn} + ${generations.tokensOut})`, cost: sql<string>`sum(${generations.cost})` })
        .from(generations)
        .where(and(eq(generations.keyHash, hash), sql`${generations.ts} > now() - (${input.days} || ' days')::interval`))
        .groupBy(sql`1`, generations.modelId)
        .orderBy(sql`1 desc`);
      return ser({ key: keyJson(k), usage: rows.map((r) => ({ day: r.day, model: r.model, requests: Number(r.requests), tokens: Number(r.tokens), cost_usd: picoToUsd(BigInt(r.cost)) })) });
    }),
    update: account.input(z.object({ hash: z.string(), disabled: z.boolean().optional(), name: z.string().optional(), rpm: z.number().int().positive().nullable().optional() })).mutation(async ({ ctx, input }) => {
      const [k] = await ctx.app.db.select().from(keys).where(eq(keys.keyHash, input.hash));
      if (!k || (!ctx.admin && (k.accountId !== ctx.key?.accountId || !ctx.key?.management))) throw new TRPCError({ code: "NOT_FOUND" });
      const { hash, ...patch } = input;
      await ctx.app.db.update(keys).set(patch).where(eq(keys.keyHash, hash));
      return { hash, ...patch };
    }),
    importLiteLLM: account.input(z.object({ hash: z.string().optional(), yaml: z.string().max(200_000) })).mutation(async ({ ctx, input }) => {
      const hash = input.hash ?? ctx.key?.keyHash;
      const [k] = hash ? await ctx.app.db.select().from(keys).where(eq(keys.keyHash, hash)) : [];
      if (!k || (!ctx.admin && k.accountId !== ctx.key?.accountId)) throw new TRPCError({ code: "NOT_FOUND" });
      // A key may edit its own presets; only a management key may edit another key's.
      if (!ctx.admin && k.keyHash !== ctx.key?.keyHash && !ctx.key?.management) throw new TRPCError({ code: "FORBIDDEN", message: "Only a management key can change another key's routing." });
      await ctx.app.catalog.ensureFresh();
      const presets = importLiteLLM(input.yaml, ctx.app.catalog);
      await ctx.app.db.update(keys).set({ routing: presets }).where(eq(keys.keyHash, k.keyHash));
      return presets;
    }),
  }),
  paywith: t.router({
    /** Unsigned transactions for the paying wallet (approve + openSession); records the wallet intent. */
    open: account.input(z.object({ token: z.string(), capRawPerDay: z.string().regex(/^\d+$/), wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/) })).mutation(async ({ ctx, input }) => {
      if (!ctx.key) throw new TRPCError({ code: "BAD_REQUEST", message: "Use the key that will pay." });
      const res = await ctx.app.appFetch("/api/v1/paywith/open", { method: "POST", headers: { authorization: `Bearer ${ctx.secret}`, "content-type": "application/json" }, body: JSON.stringify({ token: input.token, cap_raw_per_day: input.capRawPerDay, wallet: input.wallet }) });
      const j = (await res.json()) as { data?: unknown; error?: { message: string } };
      if (!res.ok) throw new TRPCError({ code: "BAD_REQUEST", message: j.error?.message ?? "failed" });
      return j.data;
    }),
    close: account.mutation(async ({ ctx }) => {
      if (!ctx.key) throw new TRPCError({ code: "BAD_REQUEST" });
      const res = await ctx.app.appFetch("/api/v1/paywith/close", { method: "POST", headers: { authorization: `Bearer ${ctx.secret}` } });
      return ((await res.json()) as { data: unknown }).data;
    }),
    statement: account.input(z.object({ keyHash: z.string().optional(), month: z.string().regex(/^\d{4}-\d{2}$/) })).query(async ({ ctx, input }) => {
      const chainKeyHash = input.keyHash && ctx.admin ? input.keyHash : ctx.key?.chainKeyHash;
      if (!chainKeyHash) throw new TRPCError({ code: "BAD_REQUEST" });
      return ser(await statement(ctx.app, chainKeyHash, input.month));
    }),
    runAggregator: operator.mutation(async ({ ctx }) => ser(await ctx.app.jobs.run("paywith-aggregator"))),
  }),
  receipts: t.router({
    verify: t.procedure.input(z.object({ receiptId: z.string() })).query(async ({ ctx, input }) => {
      const [g] = await ctx.app.db.select().from(generations).where(eq(generations.id, input.receiptId));
      if (!g) throw new TRPCError({ code: "NOT_FOUND" });
      const anchor = await anchorProof(ctx.app, g);
      const v = await verifyReceipt(ctx.app, { payload: g.receipt, sig: g.receiptSig!, key_id: g.receiptKeyId!, anchor: anchor ? { root: anchor.root, proof: anchor.proof, index: anchor.index } : undefined });
      return ser({ ...v, anchor });
    }),
  }),
  settlement: t.router({
    status: operator.query(async ({ ctx }) => {
      const recent = await ctx.app.db.select().from(settlements).orderBy(desc(settlements.period)).limit(200);
      const pays = await ctx.app.db.select().from(payouts).orderBy(desc(payouts.createdAt)).limit(100);
      const [margin] = await ctx.app.db.select().from(kv).where(eq(kv.key, "margin_unsent"));
      return ser({ settlements: recent, payouts: pays, margin_unsent_usd: picoToUsd(BigInt((margin?.value as string) ?? "0")) });
    }),
    run: operator.mutation(async ({ ctx }) => ser(await ctx.app.jobs.run("settlement"))),
  }),
  royalties: t.router({
    claimable: t.procedure.input(z.object({ creator: z.string().regex(/^0x[0-9a-fA-F]{40}$/) })).query(async ({ ctx, input }) => {
      const rows = await ctx.app.db.select().from(royalties).where(eq(royalties.creator, input.creator.toLowerCase()));
      const streamed = rows.filter((r) => r.streamTx).reduce((a, r) => a + r.usdg, 0n);
      const pending = rows.filter((r) => !r.streamTx).reduce((a, r) => a + r.usdg, 0n);
      return ser({ creator: input.creator, streamed_usdg: streamed, pending_usdg: pending, contract: ctx.app.cfg.chain.royalty ?? null, periods: rows.length });
    }),
  }),
  jobs: t.router({
    status: operator.query(({ ctx }) => ctx.app.jobs.status()),
    run: operator.input(z.object({ name: z.string() })).mutation(async ({ ctx, input }) => ser(await ctx.app.jobs.run(input.name))),
  }),
  invariants: operator.query(async ({ ctx }) => ser(await verifyInvariants(ctx.app.db))),
  chainKeyHash: t.procedure.input(z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) })).query(({ input }) => chainKeyHashOf(input.address as `0x${string}`)),
});
export type AdminRouter = typeof adminRouter;

export function adminRoutes(app: Hono, ctx: Ctx) {
  app.use(
    "/trpc/*",
    trpcServer({
      router: adminRouter,
      createContext: async (_opts, c) => {
        const token = c.req.header("x-admin-token") ?? bearer(c.req.header("authorization"));
        const admin = !!ctx.cfg.adminToken && !!token && safeEqual(token, ctx.cfg.adminToken);
        let key: KeyRow | null = null;
        if (!admin && token?.startsWith("sk-ar-")) key = await resolveKey(ctx, token).catch(() => null);
        const appFetch = (path: string, init: RequestInit) => app.request(path, init);
        return { app: { ...ctx, appFetch }, admin, key, secret: key ? token : null } as TCtx as unknown as Record<string, unknown>;
      },
    }),
  );
}
