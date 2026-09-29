import { eq } from "drizzle-orm";
import { KEY_RE } from "../chain/keys.ts";
import type { Ctx } from "../context.ts";
import { kv } from "../db/schema.ts";
import { decrypt, encrypt, log } from "../lib/util.ts";

// AnyRoute on Telegram. Off unless TELEGRAM_BOT_TOKEN is set. The `telegram-bot` job long-polls
// getUpdates (no webhook), private chats only, and answers through the router's normal chat path
// with the user's own AnyRoute key, so billing, limits and signed receipts apply. State lives in
// the kv table: the update offset (`telegram:offset`) and one row per Telegram user
// (`telegram:user:<id>`) holding the key sealed under APP_SECRET and the chosen model.
// Never logged: keys, message text, the bot token (it is part of every Telegram API URL).
// Errors are reduced to a name or a numeric code before they reach a log line.

const TELEGRAM_API = "https://api.telegram.org";
export const OFFSET_KEY = "telegram:offset";
export const userKey = (id: number) => `telegram:user:${id}`;
export const DEFAULT_MODEL = "meta-llama/llama-3.3-70b-instruct"; // cheap and widely offered
export const MAX_TEXT = 4096; // Telegram's message length limit
export const RATE_PER_MINUTE = 20;
const POLL_TIMEOUT_S = 10;
const MAX_INFLIGHT = 32;
const MAX_TOKENS = 2048; // keeps one answer (and the router's spend hold) small
const CHAT_TIMEOUT_MS = 130_000;
const CATALOG_TTL_MS = 60_000;
const KEY_IN_TEXT = /sk-ar-v1-[0-9a-f]{64}/;

export type TgMessage = { message_id: number; from?: { id: number; is_bot?: boolean }; chat: { id: number; type: string }; text?: string };
export type TgUpdate = { update_id: number; message?: TgMessage };
/** How the bot reaches the router: in production the app's own `request`, so no network hop. */
export type RouterCall = (path: string, init?: RequestInit) => Response | Promise<Response>;
type Row = { v: 1; key?: string; model?: string };
type CatalogModel = { id: string; name: string; prompt: string; completion: string };

export class TelegramError extends Error {
  constructor(readonly code: number, description: string, readonly retryAfter?: number) {
    super(description);
  }
}

/** Minimal Bot API client over fetch (injectable). Errors never carry the URL, and so never the token. */
export class TelegramApi {
  constructor(private token: string, private fetchImpl: typeof fetch = fetch) {}
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${TELEGRAM_API}/bot${this.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params), signal });
    } catch (e) {
      throw new TelegramError(0, (e as Error).name === "AbortError" || (e as Error).name === "TimeoutError" ? "aborted" : "network error");
    }
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } } | null;
    if (!body?.ok) throw new TelegramError(body?.error_code ?? res.status, body?.description ?? "Telegram API error", body?.parameters?.retry_after);
    return body.result as T;
  }
}

/** Split at Telegram's limit, preferring paragraph, line then word boundaries, never inside a surrogate pair. */
export function splitMessage(text: string, limit = MAX_TEXT): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = limit;
    for (const sep of ["\n\n", "\n", " "]) {
      const i = rest.lastIndexOf(sep, limit);
      if (i > limit / 2) { cut = i; break; }
    }
    if (cut === limit && rest.charCodeAt(cut - 1) >= 0xd800 && rest.charCodeAt(cut - 1) <= 0xdbff) cut--;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^(?:\n+| )/, ""); // drop the separator the cut landed on
  }
  if (rest.trim() || !parts.length) parts.push(rest);
  return parts;
}

