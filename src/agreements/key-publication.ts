import type { Ctx } from "../context.ts";
import { receiptKeyEntry } from "../tlog/entries.ts";

/** A dry-run statement may predate the key log; publish its actual signing key before any ruling. */
export async function publishJuryStatementKey(ctx: Ctx, keyId: string) {
  if (!ctx.tlog) throw new Error("Agreement rulings require the key log.");
  const key = await ctx.signer.publicKey(keyId);
  if (!key) throw new Error("Jury statement key unavailable.");
  const entry = receiptKeyEntry({ id: key.id, publicKey: key.publicKeyHex, validFrom: key.validFrom });
  await ctx.tlog.append([entry]);
  if (!await ctx.tlog.lookup("receipt_key", entry.sha256)) throw new Error("Jury statement key publication unavailable.");
}
