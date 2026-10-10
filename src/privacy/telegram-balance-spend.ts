// E152: no new persistence; Telegram receives a readable billing summary.
import type { ExternalDoc } from "./types.ts";
export const telegramBalanceSpendReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/telegram/balance-spend.ts", carries: "settings",
  reads: "Private Telegram /balance and /spend commands, Telegram user and chat identifiers, the existing account link and its current key authority. Reads existing settled account balance, charged ledger entries and visible key names to answer the command.",
  then: "Reuses account runway and agent spend reads. Balance and rolling seven-day pace are account-wide as on Home; spend uses UTC days and Monday-start weeks with the linked key's team visibility. Revalidates the link and authority before sending. Telegram receives readable amounts, estimated days and visible key names and applies its own retention policies.",
  kept: "No new table, column, Redis counter, log field or saved reply. The existing link, ledger and keys are read without changing them. No API key secret or inference text is needed for these commands; existing Telegram chat keys remain separate.",
  evidence: [{ file: "src/telegram/balance-spend.ts", contains: "const link = await readLink(ctx.db, uid);" },
    { file: "src/telegram/balance-spend.ts", contains: "await say(sameScope(caller, current) ? text : unavailable);" }],
};
