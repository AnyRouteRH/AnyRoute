import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { kv } from "../src/db/schema.ts";
import { decrypt, setLogLevel } from "../src/lib/util.ts";
import { MAX_TEXT, OFFSET_KEY, RATE_PER_MINUTE, TelegramBot, splitMessage, userKey, type RouterCall, type TgUpdate } from "../src/services/telegram.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";

const TOKEN = "123456789:AAFixtureTokenFixtureToken0123456789";
const LLAMA = MODELS.llama.slug;
const QWEN = MODELS.qwen.slug;

/** A stand-in for api.telegram.org: records every call in `events` (shared with the router wrapper) and
 * lets a test script getUpdates batches and failures. */
function mockTelegram(events: string[] = []) {
  const calls: { method: string; params: any }[] = [];
  const batches: TgUpdate[][] = [];
  const fail: Record<string, { code: number; description: string }> = {};
  const fetch = (async (input: any, init: any) => {
    const url = String(input);
    expect(url.startsWith(`https://api.telegram.org/bot${TOKEN}/`)).toBe(true);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const params = JSON.parse(init.body);
    calls.push({ method, params });
    events.push(`telegram:${method}`);
    if (fail[method]) return Response.json({ ok: false, error_code: fail[method].code, description: fail[method].description });
    return Response.json({ ok: true, result: method === "getUpdates" ? (batches.shift() ?? []) : true });
  }) as unknown as typeof globalThis.fetch;
  const of = (method: string) => calls.filter((c) => c.method === method).map((c) => c.params);
  return { fetch, calls, batches, fail, of, sent: () => of("sendMessage").map((p) => p.text as string), last: () => of("sendMessage").at(-1)!.text as string };
}

let nextMessage = 100;
const message = (uid: number, text: string, extra: { type?: string; chat?: number; id?: number } = {}): TgUpdate => ({
  update_id: ++nextMessage,
  message: { message_id: extra.id ?? nextMessage, from: { id: uid }, chat: { id: extra.chat ?? uid, type: extra.type ?? "private" }, text },
});

