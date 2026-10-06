import type { RedisFamily, ExternalDoc } from "./types.ts";
export const telegramLinkNotes = [
  "telegram-link-code:<account id>: SHA-256 of a random single-use code, account id, principal key hash and expiry. One code per account, replaced on issuance, deleted on consumption/cancellation. Valid for five minutes; expired rows are purged on enabled polling or issuance. The code itself is returned once and stays in page memory until linking, cancellation or navigation; it is never saved in browser storage.",
  "telegram-link:<Telegram user id>: account id, owner/admin principal key hash, Telegram user id, random generation and linked timestamp. One account per Telegram identity and one identity per principal key. Kept until /unlink or DELETE /api/v1/telegram/link; disabling or expiring the key or removing its role prevents use. No API key or message text. Existing chat keys under telegram:user are separate.",
  "telegram-approval:<approval id>:<Telegram user id>:<link generation>: approval id, Telegram user id, generation, expiry, Telegram message id and fixed decision status. Delivery markers stop repeat polling sends and bind buttons to the originating message and current link. Deleted on unlink; expired markers are purged on enabled polling or issuance. Worker interruptions can repeat a notification; decisions use the dashboard's atomic logic. Telegram receives readable intent metadata and alerts, not inference messages or tool arguments. With AGENT_RULEBOOK_WORDS_ENABLED it also receives the current rulebook amount caps and approval thresholds (including inherited rules); this display text is not stored. Message text is never stored here.",
];
export const telegramLinkRate: RedisFamily = {
  key: "rl:telegram-link:<action>:<account or Telegram user id>:<window start>", limiterPrefix: "telegram-link:", windowSeconds: 60,
  purpose: "Account link-code issuance (five per minute per account), code consumption (ten per minute per Telegram user) and approval callbacks (twenty per minute per Telegram user). Only identifiers and counters, no code or message text.", holds: "telegram-user", ttl: "61 seconds (the 60-second window plus one second)",
  evidence: [{ file: "src/telegram/linking.ts", contains: "ctx.limiter.take(`telegram-link:${action}:${actor}`" }],
};
export const telegramLinkReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/telegram/delivery.ts", carries: "settings",
  reads: "Private Telegram /link and /unlink commands and approval callbacks fetched by the existing bot poller. Link codes and callback identifiers are read in memory.",
  then: "The link is role-checked and recorded without a key secret. Callbacks run the same approval decision as the dashboard; inference consumption is unchanged. Telegram receives approval intent metadata and alerts, plus current rulebook amount caps and ask-first thresholds when AGENT_RULEBOOK_WORDS_ENABLED is enabled.",
  kept: "Only the link identifiers, code hash, expiry and delivery markers described under kv. No Telegram message text or inference text is copied. No new request-body or network-address reader.",
  evidence: [{ file: "src/telegram/delivery.ts", contains: "await consumeCode(ctx, message.from.id, command[2]" }],
};
