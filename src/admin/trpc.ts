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
