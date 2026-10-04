import { eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import type { TelegramApi, TgUpdate } from "../services/telegram.ts";
import { ApiError, fail } from "../lib/errors.ts";
import { ownedKey } from "../api/agents.ts";
import { agentPolicies } from "../agents/schema.ts";
import { changeKill, lockAccount } from "../agents/store.ts";
import { lockLinks, readLink, validPrincipal, linkLimit } from "./linking.ts";
/** A private linked owner command, subject to the same account/team authority as /agents resume. */
export async function handleGuardResume(ctx: Ctx, api: TelegramApi, update: TgUpdate) {
  if (!ctx.cfg.agentGuardEnabled || !ctx.cfg.telegram.linkingEnabled) return false;
  const message = update.message;
  if (!message?.from || message.from.is_bot || message.chat.type !== "private" || message.chat.id !== message.from.id) return false;
  const command = /^\/resume(?:@\w+)?(?:\s+([0-9a-f]{64}))?\s*$/.exec(message.text ?? "");
  if (!command) return false;
  let text = "Use /resume followed by the agent key hash shown on /agents.";
  if (command[1]) try {
    await linkLimit(ctx, "callback", message.from.id, 20);
    await ctx.db.transaction(async tx => {
      await lockLinks(tx);
      const link = await readLink(tx, message.from!.id);
      if (!link) fail(403, "Link an owner key before resuming an agent.", "forbidden");
      const scoped = { ...ctx, db: tx as unknown as Db };
      const caller = await validPrincipal(scoped, link);
      if (caller.scope === "inference") fail(403, "Inference-only keys cannot resume agents.", "inference_only");
      await ownedKey(scoped, caller, command[1]!);
      await lockAccount(tx, caller.accountId);
      const [row] = await tx.select().from(agentPolicies).where(eq(agentPolicies.keyHash, command[1]!));
      if (!row) fail(404, "Rulebook not found.", "not_found");
      await changeKill(tx, row, false, null, caller.keyHash);
    });
    text = "Agent resumed. Its rulebook limits still apply.";
  } catch (error) { text = error instanceof ApiError ? error.message : "Could not resume the agent."; }
  await api.call("sendMessage", { chat_id: message.chat.id, text }).catch(() => undefined);
  return true;
}
