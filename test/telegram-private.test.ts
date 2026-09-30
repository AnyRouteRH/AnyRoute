import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { kv } from "../src/db/schema.ts";
import { balanceOf } from "../src/ledger/ledger.ts";
import { keys as keysTable } from "../src/db/schema.ts";
import { DEFAULT_MODEL, TelegramBot, attestedBadge, userKey, type RouterCall, type TgUpdate } from "../src/services/telegram.ts";
import { CLAIMS_OK } from "./aci-fixtures.ts";
import { GW_MODEL, PLAIN, startGatewayRouter } from "./aci-mock-gateway.ts";

// Private mode on Telegram (/private on|off): chats are sent with provider.lane "attested", /model and /models are
// restricted to models with a proven enclave, the footer carries the receipt's attested / GPU label and a verify link,
// and every fail-closed refusal is explained. Telegram is a stand-in for api.telegram.org; the router is the real one
// with one public provider and one attested aci/1 gateway.

const TOKEN = "123456789:AAFixtureTokenFixtureToken0123456789";

function mockTelegram() {
  const calls: { method: string; params: any }[] = [];
  const fetch = (async (input: any, init: any) => {
    const url = String(input);
    expect(url.startsWith(`https://api.telegram.org/bot${TOKEN}/`)).toBe(true);
    const method = url.slice(url.lastIndexOf("/") + 1);
    calls.push({ method, params: JSON.parse(init.body) });
    return Response.json({ ok: true, result: method === "getUpdates" ? [] : true });
  }) as unknown as typeof globalThis.fetch;
  const sent = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.params.text as string);
  return { fetch, calls, sent, last: () => sent().at(-1)! };
}

let nextMessage = 900;
const message = (uid: number, text: string): TgUpdate => ({ update_id: ++nextMessage, message: { message_id: nextMessage, from: { id: uid }, chat: { id: uid, type: "private" }, text } });

let fx: Awaited<ReturnType<typeof startGatewayRouter>>;
let tg: ReturnType<typeof mockTelegram>;
let bot: TelegramBot;
let routed: { path: string; body: any }[];
/** When set, the router answers /chat/completions with this instead of calling the app. */
let canned: (() => Response) | null = null;
let uid = 8000;
let keyHash = "";

const fresh = () => {
  tg = mockTelegram();
  routed = [];
  const router: RouterCall = async (path, init) => {
    routed.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (canned && path === "/api/v1/chat/completions") return canned();
    return fx.h.app.request(path, init);
  };
  bot = new TelegramBot(fx.h.ctx, { token: TOKEN, router, fetch: tg.fetch, pollTimeoutS: 0 });
};
const chatBodies = () => routed.filter((r) => r.path === "/api/v1/chat/completions").map((r) => r.body);
/** A fresh Telegram user connected with a funded key. */
const connected = async () => {
  const user = ++uid;
  const k = await fx.h.fundedKey(5n);
  keyHash = k.hash;
  await bot.handleUpdate(message(user, `/key ${k.secret}`));
  return { user, k };
};
const say = async (user: number, text: string) => {
  await bot.handleUpdate(message(user, text));
  return tg.last();
};
const rowOf = async (user: number) => ((await fx.h.ctx.db.select().from(kv).where(eq(kv.key, userKey(user))))[0]?.value ?? null) as Record<string, unknown> | null;
const balance = async () => {
  const [k] = await fx.h.ctx.db.select().from(keysTable).where(eq(keysTable.keyHash, keyHash));
  return (await balanceOf(fx.h.ctx.db, k.accountId)).balance;
};
const site = () => fx.h.ctx.cfg.publicUrl;
const footerOf = (reply: string) => reply.split("\n\n").at(-1)!;

beforeAll(async () => {
  fx = await startGatewayRouter();
});
afterAll(async () => fx.close());
beforeEach(async () => {
  canned = null;
  expect(await fx.reset()).toMatchObject({ provider: "gw", ok: true });
  fresh();
});

