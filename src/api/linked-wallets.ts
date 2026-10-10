import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { recoverMessageAddress, type Hex } from "viem";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { kv } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { randomHex } from "../lib/util.ts";
import { accountLinkedWallets } from "../wallets/schema.ts";
import { assertWalletAvailable, secondaryWallets, unlinkWallet } from "../wallets/store.ts";
import { requireKey, requireRole } from "./auth.ts";
import { readJson } from "./common.ts";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(v => !/^0x0{40}$/i.test(v), "Choose a nonzero wallet address");
type Challenge = { accountId: string; wallet: string; origin: string; chainId: number; expires: number; message: string };
export function linkedWalletRoutes(app: Hono, ctx: Ctx) {
  const owner = async (authorization: string | undefined) => {
    const key = await requireKey(ctx, authorization);
    await requireRole(ctx, key, ["owner"]);
    if (!key.management || key.scope === "inference") fail(403, "Only an account management key can manage linked wallets.", "forbidden");
    return key;
  };
  app.get("/api/v1/account/wallets", async c => {
    const key = await owner(c.req.header("authorization"));
    c.header("cache-control", "no-store");
    return c.json({ data: (await secondaryWallets(ctx.db, key.accountId)).map(w => ({ wallet: w.wallet, linked_at: w.linkedAt.toISOString() })) });
  });
  app.post("/api/v1/account/wallets/challenge", async c => {
    const key = await owner(c.req.header("authorization"));
    const wallet = z.strictObject({ address }).parse(await readJson(c)).address.toLowerCase();
    if (!(await ctx.limiter.take(`wallet-link:${key.accountId}`, 1, 30, 60_000)).ok) fail(429, "Too many wallet link requests. Try again in a minute.", "rate_limited");
    const nonce = randomHex(24), expires = Date.now() + 300_000;
    const origin = new URL(ctx.cfg.publicUrl).origin, chainId = ctx.cfg.chain.id;
    const message = `Anyroute wallet link\nAction: link wallet for deposits and agent payments\nAccount: ${key.accountId}\nOrigin: ${origin}\nChain ID: ${chainId}\nWallet: ${wallet}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}`;
    await ctx.db.transaction(async tx => {
      await assertWalletAvailable(tx, wallet, key.accountId);
      await tx.delete(kv).where(sql`${kv.key} LIKE 'wallet-link:%' AND ${kv.updatedAt} < now() - interval '10 minutes'`);
      await tx.insert(kv).values({ key: `wallet-link:${nonce}`, value: { accountId: key.accountId, wallet, origin, chainId, expires, message } });
    });
    c.header("cache-control", "no-store");
    return c.json({ data: { nonce, message, chain_id: chainId, expires_at: new Date(expires).toISOString() } });
  });
  app.post("/api/v1/account/wallets", async c => {
    const key = await owner(c.req.header("authorization"));
    const v = z.strictObject({ nonce: z.string().regex(/^[0-9a-f]{48}$/), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(await readJson(c));
    const [row] = await ctx.db.select().from(kv).where(eq(kv.key, `wallet-link:${v.nonce}`));
    const ch = row?.value as Challenge | undefined;
    const valid = () => ch && ch.accountId === key.accountId && ch.expires > Date.now() && ch.origin === new URL(ctx.cfg.publicUrl).origin && ch.chainId === ctx.cfg.chain.id;
    if (!valid()) fail(401, "Wallet link request is invalid, expired or already used.", "invalid_wallet_auth");
    const who = await recoverMessageAddress({ message: ch!.message, signature: v.signature as Hex }).catch(() => null);
    if (who?.toLowerCase() !== ch!.wallet) fail(401, "Sign the link request with the wallet you are linking.", "invalid_wallet_auth");
    const link = await ctx.db.transaction(async tx => {
      await assertWalletAvailable(tx, ch!.wallet, key.accountId);
      const used = await tx.delete(kv).where(eq(kv.key, row!.key)).returning();
      if (!used.length || !valid()) fail(401, "Wallet link request is expired or already used.", "invalid_wallet_auth");
      return (await tx.insert(accountLinkedWallets).values({ wallet: ch!.wallet, accountId: key.accountId }).returning())[0]!;
    });
    c.header("cache-control", "no-store");
    return c.json({ data: { wallet: link.wallet, linked_at: link.linkedAt.toISOString() } }, 201);
  });
  app.delete("/api/v1/account/wallets/:address", async c => {
    const key = await owner(c.req.header("authorization"));
    const wallet = address.parse(c.req.param("address")).toLowerCase();
    z.strictObject({ confirm: z.literal(true) }).parse(await readJson(c));
    await ctx.db.transaction(tx => unlinkWallet(tx, key.accountId, wallet));
    c.header("cache-control", "no-store");
    return c.json({ data: { wallet, unlinked: true } });
  });
}