const usd = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "$0";
  return "$" + (n >= 0.01 ? n.toFixed(4) : n.toFixed(6)).replace(/0+$/, "").replace(/\.$/, "");
};
const perMillion = (v: string) => {
  const n = Number(v) * 1e6;
  return !Number.isFinite(n) || n <= 0 ? "free" : "$" + (n >= 1 ? n.toFixed(2) : n.toPrecision(2));
};
const seconds = (ms: number) => (ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000).toString()) + "s";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TelegramBot {
  private api: TelegramApi;
  private abort = new AbortController();
  private inflight = new Set<Promise<void>>();
  private busy = new Set<number>();
  private failures = 0;
  private retryAt = 0;
  private registered = false;
  private catalogCache: { at: number; models: CatalogModel[] } | null = null;

  constructor(private ctx: Ctx, private opts: { token: string; router: RouterCall; fetch?: typeof fetch; pollTimeoutS?: number }) {
    this.api = new TelegramApi(opts.token, opts.fetch);
  }

  // ---- Polling ---------------------------------------------------------------------------------

  /** One long-poll cycle (the job re-runs it every second). Updates are dispatched, not awaited, so a slow
   * answer never blocks other users; the offset is stored first, so a crash drops rather than repeats a
   * paid request. Failures back off and never throw: a Telegram outage must not fail the router's jobs. */
  async poll() {
    if (this.abort.signal.aborted || Date.now() < this.retryAt) return { idle: true };
    try {
      if (!this.registered) {
        this.registered = true;
        await this.api.call("setMyCommands", { commands: COMMANDS }).catch(() => undefined);
      }
      const [row] = await this.ctx.db.select().from(kv).where(eq(kv.key, OFFSET_KEY));
      const timeout = this.opts.pollTimeoutS ?? POLL_TIMEOUT_S;
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout((timeout + 15) * 1000)]);
      const updates = await this.api.call<TgUpdate[]>("getUpdates", { ...(typeof row?.value === "number" ? { offset: row.value } : {}), timeout, allowed_updates: ["message"] }, signal);
      this.failures = 0;
      if (updates.length) {
        const next = Math.max(...updates.map((u) => u.update_id)) + 1;
        await this.ctx.db.insert(kv).values({ key: OFFSET_KEY, value: next }).onConflictDoUpdate({ target: kv.key, set: { value: next, updatedAt: new Date() } });
        for (const u of updates) this.dispatch(u);
      }
      return { updates: updates.length };
    } catch (e) {
      if (this.abort.signal.aborted) return { stopped: true };
      const retryMs = Math.min(30_000, 1_000 * 2 ** ++this.failures);
      this.retryAt = Date.now() + retryMs;
      const code = e instanceof TelegramError ? e.code : "error";
      log.warn("telegram poll failed", { code, retry_ms: retryMs, ...(code === 409 ? { hint: "another getUpdates consumer or a webhook is active for this bot" } : {}) });
      return { error: code };
    }
  }

  private dispatch(u: TgUpdate) {
    const p: Promise<void> = this.handleUpdate(u)
      .catch((e) => log.error("telegram update failed", { error: (e as Error).name }))
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  /** Stop polling (aborting the in-flight getUpdates) and let answers already under way finish. */
  async stop(graceMs = 10_000) {
    this.abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((resolve) => { timer = setTimeout(resolve, graceMs); })]);
    clearTimeout(timer);
  }

  /** Resolves when no update is being handled (used by tests). */
  async idle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  // ---- One update ------------------------------------------------------------------------------

  async handleUpdate(u: TgUpdate) {
    const m = u.message;
    // Private chats with a human only: groups, channels and bots are ignored without a reply.
    if (!m?.from || m.from.is_bot || m.chat?.type !== "private") return;
    const chat = m.chat.id;
    const uid = m.from.id;
    const say = (text: string) => this.send(chat, text);
    if (typeof m.text !== "string") return say("I can only read text messages. Send me a question, or /help.");
    const text = m.text.trim();
    const cmd = /^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
    const name = cmd?.[1].toLowerCase();
    const arg = (cmd?.[2] ?? "").trim();

    if (name === "key") return this.connect(uid, m, arg);
    // A key pasted anywhere else must never reach a model: delete it and point to /key.
    if (KEY_IN_TEXT.test(text)) {
      const gone = await this.deleteMessage(chat, m.message_id);
      return say(`That looks like an AnyRoute API key, so I did not send it to any model.${gone ? " I deleted your message." : " Please delete your message."} To connect it, send /key followed by the key.`);
    }
    switch (name) {
      case "start": return say(this.intro(true));
      case "help": return say(this.intro(false));
      case "model": return this.setModel(uid, chat, arg);
      case "models": return this.searchModels(chat, arg);
      case "forget": {
        await this.ctx.db.delete(kv).where(eq(kv.key, userKey(uid)));
        return say("Done: your stored key and settings are deleted. The AnyRoute key itself still works elsewhere; disable it in the dashboard if you think it was exposed.");
      }
      case undefined: return this.answer(uid, chat, text);
      default: return say("I don't know that command. Send /help for the list.");
    }
  }

  private intro(first: boolean) {
    const site = this.ctx.cfg.publicUrl;
    return [
      first ? "AnyRoute on Telegram: chat with any AnyRoute model. Every answer is paid from your own AnyRoute key and ends with a signed receipt you can verify." : "AnyRoute on Telegram.",
      "",
      `Connect: create a budget-capped API key at ${site}/dashboard (a spend limit keeps a chat bot safe to run), then send /key sk-ar-v1-... I delete your message right away and store the key encrypted.`,
      "",
      "Then just send a message. Commands:",
      "/model <id>  set your default model",
      "/models <search>  find models with prices",
      "/forget  delete your stored key",
      "/help  show this",
      "",
      `Each message is answered on its own (no chat history), by ${DEFAULT_MODEL} unless you pick another model.`,
    ].join("\n");
  }

  // ---- /key, /model, /models -------------------------------------------------------------------

  private async connect(uid: number, m: TgMessage, arg: string) {
    const chat = m.chat.id;
    if (!arg) return this.send(chat, "Send /key followed by your AnyRoute API key, for example /key sk-ar-v1-... I delete the message right away. A budget-capped key is best.");
    // The message holds a secret: delete it before anything else can fail or wait.
    const deleted = this.deleteMessage(chat, m.message_id);
    const key = arg.split(/\s+/)[0];
    const tail = async () => ((await deleted) ? " I deleted your message." : " I could not delete your message, so please delete it yourself.");
    if (!KEY_RE.test(key)) return this.send(chat, "That is not an AnyRoute API key (they look like sk-ar-v1- followed by 64 hex characters)." + (await tail()));
    const limited = await this.rateLimited(uid);
    if (limited) return this.send(chat, limited + (await tail()));
    let res: Response;
    try {
      res = await this.opts.router("/api/v1/key", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    } catch {
      return this.send(chat, "I couldn't reach the router to check that key. Please try again in a moment." + (await tail()));
    }
    if (res.status === 401 || res.status === 403) return this.send(chat, "The router rejected that key (unknown, disabled or expired)." + (await tail()));
    if (!res.ok) return this.send(chat, "The router couldn't check that key right now. Please try again in a moment." + (await tail()));
    const info = ((await res.json().catch(() => null)) as { data?: { limit?: number | null; limit_remaining?: number | null; management?: boolean } } | null)?.data ?? {};
    const row = await this.row(uid);
    await this.save(uid, { ...row, v: 1, key: encrypt(this.ctx.cfg.appSecret, `tg:${uid}:${key}`) });
    const cap = info.limit != null ? `It has a spend limit of ${usd(info.limit)} (${usd(info.limit_remaining)} left).` : "It has no spend limit: a budget-capped key is safer for a chat bot, so consider creating one and sending /key again.";
    await this.send(chat, `Connected.${await tail()} ${cap}${info.management ? " It is a management key, which can also create and delete keys; a regular key is a better fit here." : ""}\n\nSend me a message to chat with ${row.model ?? DEFAULT_MODEL}. Use /model to change it, /forget to remove the key.`);
  }

  private async setModel(uid: number, chat: number, arg: string) {
    const row = await this.row(uid);
    if (!arg) return this.send(chat, `Your model: ${row.model ?? DEFAULT_MODEL}. Change it with /model <id>; find ids with /models <search>.`);
    const id = arg.split(/\s+/)[0].slice(0, 120);
    const models = await this.catalog();
    if (!models) return this.send(chat, "I couldn't load the model catalog right now. Please try again in a moment.");
    const hit = models.find((x) => x.id.toLowerCase() === id.toLowerCase());
    if (!hit) return this.send(chat, `"${id}" is not in the live catalog. Try /models followed by a search word.`);
    await this.save(uid, { ...row, v: 1, model: hit.id });
    return this.send(chat, `Model set to ${hit.id} (${perMillion(hit.prompt)} in, ${perMillion(hit.completion)} out per 1M tokens).`);
  }

  private async searchModels(chat: number, arg: string) {
    if (!arg) return this.send(chat, "Send /models followed by a search word, for example /models llama.");
    const models = await this.catalog();
    if (!models) return this.send(chat, "I couldn't load the model catalog right now. Please try again in a moment.");
    const words = arg.toLowerCase().split(/\s+/).filter(Boolean);
    const q = arg.toLowerCase();
    const rank = (x: CatalogModel) => (x.id.toLowerCase() === q ? 0 : x.id.toLowerCase().endsWith("/" + q) ? 1 : x.id.toLowerCase().startsWith(q) ? 2 : 3);
    const hits = models
      .filter((x) => words.every((w) => `${x.id} ${x.name}`.toLowerCase().includes(w)))
      .sort((a, b) => rank(a) - rank(b) || Number(a.prompt) + Number(a.completion) - (Number(b.prompt) + Number(b.completion)) || a.id.localeCompare(b.id))
      .slice(0, 8);
    if (!hits.length) return this.send(chat, "No live model matches that search.");
    return this.send(chat, [...hits.map((x) => `${x.id}\n  ${perMillion(x.prompt)} in, ${perMillion(x.completion)} out per 1M tokens`), "", "Pick one with /model <id>."].join("\n"));
  }

  /** The live catalog through the router's own /models listing, cached briefly; stale beats nothing. */
  private async catalog(): Promise<CatalogModel[] | null> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < CATALOG_TTL_MS) return this.catalogCache.models;
    try {
      const res = await this.opts.router("/api/v1/models", { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error("catalog");
      const data = ((await res.json()) as { data?: { id: string; name?: string; pricing?: { prompt?: string; completion?: string } }[] }).data ?? [];
      const models = data.map((x) => ({ id: x.id, name: x.name ?? "", prompt: x.pricing?.prompt ?? "0", completion: x.pricing?.completion ?? "0" }));
      this.catalogCache = { at: Date.now(), models };
      return models;
    } catch {
      return this.catalogCache?.models ?? null;
    }
  }

  // ---- Chat ------------------------------------------------------------------------------------

  private async answer(uid: number, chat: number, text: string) {
    // One request at a time per user; claimed synchronously so two quick messages can't both pass.
    if (this.busy.has(uid)) return this.send(chat, "I'm still answering your previous message. One at a time, please.");
    if (this.busy.size >= MAX_INFLIGHT) return this.send(chat, "I'm busy right now. Please try again in a moment.");
    this.busy.add(uid);
    const typing = () => void this.api.call("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => undefined);
    const timer = setInterval(typing, 4_000);
    try {
      const row = await this.row(uid);
      const key = this.apiKey(uid, row);
      if (!key) return await this.send(chat, "Connect your AnyRoute key first: send /key followed by the key. Send /help for how.");
      const limited = await this.rateLimited(uid);
      if (limited) return await this.send(chat, limited);
      typing();
      const model = row.model ?? DEFAULT_MODEL;
      const t0 = Date.now();
      let res: Response;
      try {
        res = await this.opts.router("/api/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model, messages: [{ role: "user", content: text }], max_tokens: MAX_TOKENS }),
          signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
        });
      } catch {
        return await this.send(chat, "The router took too long to answer. Please try again.");
      }
      const latency = Date.now() - t0;
      if (!res.ok) return await this.send(chat, await this.routerFailure(res, model));
      const out = (await res.json().catch(() => null)) as { model?: string; choices?: { message?: { content?: unknown } }[]; usage?: { cost?: number }; receipt?: { id?: string } } | null;
      const content = out?.choices?.[0]?.message?.content;
      const reply = typeof content === "string" && content.trim() ? content : "(The model sent an empty reply.)";
      const id = out?.receipt?.id;
      const footer = [out?.model ?? model, usd(out?.usage?.cost), seconds(latency), ...(id ? [`receipt ${this.ctx.cfg.publicUrl}/api/v1/receipts/${encodeURIComponent(id)}`] : [])].join(" · ");
      const parts = splitMessage(reply);
      if (parts[parts.length - 1].length + 2 + footer.length <= MAX_TEXT) parts[parts.length - 1] += "\n\n" + footer;
      else parts.push(footer);
      for (const part of parts) await this.send(chat, part);
    } finally {
      clearInterval(timer);
      this.busy.delete(uid);
    }
  }

  private async routerFailure(res: Response, model: string) {
    const err = ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error;
    const said = (err?.message ?? "").slice(0, 300);
    switch (res.status) {
      case 401: return "The router rejected your AnyRoute key (unknown, disabled or expired). Send /key with a working one.";
      case 402: return `Your key can't pay for that. ${said || "Check its balance and budget."}`;
      case 403: return said || "This key isn't allowed to use that model.";
      case 404: return `${model} isn't available right now. Find another with /models and set it with /model.`;
      case 429: return said || "The router is rate limiting your key. Please wait a moment.";
      case 400: return `The router couldn't take that request. ${said}`.trim();
      default: return "The router couldn't get an answer from a provider. Please try again in a moment.";
    }
  }

  // ---- Storage, limits, delivery ---------------------------------------------------------------

  private async row(uid: number): Promise<Row> {
    const [r] = await this.ctx.db.select().from(kv).where(eq(kv.key, userKey(uid)));
    return (r?.value as Row | undefined) ?? { v: 1 };
  }
  private async save(uid: number, row: Row) {
    await this.ctx.db.insert(kv).values({ key: userKey(uid), value: row }).onConflictDoUpdate({ target: kv.key, set: { value: row, updatedAt: new Date() } });
  }
  /** The sealed value is bound to its Telegram id, so a ciphertext copied to another row is refused. */
  private apiKey(uid: number, row: Row) {
    if (!row.key) return null;
    try {
      const plain = decrypt(this.ctx.cfg.appSecret, row.key);
      const prefix = `tg:${uid}:`;
      return plain.startsWith(prefix) ? plain.slice(prefix.length) : null;
    } catch {
      return null;
    }
  }
  private async rateLimited(uid: number) {
    const r = await this.ctx.limiter.take(`telegram:${uid}`, 1, RATE_PER_MINUTE, 60_000);
    return r.ok ? null : `You're sending requests quickly (limit ${RATE_PER_MINUTE} a minute). Try again in ${Math.max(1, Math.ceil(r.retryAfterMs / 1000))}s.`;
  }
  private deleteMessage(chat: number, messageId: number) {
    return this.api.call("deleteMessage", { chat_id: chat, message_id: messageId }).then(() => true, () => false);
  }
  /** Plain text on purpose (model output is Markdown-ish and would break a parse mode); failures are logged as codes only. */
  private async send(chat: number, text: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.api.call("sendMessage", { chat_id: chat, text, link_preview_options: { is_disabled: true } });
        return;
      } catch (e) {
        if (attempt === 0 && e instanceof TelegramError && e.code === 429 && (e.retryAfter ?? 99) <= 10) { await wait((e.retryAfter ?? 1) * 1000); continue; }
        log.warn("telegram send failed", { code: e instanceof TelegramError ? e.code : "error" });
        return;
      }
    }
  }
}

const COMMANDS = [
  { command: "start", description: "What this is and how to connect" },
  { command: "key", description: "Connect your AnyRoute API key" },
  { command: "model", description: "Set your default model" },
  { command: "models", description: "Search models with prices" },
  { command: "forget", description: "Delete your stored key" },
  { command: "help", description: "Show the commands" },
];