describe("/private", () => {
  test("is off by default, turns on and off per user, keeps the key and the model, and /forget clears it", async () => {
    const { user, k } = await connected();
    expect(await say(user, "/private")).toContain("Private mode is off");
    await say(user, `/model ${GW_MODEL}`);
    expect(await say(user, "/private on")).toContain("Private mode is on");
    expect(await rowOf(user)).toMatchObject({ v: 1, private: true, model: GW_MODEL });
    expect((await rowOf(user))!.key).toStartWith("v1.");
    expect(JSON.stringify(await rowOf(user))).not.toContain(k.secret);
    expect(await say(user, "/private")).toContain("Private mode is on");
    // Another user is unaffected.
    const other = await connected();
    expect(await say(other.user, "/private")).toContain("Private mode is off");
    expect(await rowOf(other.user)).not.toHaveProperty("private");
    expect(await say(user, "/private off")).toContain("Private mode is off");
    expect(await rowOf(user)).toEqual(expect.not.objectContaining({ private: expect.anything() }));
    expect(await rowOf(user)).toMatchObject({ model: GW_MODEL });
    expect(await say(user, "/PRIVATE ON")).toContain("Private mode is on");
    expect(await say(user, "/private maybe")).toContain("Send /private on or /private off");
    expect((await rowOf(user))!.private).toBe(true);
    await say(user, "/forget");
    expect(await say(user, "/private")).toContain("Private mode is off");
  });

  test("turning it on says what it does and does not show, and warns when the current model has no proven enclave", async () => {
    const { user } = await connected();
    const on = await say(user, "/private on");
    expect(on).toContain("only to providers whose TEE attestation the router has verified");
    expect(on).toContain("I send nothing and tell you why");
    expect(on).toContain("not what a provider does with your text");
    expect(on).toContain(`${site()}/verify`);
    // The default model is not served by an attested provider here, and the reply names one that is.
    expect(on).toContain(`Your model ${DEFAULT_MODEL} has no proven enclave right now`);
    expect(on).toContain(GW_MODEL);
    await say(user, `/model ${GW_MODEL}`);
    expect(await say(user, "/private on")).not.toContain("has no proven enclave");
    // With nothing attested, it says so plainly.
    await fx.makeStale();
    fresh();
    const none = await say(user, "/private on");
    expect(none).toContain("No model has a proven enclave right now");
    expect(none).toContain("/private off");
  });

  test("is in /help and in the command list", async () => {
    const user = ++uid;
    expect(await say(user, "/help")).toContain("/private on|off");
    expect(await say(user, "/help")).toContain("/models <search>");
    tg.calls.length = 0;
    // The first poll of a bot registers its command list.
    await bot.poll();
    const commands = tg.calls.find((c) => c.method === "setMyCommands")!.params.commands as { command: string }[];
    expect(commands.map((c) => c.command)).toContain("private");
  });
});