describe("AnyRoute on Telegram", () => {
  let h: Harness;
  let events: string[];
  let tg: ReturnType<typeof mockTelegram>;
  let bot: TelegramBot;
  let gate: Promise<void> | null = null;
  let uid = 5000;

  const fresh = () => {
    events = [];
    tg = mockTelegram(events);
    const router: RouterCall = async (path, init) => {
      events.push(`router:${path}`);
      if (gate && path === "/api/v1/chat/completions") await gate;
      return h.app.request(path, init);
    };
    bot = new TelegramBot(h.ctx, { token: TOKEN, router, fetch: tg.fetch, pollTimeoutS: 0 });
  };
  /** A fresh Telegram user connected with a funded key. */
  const connected = async () => {
    const user = ++uid;
    const k = await h.fundedKey();
    await bot.handleUpdate(message(user, `/key ${k.secret}`));
    return { user, k };
  };

  beforeAll(async () => {
    h = await startRouter();
  });
  afterAll(async () => {
    await h.close();
  });

  test("is off without a token, and registers the job only with one", async () => {
    expect(h.ctx.cfg.telegram.botToken).toBeUndefined();
    expect(h.ctx.telegram).toBeUndefined();
    expect(h.ctx.jobs.status().map((j) => j.name)).not.toContain("telegram-bot");

    const on = await startRouter({ env: { TELEGRAM_BOT_TOKEN: TOKEN } });
    try {
      expect(on.ctx.telegram).toBeDefined();
      expect(on.ctx.jobs.status().map((j) => j.name)).toContain("telegram-bot");
    } finally {
      await on.close();
    }
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: "not-a-token" })).toThrow(/BotFather/);
    try {
      loadConfig({ TELEGRAM_BOT_TOKEN: "not-a-token" });
    } catch (e) {
      expect((e as Error).message).not.toContain("not-a-token");
    }
  });

  test("/key deletes the message first, validates against the router and stores the key encrypted", async () => {
    fresh();
    const user = ++uid;
    const k = await h.fundedKey();
    await bot.handleUpdate(message(user, `/key ${k.secret}`, { id: 777 }));

    expect(tg.of("deleteMessage")).toEqual([{ chat_id: user, message_id: 777 }]);
    expect(events.indexOf("telegram:deleteMessage")).toBeLessThan(events.indexOf("router:/api/v1/key"));
    expect(tg.last()).toContain("Connected.");
    expect(tg.last()).toContain("I deleted your message");
    expect(tg.last()).toContain("no spend limit"); // the fixture key is uncapped: the bot recommends a capped one

    const [row] = await h.ctx.db.select().from(kv).where(eq(kv.key, userKey(user)));
    const stored = JSON.stringify(row.value);
    expect(stored).not.toContain(k.secret);
    expect(stored).not.toContain(k.hash);
    expect((row.value as { key: string }).key.startsWith("v1.")).toBe(true);
    expect(decrypt(h.ctx.cfg.appSecret, (row.value as { key: string }).key)).toBe(`tg:${user}:${k.secret}`);
  });

  test("/key with a wrong key still deletes the message and stores nothing", async () => {
    fresh();
    const user = ++uid;
    const wrong = "sk-ar-v1-" + "0".repeat(64);
    await bot.handleUpdate(message(user, `/key ${wrong}`, { id: 41 }));
    expect(tg.of("deleteMessage")).toEqual([{ chat_id: user, message_id: 41 }]);
    expect(tg.last()).toContain("rejected that key");
    await bot.handleUpdate(message(user, "/key definitely-not-a-key", { id: 42 }));
    expect(tg.of("deleteMessage")).toHaveLength(2);
    expect(tg.last()).toContain("not an AnyRoute API key");
    expect(await h.ctx.db.select().from(kv).where(eq(kv.key, userKey(user)))).toHaveLength(0);
  });

  test("a message whose delete fails tells the user to delete it", async () => {
    fresh();
    tg.fail.deleteMessage = { code: 400, description: "Bad Request: message can't be deleted" };
    const k = await h.fundedKey();
    await bot.handleUpdate(message(++uid, `/key ${k.secret}`));
    expect(tg.last()).toContain("Connected.");
    expect(tg.last()).toContain("please delete it yourself");
  });

  test("a key pasted as a plain message is deleted and never sent to a model", async () => {
    fresh();
    const user = ++uid;
    const k = await h.fundedKey();
    await bot.handleUpdate(message(user, `here you go ${k.secret}`, { id: 9 }));
    expect(tg.of("deleteMessage")).toEqual([{ chat_id: user, message_id: 9 }]);
    expect(events.filter((e) => e.startsWith("router:"))).toEqual([]);
    expect(tg.last()).toContain("did not send it to any model");
    expect(tg.last()).not.toContain(k.secret);
  });

  test("answers with the model reply and a footer carrying a public, verifiable receipt id", async () => {
    fresh();
    const { user } = await connected();
    await bot.handleUpdate(message(user, "Say hello to Telegram"));
    const reply = tg.last();
    const footer = reply.split("\n\n").at(-1)!;
    const m = new RegExp(`^${LLAMA.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} · \\$([0-9.]+) · [0-9.]+s · receipt (\\S+)/api/v1/receipts/(gen-[\\w-]+)$`).exec(footer);
    expect(m).not.toBeNull();
    expect(m![2]).toBe(h.ctx.cfg.publicUrl);
    expect(reply.length).toBeGreaterThan(footer.length + 2); // the answer comes before the footer
    expect(tg.of("sendMessage").at(-1).link_preview_options).toEqual({ is_disabled: true });
    expect(tg.of("sendChatAction").at(-1)).toEqual({ chat_id: user, action: "typing" });

    const receipt = await (await h.request(`/api/v1/receipts/${m![3]}`)).json();
    expect(receipt.data.id).toBe(m![3]);
    expect(typeof receipt.data.sig).toBe("string");
    expect(Number(m![1])).toBeCloseTo(Number(receipt.data.payload.cost), 5);
  });

  test("/model validates against the live catalog and /models shows prices", async () => {
    fresh();
    const { user } = await connected();
    await bot.handleUpdate(message(user, "/model nope/none"));
    expect(tg.last()).toContain("not in the live catalog");
    await bot.handleUpdate(message(user, `/model ${QWEN}`));
    expect(tg.last()).toContain(`Model set to ${QWEN}`);
    await bot.handleUpdate(message(user, "hi"));
    expect(tg.last().split("\n\n").at(-1)!.startsWith(`${QWEN} · `)).toBe(true);

    await bot.handleUpdate(message(user, "/models llama"));
    expect(tg.last()).toContain(`${LLAMA}\n  $0.10 in, $0.32 out per 1M tokens`);
    expect(tg.last()).not.toContain(QWEN);
    await bot.handleUpdate(message(user, "/models zzzz-nothing"));
    expect(tg.last()).toContain("No live model matches");
  });

  test("/forget deletes the stored key", async () => {
    fresh();
    const { user } = await connected();
    expect(await h.ctx.db.select().from(kv).where(eq(kv.key, userKey(user)))).toHaveLength(1);
    await bot.handleUpdate(message(user, "/forget"));
    expect(await h.ctx.db.select().from(kv).where(eq(kv.key, userKey(user)))).toHaveLength(0);
    events.length = 0;
    await bot.handleUpdate(message(user, "still there?"));
    expect(tg.last()).toContain("Connect your AnyRoute key first");
    expect(events.filter((e) => e.startsWith("router:"))).toEqual([]);
  });

  test("group, supergroup and channel messages are ignored without a reply", async () => {
    fresh();
    const k = await h.fundedKey();
    for (const type of ["group", "supergroup", "channel"]) {
      for (const text of ["/start", "/help", "hello", `/key ${k.secret}`]) await bot.handleUpdate(message(++uid, text, { type, chat: -100123 }));
    }
    await bot.handleUpdate({ update_id: 1, message: { message_id: 1, from: { id: 1, is_bot: true }, chat: { id: 1, type: "private" }, text: "hi" } });
    expect(tg.calls).toEqual([]);
    expect(events).toEqual([]);
  });

  test("friendly replies for router failures", async () => {
    fresh();
    const user = ++uid;
    const poor = await h.newKey(); // valid key with no balance
    await bot.handleUpdate(message(user, `/key ${poor.secret}`));
    expect(tg.last()).toContain("Connected.");
    await bot.handleUpdate(message(user, "can I afford this?"));
    expect(tg.last()).toContain("Your key can't pay for that");
    const { user: u2 } = await connected();
    await h.ctx.db.update(kv).set({ value: { v: 1, key: "v1.a.b.c" } }).where(eq(kv.key, userKey(u2))); // corrupt ciphertext
    await bot.handleUpdate(message(u2, "hello"));
    expect(tg.last()).toContain("Connect your AnyRoute key first");
  });

  test("one request at a time per user, and 20 requests a minute", async () => {
    fresh();
    const { user } = await connected();
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const first = bot.handleUpdate(message(user, "slow one"));
    await Bun.sleep(20);
    await bot.handleUpdate(message(user, "second"));
    expect(tg.last()).toContain("still answering your previous message");
    release();
    await first;
    gate = null;
    expect(tg.last().split("\n\n").at(-1)).toContain("receipt ");

    const other = await connected();
    for (let i = 0; i < RATE_PER_MINUTE - 1; i++) await bot.handleUpdate(message(other.user, `q${i}`)); // /key used one slot
    expect(tg.last()).toContain("receipt ");
    await bot.handleUpdate(message(other.user, "one too many"));
    expect(tg.last()).toContain(`limit ${RATE_PER_MINUTE} a minute`);
  });

  test("long replies split at Telegram's limit without breaking words or surrogate pairs", () => {
    const words = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(" ");
    const parts = splitMessage(words);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= MAX_TEXT)).toBe(true);
    expect(parts.join(" ")).toBe(words);
    const emoji = "😀".repeat(MAX_TEXT); // 2 UTF-16 units each, no spaces: forced hard cuts
    const cut = splitMessage(emoji);
    expect(cut.every((p) => p.length <= MAX_TEXT && !/[\ud800-\udbff]$/.test(p))).toBe(true);
    expect(cut.join("")).toBe(emoji);
    expect(splitMessage("short")).toEqual(["short"]);
  });

  test("a long model reply is sent in several messages, the footer last", async () => {
    fresh();
    const { user } = await connected();
    const long = `${"lorem ipsum dolor ".repeat(400)}`;
    const original = h.app.request;
    const router: RouterCall = async (path, init) => {
      const res = await original.call(h.app, path, init);
      if (path !== "/api/v1/chat/completions" || !res.ok) return res;
      const body = await res.json();
      body.choices[0].message.content = long;
      return Response.json(body);
    };
    bot = new TelegramBot(h.ctx, { token: TOKEN, router, fetch: tg.fetch, pollTimeoutS: 0 });
    tg.calls.length = 0;
    await bot.handleUpdate(message(user, "write a lot"));
    const sent = tg.sent();
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((t) => t.length <= MAX_TEXT)).toBe(true);
    expect(sent.at(-1)).toContain("receipt ");
    expect(sent.slice(0, -1).some((t) => t.includes("receipt "))).toBe(false);
  });

  test("polling stores the offset, ignores groups, and stops cleanly", async () => {
    fresh();
    const user = ++uid;
    tg.batches.push([message(user, "/help"), message(user, "hey", { type: "group", chat: -5 })]);
    const first = await bot.poll();
    expect(first).toEqual({ updates: 2 });
    await bot.idle();
    const [row] = await h.ctx.db.select().from(kv).where(eq(kv.key, OFFSET_KEY));
    const stored = row.value as number;
    expect(stored).toBeGreaterThan(nextMessage - 2);
    expect(tg.sent()).toHaveLength(1);
    expect(tg.last()).toContain("/models <search>");
    expect(tg.of("setMyCommands")).toHaveLength(1);
    await bot.poll();
    expect(tg.of("getUpdates").at(-1).offset).toBe(stored);
    expect(tg.of("getUpdates").at(-1).allowed_updates).toEqual(["message"]);

    tg.fail.getUpdates = { code: 409, description: "Conflict: terminated by other getUpdates request" };
    expect(await bot.poll()).toEqual({ error: 409 });
    const calls = tg.of("getUpdates").length;
    expect(await bot.poll()).toEqual({ idle: true }); // backing off, no request
    expect(tg.of("getUpdates")).toHaveLength(calls);

    await bot.stop();
    expect(await bot.poll()).toEqual({ idle: true });
  });

  test("stopping aborts a getUpdates that is still waiting", async () => {
    fresh();
    let aborted = false;
    const hanging = (async (_url: any, init: any) => {
      if (String(_url).endsWith("/getUpdates")) return new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }));
      return Response.json({ ok: true, result: true });
    }) as unknown as typeof globalThis.fetch;
    bot = new TelegramBot(h.ctx, { token: TOKEN, router: (p, i) => h.app.request(p, i), fetch: hanging });
    const polling = bot.poll();
    await Bun.sleep(30);
    await bot.stop();
    expect(aborted).toBe(true);
    expect(await polling).toEqual({ stopped: true });
  });

  test("keys, message text and the bot token never reach the logs", async () => {
    fresh();
    const secretText = "my-very-private-question-9f3a";
    const written: string[] = [];
    const realLog = console.log, realErr = console.error;
    console.log = (...a: unknown[]) => void written.push(a.join(" "));
    console.error = (...a: unknown[]) => void written.push(a.join(" "));
    setLogLevel("debug");
    try {
      const { user, k } = await connected();
      tg.fail.sendMessage = { code: 403, description: "Forbidden: bot was blocked by the user" };
      await bot.handleUpdate(message(user, secretText));
      tg.fail.getUpdates = { code: 401, description: "Unauthorized" };
      await bot.poll();
      await bot.handleUpdate(message(user, `${k.secret} ${secretText}`));
      expect(written.some((l) => l.includes("telegram send failed"))).toBe(true);
      expect(written.some((l) => l.includes("telegram poll failed"))).toBe(true);
      const all = written.join("\n");
      for (const secret of [k.secret, k.hash, secretText, TOKEN, TOKEN.split(":")[1]]) expect(all).not.toContain(secret);
    } finally {
      console.log = realLog;
      console.error = realErr;
      setLogLevel("error");
    }
  });
});