describe("/models and /model", () => {
  test("/models attested lists models with a proven enclave, marks GPU only after a receipt shows it, and leaves the plain search alone", async () => {
    const { user } = await connected();
    const listed = await say(user, "/models attested");
    expect(routed.map((r) => r.path)).toContain("/api/v1/models?lane=attested");
    expect(listed).toContain("Models with a proven enclave");
    expect(listed).toContain(`${GW_MODEL}\n  $1.00 in, $2.00 out per 1M tokens · attested`);
    expect(listed).not.toContain("GPU");
    expect(listed).not.toContain(PLAIN.slug);
    // The plain search still lists everything and adds no attested label.
    const plain = await say(user, "/models gwtest");
    expect(plain).toContain(`${PLAIN.slug}\n  $0.10 in, $0.20 out per 1M tokens`);
    expect(plain).toContain(GW_MODEL);
    expect(plain).not.toContain("attested ·");
    expect(plain).not.toContain("Models with a proven enclave");
    // After a verified receipt asserted GPU attestation, the listing says so.
    await say(user, `/model ${GW_MODEL}`);
    await say(user, "/private on");
    await say(user, "hello");
    await fx.h.ctx.catalog.refresh();
    fresh();
    expect(await say(user, "/models attested")).toContain(`per 1M tokens · attested · GPU`);
    // A search narrows it; a search with no attested match says so.
    expect(await say(user, "/models attested gateway")).toContain(GW_MODEL);
    expect(await say(user, "/models attested plain")).toContain("No model with a proven enclave matches that search.");
  });

  test("plain /models still asks for a search word, and mentions the attested filter", async () => {
    const user = ++uid;
    const reply = await say(user, "/models");
    expect(reply).toContain("Send /models followed by a search word");
    expect(reply).toContain("/models attested");
    expect(routed).toEqual([]);
  });

  test("with private mode on, /models lists only attested models, even for a search that would match others", async () => {
    const { user } = await connected();
    await say(user, "/private on");
    const bare = await say(user, "/models");
    expect(bare).toContain("Private mode is on, so these are models with a proven enclave");
    expect(bare).toContain(GW_MODEL);
    expect(bare).not.toContain(PLAIN.slug);
    const search = await say(user, "/models plain");
    expect(search).toContain("No model with a proven enclave matches that search.");
    expect(search).toContain("Private mode is on");
    await fx.makeStale();
    fresh();
    expect(await say(user, "/models")).toContain("No model has a proven enclave right now.");
  });

  test("/model in private mode takes only attested models, explains a live model that is not, and is unrestricted when private is off", async () => {
    const { user } = await connected();
    await say(user, "/private on");
    expect(await say(user, `/model ${GW_MODEL}`)).toContain(`Model set to ${GW_MODEL}`);
    expect(tg.last()).toContain("A provider with a router-verified enclave serves it now");
    const refused = await say(user, `/model ${PLAIN.slug}`);
    expect(refused).toContain(`${PLAIN.slug} is live, but no provider with a proven enclave serves it right now`);
    expect(refused).toContain("/models attested");
    expect(refused).toContain("/private off");
    expect((await rowOf(user))!.model).toBe(GW_MODEL); // unchanged
    expect(await say(user, "/model nope/none")).toContain("not in the live catalog");
    expect(await say(user, "/model")).toContain("Private mode is on, so only models with a proven enclave can be used");
    await say(user, "/private off");
    expect(await say(user, `/model ${PLAIN.slug}`)).toContain(`Model set to ${PLAIN.slug}`);
    expect(tg.last()).not.toContain("enclave");
    expect(await say(user, "/model")).not.toContain("Private mode");
  });
});

describe("chatting in private mode", () => {
  test("asks the router for the attested lane, labels the answer from its receipt, and links the provider's verification record", async () => {
    const { user } = await connected();
    await say(user, `/model ${GW_MODEL}`);
    await say(user, "/private on");
    const reply = await say(user, "tell me something");
    expect(chatBodies()).toEqual([{ model: GW_MODEL, messages: [{ role: "user", content: "tell me something" }], max_tokens: 2048, provider: { lane: "attested" } }]);
    expect(reply).toStartWith("hello from the gateway\n\n");
    const m = new RegExp(`^${GW_MODEL} · \\$([0-9.]+) · [0-9.]+s · attested · GPU · receipt (\\S+)/api/v1/receipts/(gen-[\\w-]+) · verify (\\S+)/verify\\?p=gw$`).exec(footerOf(reply));
    expect(m).not.toBeNull();
    expect(m![2]).toBe(site());
    expect(m![4]).toBe(site());
    // The label is what the signed receipt says.
    const receipt = ((await (await fx.h.request(`/api/v1/receipts/${m![3]}`)).json()) as any).data;
    expect(receipt.payload).toMatchObject({ lane: "attested", disclosure: "attested", provider: "gw", upstream_attestation: { attested: true, gpu_attested: true } });
    expect(Number(m![1])).toBeCloseTo(Number(receipt.payload.cost), 5);
    // The gateway was asked for attested, zero-retention serving.
    expect(fx.state.requests.at(-1)!.body.provider).toEqual({ aci_verified: true, zdr: true });
    // The verify link is a page the router's attestation record backs.
    expect(((await (await fx.h.request("/api/v1/attestation/gw")).json()) as any).data.status).toBe("attested");
  });

  test("the line before the footer says a proven enclave read the prompt, from the receipt", async () => {
    const { user } = await connected();
    await say(user, `/model ${GW_MODEL}`);
    await say(user, "/private on");
    const paragraphs = (await say(user, "tell me something")).split("\n\n");
    expect(paragraphs.at(-2)).toBe("Read by: Telegram + router + proven enclave · IP: seen by Telegram, not AnyRoute · Paid: API key balance");
  });

  test("says only \"attested\" when the receipt does not assert GPU attestation", async () => {
    const { user } = await connected();
    await say(user, `/model ${GW_MODEL}`);
    await say(user, "/private on");
    fx.state.claims = { ...CLAIMS_OK, gpu_attested: { status: "unknown" } };
    const footer = footerOf(await say(user, "and now?"));
    expect(footer).toContain(" · attested · receipt ");
    expect(footer).not.toContain("GPU");
    expect(footer).toContain("/verify?p=gw");
  });

  test("without private mode nothing changes: no lane in the request, no attestation label, no verify link", async () => {
    const { user } = await connected();
    await say(user, `/model ${GW_MODEL}`);
    const reply = await say(user, "plain question");
    expect(chatBodies()[0]).toEqual({ model: GW_MODEL, messages: [{ role: "user", content: "plain question" }], max_tokens: 2048 });
    const m = new RegExp(`^${GW_MODEL} · \\$([0-9.]+) · [0-9.]+s · receipt (\\S+)/api/v1/receipts/(gen-[\\w-]+)$`).exec(footerOf(reply));
    expect(m).not.toBeNull();
    expect(reply).not.toContain(" · attested");
    expect(reply).not.toContain("/verify");
  });

  test("a model with no proven enclave is refused by the router; the bot says nothing was sent or charged", async () => {
    const { user } = await connected();
    await say(user, `/model ${PLAIN.slug}`); // private is off, so this is allowed
    await say(user, "/private on");
    const before = await balance();
    const reply = await say(user, "this must stay private");
    expect(chatBodies()[0].provider).toEqual({ lane: "attested" });
    expect(reply).toContain(`No provider with a proven enclave can answer ${PLAIN.slug} right now`);
    expect(reply).toContain("I sent nothing and you were not charged");
    expect(reply).toContain("/models attested");
    expect(reply).toContain("/private off");
    expect(reply).not.toContain("this must stay private");
    expect(await balance()).toBe(before);
    expect(fx.state.requests).toEqual([]);
  });

  test("an attestation that lapses after the catalog was read still fails closed", async () => {
    const { user } = await connected();
    await say(user, `/model ${GW_MODEL}`); // caches nothing for the attested lane yet
    await say(user, "/private on");
    expect(await say(user, "/models attested")).toContain(GW_MODEL); // the bot's catalog now says the model is fine
    await fx.makeStale();
    const before = await balance();
    const reply = await say(user, "still private?");
    expect(reply).toContain("I sent nothing and you were not charged");
    expect(reply).toContain(GW_MODEL);
    expect(await balance()).toBe(before);
    expect(fx.state.requests).toEqual([]);
  });

  test("an answer whose receipt does not prove an attested upstream is withheld, billed, and the reason and receipt are given", async () => {
    const { user } = await connected();
    await say(user, `/model ${GW_MODEL}`);
    await say(user, "/private on");
    fx.state.upstream = "routed";
    const before = await balance();
    const reply = await say(user, "hi");
    expect(reply).toContain("I withheld it");
    expect(reply).toContain("billed as usual");
    expect(reply).toContain("the upstream was not verified");
    expect(reply).toMatch(new RegExp(`Receipt: ${site()}/api/v1/receipts/gen-[\\w-]+`));
    expect(tg.sent().join("\n")).not.toContain("hello from the gateway");
    expect(await balance()).toBeLessThan(before);
    const id = /receipts\/(gen-[\w-]+)/.exec(reply)![1];
    expect(((await (await fx.h.request(`/api/v1/receipts/${id}`)).json()) as any).data.payload.upstream_attestation.attested).toBe(false);
  });

  test("the router being down or busy is still explained plainly", async () => {
    const { user } = await connected();
    await say(user, `/model ${GW_MODEL}`);
    await say(user, "/private on");
    canned = () => Response.json({ error: { code: 503, type: "disclosure_provider_unavailable", message: "temporarily unavailable" } }, { status: 503 });
    const busy = await say(user, "hi");
    expect(busy).toContain("temporarily unavailable");
    expect(busy).toContain("I did not send your message to any other provider and you were not charged");
    canned = () => Response.json({ error: { code: 502, message: "boom" } }, { status: 502 });
    expect(await say(user, "hi")).toContain("couldn't get an answer from a provider");
  });
});

describe("the label is taken from the receipt, never assumed", () => {
  const answer = (payload: Record<string, unknown> | undefined) =>
    Response.json({ id: "gen-x", model: GW_MODEL, choices: [{ message: { content: "a reply" } }], usage: { cost: 0.001 }, receipt: { id: "gen-x", ...(payload ? { payload } : {}) } });
  const ready = async () => {
    const { user } = await connected();
    await say(user, `/model ${GW_MODEL}`);
    await say(user, "/private on");
    return user;
  };

  test("a receipt that shows the public lane, another class, no payload or an unattested upstream is not delivered", async () => {
    const user = await ready();
    for (const payload of [
      { lane: "public", disclosure: "attested", provider: "gw" },
      { lane: "attested", disclosure: "policy", provider: "gw" },
      { lane: "attested", disclosure: "vendor-forwarded", provider: "gw" },
      { lane: "attested", disclosure: "attested", provider: "gw", upstream_attestation: { attested: false, gpu_attested: true } },
      { lane: "attested", disclosure: "attested", provider: "gw", upstream_attestation: { gpu_attested: true } },
      undefined,
    ]) {
      canned = () => answer(payload);
      const reply = await say(user, "hi");
      expect(reply).toContain("does not show an attested provider, so I did not deliver it");
      expect(reply).toContain("billed as usual");
      expect(reply).toContain(`Receipt: ${site()}/api/v1/receipts/gen-x`);
      expect(reply).not.toContain("a reply");
    }
  });

  test("GPU is claimed only when the gateway's receipt check asserts it", () => {
    const base = { lane: "attested", disclosure: "attested" };
    expect(attestedBadge({ ...base, upstream_attestation: { attested: true, gpu_attested: true } })).toBe("attested · GPU");
    expect(attestedBadge({ ...base, upstream_attestation: { attested: true, gpu_attested: false } })).toBe("attested");
    expect(attestedBadge({ ...base, upstream_attestation: { attested: true, gpu_attested: "yes" } })).toBe("attested");
    expect(attestedBadge(base)).toBe("attested"); // a sidecar provider: attested, no GPU statement
    expect(attestedBadge({ ...base, attestation_simulated: true })).toBe("attested (development report, not hardware)");
    expect(attestedBadge({ lane: "attested", disclosure: "policy" })).toBeNull();
    expect(attestedBadge(undefined)).toBeNull();
  });

  test("a provider id that is not a plain id gets no verify link; a real one does", async () => {
    const user = await ready();
    canned = () => answer({ lane: "attested", disclosure: "attested", provider: "../x?y=z" });
    const odd = await say(user, "hi");
    expect(footerOf(odd)).toContain(" · attested · receipt ");
    expect(footerOf(odd)).not.toContain("/verify");
    canned = () => answer({ lane: "attested", disclosure: "attested", provider: "some.provider-1" });
    expect(footerOf(await say(user, "hi"))).toEndWith(`verify ${site()}/verify?p=some.provider-1`);
  });

  test("a development report is labelled as one", async () => {
    const user = await ready();
    canned = () => answer({ lane: "attested", disclosure: "attested", provider: "dev", attestation_simulated: true });
    expect(footerOf(await say(user, "hi"))).toContain(" · attested (development report, not hardware) · ");
  });
});
