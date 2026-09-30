import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { crc32 as zlibCrc32, deflateSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { ADMIN, MODELS, sse, startRouter, type Harness } from "./helpers.ts";
import { characterMemory, characterUsage, characters, generations } from "../src/db/schema.ts";
import { runAttestor } from "../src/services/attestor.ts";
import {
  CardError,
  applyMacros,
  b64ToBytes,
  buildCharacterMessages,
  bytesToB64,
  cardHash,
  deriveViewingKey,
  matchLorebook,
  memoryForPrompt,
  memoryScope,
  normalizeCard,
  open,
  openCard,
  openMemory,
  pickSpeaker,
  readCardFromPng,
  readPngChunks,
  seal,
  sealCard,
  sealMemory,
  toV2,
  toV3,
  viewingKeyFromPassphrase,
  writeCardToPng,
  writePngChunks,
  type CharacterBook,
  type LoreEntry,
} from "../packages/client/src/characters.ts";

const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const QWEN = "qwen/qwen3-32b";
const SECRET_PHRASE = "the-lighthouse-keeper-whispers-7731";

const entry = (over: Partial<LoreEntry>): LoreEntry => ({ keys: [], content: "", extensions: {}, enabled: true, insertion_order: 0, ...over });

const V2 = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "Mira",
    description: "{{char}} is a cartographer who maps islands that move.",
    personality: "curious, dry humour",
    scenario: "A storm pins {{user}} and {{char}} in a harbour tavern.",
    first_mes: "Evening, {{user}}. Sit, the map is still wet.",
    mes_example: "<START>\n{{user}}: Where is the island today?\n{{char}}: East of yesterday.",
    creator_notes: "Works best with a slow pace.",
    system_prompt: "{{original}} Keep replies under 120 words.",
    post_history_instructions: "Reply as {{char}} only.",
    alternate_greetings: ["You again, {{user}}?", "The lamp flickers as {{user}} walks in."],
    character_book: {
      name: "Harbour lore",
      scan_depth: 3,
      token_budget: 500,
      extensions: {},
      entries: [
        { keys: ["lighthouse"], content: "The lighthouse has been dark for ten years.", extensions: {}, enabled: true, insertion_order: 20, id: 1 },
        { keys: ["storm"], content: "Storms here last three days.", extensions: {}, enabled: true, insertion_order: 10, id: 2, position: "before_char" },
        { keys: ["map"], secondary_keys: ["wet", "ink"], selective: true, content: "Wet ink runs on her maps.", extensions: {}, enabled: true, insertion_order: 30, id: 3 },
        { keys: [], constant: true, content: "The tavern is called The Drift.", extensions: {}, enabled: true, insertion_order: 5, id: 4 },
        { keys: ["kraken"], content: "Never mention the kraken.", extensions: {}, enabled: false, insertion_order: 1, id: 5 },
      ],
    },
    tags: ["Fantasy", "adventure", "fantasy"],
    creator: "mapmaker",
    character_version: "1.2",
    extensions: { talkativeness: "0.5", depth_prompt: { depth: 4, prompt: "x" } },
  },
};

const V3 = {
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    ...V2.data,
    name: "Zoë Brightwater",
    nickname: "Zoë",
    group_only_greetings: ["Zoë waves at the group."],
    creator_notes_multilingual: { fr: "Lent." },
    source: ["https://cards.example/zoe"],
    creation_date: 1_700_000_000,
    modification_date: 1_700_000_100,
    assets: [{ type: "icon", uri: "ccdefault:", name: "main", ext: "png" }],
    character_book: { extensions: {}, entries: [{ keys: ["/drag(on|ons)\\b/"], use_regex: true, content: "Dragons nest on the north cliffs 🐉.", extensions: {}, enabled: true, insertion_order: 1 }] },
  },
};

/** A real PNG built here: a 2x2 RGBA image (IHDR, zlib IDAT, IEND), CRCs from node:zlib. */
function buildPng(extra: { keyword: string; text: string }[] = []) {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, zlibCrc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, 2);
  iv.setUint32(4, 2);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array([0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255]);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), ...extra.map((e) => chunk("tEXt", new Uint8Array([...Buffer.from(e.keyword, "latin1"), 0, ...Buffer.from(e.text, "latin1")]))), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  return new Uint8Array(Buffer.concat(parts));
}
const crcOk = (png: Uint8Array) => {
  const v = new DataView(png.buffer, png.byteOffset);
  let at = 8;
  while (at < png.length) {
    const len = v.getUint32(at);
    if (v.getUint32(at + 8 + len) !== zlibCrc32(png.subarray(at + 4, at + 8 + len))) return false;
    at += 12 + len;
  }
  return true;
};

// ---- cards ---------------------------------------------------------------------------------------------

describe("character cards (pure)", () => {
  test("the router and the client share one module, word for word", () => {
    const a = readFileSync(new URL("../src/characters/card.ts", import.meta.url), "utf8");
    const b = readFileSync(new URL("../packages/client/src/characters.ts", import.meta.url), "utf8");
    expect(a).toBe(b);
  });

  test("v2 JSON keeps every field; v1 flat cards become v2; unknown specs are refused", () => {
    const c = normalizeCard(V2);
    expect(c.spec).toBe("chara_card_v2");
    for (const k of ["name", "description", "personality", "scenario", "first_mes", "mes_example", "system_prompt", "post_history_instructions", "creator", "creator_notes", "character_version"] as const)
      expect(c.data[k]).toBe((V2.data as Record<string, unknown>)[k] as string);
    expect(c.data.alternate_greetings).toEqual(V2.data.alternate_greetings);
    expect(c.data.tags).toEqual(["Fantasy", "adventure", "fantasy"]);
    expect(c.data.extensions).toEqual(V2.data.extensions);
    expect(c.data.character_book?.entries).toHaveLength(5);
    expect(c.data.character_book?.entries[2]).toMatchObject({ keys: ["map"], secondary_keys: ["wet", "ink"], selective: true });
    expect(normalizeCard(JSON.stringify(V2))).toEqual(c);
    const v1 = normalizeCard({ name: "Old", description: "d", personality: "p", scenario: "s", first_mes: "hi", mes_example: "" });
    expect(v1).toMatchObject({ spec: "chara_card_v2", data: { name: "Old", first_mes: "hi", alternate_greetings: [], tags: [] } });
    expect(() => normalizeCard({ spec: "chara_card_v9", data: { name: "x" } })).toThrow(CardError);
    expect(() => normalizeCard({ spec: "chara_card_v2", data: { description: "no name" } })).toThrow("no name");
    expect(() => normalizeCard("{not json")).toThrow(CardError);
  });

  test("v3 keeps its own fields; converting to v2 drops them and back to v3 restores the spec", () => {
    const c = normalizeCard(V3);
    expect(c.data).toMatchObject({ nickname: "Zoë", group_only_greetings: ["Zoë waves at the group."], source: ["https://cards.example/zoe"], creation_date: 1_700_000_000, assets: [{ type: "icon" }] });
    expect(c.data.character_book?.entries[0]?.use_regex).toBe(true);
    const two = toV2(c);
    expect(two.spec).toBe("chara_card_v2");
    expect("nickname" in two.data || "assets" in two.data || "group_only_greetings" in two.data).toBe(false);
    expect(two.data.character_book?.entries[0]?.use_regex).toBeUndefined();
    expect(toV3(normalizeCard(V2))).toMatchObject({ spec: "chara_card_v3", spec_version: "3.0", data: { group_only_greetings: [] } });
    expect(normalizeCard(JSON.parse(JSON.stringify(c)))).toEqual(c);
  });

  test("the hash is SHA-256 of the canonical card: key order and v1/v2 form do not change it, content does", async () => {
    const h = await cardHash(V2);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    const reordered = { data: Object.fromEntries(Object.entries(V2.data).reverse()), spec_version: "2.0", spec: "chara_card_v2" };
    expect(await cardHash(reordered)).toBe(h);
    expect(await cardHash({ ...V2, data: { ...V2.data, personality: "curious" } })).not.toBe(h);
    const flat = { name: "Old", description: "d", first_mes: "hi" };
    expect(await cardHash(flat)).toBe(await cardHash({ spec: "chara_card_v2", spec_version: "2.0", data: flat }));
  });

  test("PNG round trip, v2: a real PNG gets a `chara` chunk before IEND with valid CRCs and reads back the same card", () => {
    const png = buildPng();
    const out = writeCardToPng(V2, png, "v2");
    expect(crcOk(out)).toBe(true);
    const types = readPngChunks(out).map((c) => c.type);
    expect(types).toEqual(["IHDR", "IDAT", "tEXt", "IEND"]);
    expect(readCardFromPng(out)).toEqual(normalizeCard(V2));
    // The image data is untouched.
    expect(readPngChunks(out).find((c) => c.type === "IDAT")!.data).toEqual(readPngChunks(png).find((c) => c.type === "IDAT")!.data);
  });

  test("PNG round trip, v3: `ccv3` and a v2 `chara` chunk; ccv3 wins on read; UTF-8 survives; old card chunks are replaced", () => {
    const stale = bytesToB64(new TextEncoder().encode(JSON.stringify({ name: "Stale", first_mes: "old" })));
    const png = buildPng([{ keyword: "chara", text: stale }, { keyword: "Comment", text: "made by hand" }]);
    expect(readCardFromPng(png).data.name).toBe("Stale"); // a v1 card in a chara chunk reads too
    const out = writeCardToPng(V3, png, "v3");
    expect(crcOk(out)).toBe(true);
    const texts = readPngChunks(out).filter((c) => c.type === "tEXt").map((c) => Buffer.from(c.data).toString("latin1").split("\0")[0]);
    expect(texts).toEqual(["Comment", "ccv3", "chara"]);
    const back = readCardFromPng(out);
    expect(back).toEqual(normalizeCard(V3));
    expect(back.data.name).toBe("Zoë Brightwater");
    expect(back.data.character_book?.entries[0]?.content).toContain("🐉");
    // A reader that only knows `chara` gets the v2 form.
    const charaOnly = writePngChunks(readPngChunks(out).filter((c) => !Buffer.from(c.data).toString("latin1").startsWith("ccv3\0")));
    expect(readCardFromPng(charaOnly)).toEqual(toV2(normalizeCard(V3)));
    // No image: a 1x1 PNG is used.
    expect(readCardFromPng(writeCardToPng(V2))).toEqual(normalizeCard(V2));
    expect(() => readCardFromPng(buildPng())).toThrow("no character card");
    expect(() => readCardFromPng(new Uint8Array([1, 2, 3]))).toThrow("Not a PNG");
  });
});

// ---- lorebook and prompt ------------------------------------------------------------------------------

describe("lorebook matching", () => {
  const book = normalizeCard(V2).data.character_book as CharacterBook;
  const say = (...texts: string[]) => texts.map((t) => ({ role: "user", content: t }));

  test("keys match case-insensitively; constant entries always; disabled never; results follow insertion_order", () => {
    const hits = matchLorebook(book, say("Is the LIGHTHOUSE lit?", "and the Storm?"));
    expect(hits.map((e) => e.id)).toEqual([4, 2, 1]);
    expect(matchLorebook(book, say("kraken")).map((e) => e.id)).toEqual([4]);
  });

  test("selective entries need a secondary key too; case_sensitive and regex keys; unsafe patterns never match", () => {
    expect(matchLorebook(book, say("show me the map")).map((e) => e.id)).toEqual([4]);
    expect(matchLorebook(book, say("the map is wet")).map((e) => e.id)).toEqual([4, 3]);
    const b: CharacterBook = {
      extensions: {},
      entries: [
        entry({ id: "cs", keys: ["Mira"], case_sensitive: true, content: "cs" }),
        entry({ id: "re", keys: ["/\\bdrag(on|ons)\\b/"], content: "re" }),
        entry({ id: "v3", keys: ["^gate\\s+\\d+$"], use_regex: true, content: "v3" }),
        entry({ id: "bad", keys: ["/(a+)+$/"], content: "bad" }),
        entry({ id: "backref", keys: ["/(x)\\1/"], content: "backref" }),
      ],
    };
    expect(matchLorebook(b, say("mira sees DRAGONS")).map((e) => e.id)).toEqual(["re"]);
    expect(matchLorebook(b, say("Mira sees a dragonfly")).map((e) => e.id)).toEqual(["cs"]);
    expect(matchLorebook(b, say("gate 12")).map((e) => e.id)).toEqual(["v3"]);
    expect(matchLorebook(b, say("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", "xx")).map((e) => e.id)).toEqual([]);
  });

  test("only the last scan_depth messages are scanned, and the token budget caps what is added", () => {
    expect(matchLorebook(book, say("lighthouse", "a", "b", "c")).map((e) => e.id)).toEqual([4]); // scan_depth 3
    expect(matchLorebook(book, say("lighthouse", "a", "b", "c"), { scanDepth: 4 }).map((e) => e.id)).toEqual([4, 1]);
    const tight: CharacterBook = { token_budget: 5, extensions: {}, entries: [entry({ id: "a", keys: ["x"], content: "12345678901234567890", insertion_order: 1 }), entry({ id: "b", keys: ["x"], content: "123456789012345678901", insertion_order: 2 })] };
    expect(matchLorebook(tight, say("x")).map((e) => e.id)).toEqual(["a"]);
  });
});

describe("prompt assembly", () => {
  const history = [
    { role: "user", content: "The storm is loud. Is the lighthouse working?" },
    { role: "assistant", content: "Not for ten years." },
    { role: "user", content: "Then how do ships find the harbour?" },
  ];

  test("system prompt, lorebook, card fields, memory and examples in order; greeting; history; post-history last", () => {
    const { messages, lore, greeting } = buildCharacterMessages(V2, history, { userName: "Ash", memory: { summary: "Ash owes Mira a compass.", facts: ["Ash is afraid of boats"] } });
    expect(messages).toHaveLength(6);
    const sys = messages[0]!.content as string;
    const order = [
      "Write Mira's next reply in a fictional chat between Mira and Ash.", // {{original}} = the default main prompt
      "Keep replies under 120 words.",
      "Storms here last three days.", // before_char lorebook
      "Mira is a cartographer", // description
      "Mira's personality: curious, dry humour",
      "Scenario: A storm pins Ash and Mira",
      "The tavern is called The Drift.", // after_char lorebook, in insertion order
      "The lighthouse has been dark for ten years.",
      "Memory of earlier chats (summary): Ash owes Mira a compass.",
      "- Ash is afraid of boats",
      "Example dialogue:\nAsh: Where is the island today?\nMira: East of yesterday.",
    ];
    let at = -1;
    for (const piece of order) {
      const next = sys.indexOf(piece);
      expect(next, piece).toBeGreaterThan(at);
      at = next;
    }
    expect(sys).not.toContain("{{");
    expect(messages[1]).toEqual({ role: "assistant", content: "Evening, Ash. Sit, the map is still wet." });
    expect(messages.slice(2, 5)).toEqual(history);
    expect(messages[5]).toEqual({ role: "system", content: "Reply as Mira only." });
    expect(lore).toEqual([4, 2, 1]);
    expect(greeting).toBe(0);
  });

  test("alternate greetings by index, no greeting when the history starts with the assistant, regenerate drops the last reply", () => {
    expect(buildCharacterMessages(V2, [{ role: "user", content: "hi" }], { greeting: 2 }).messages[1]).toEqual({ role: "assistant", content: "The lamp flickers as User walks in." });
    expect(buildCharacterMessages(V2, [{ role: "user", content: "hi" }], { greeting: 99 }).greeting).toBe(2);
    const own = buildCharacterMessages(V2, [{ role: "assistant", content: "custom opener" }, { role: "user", content: "hi" }]);
    expect(own.greeting).toBeNull();
    expect(own.messages[1]).toEqual({ role: "assistant", content: "custom opener" });
    const regen = buildCharacterMessages(V2, history.slice(0, 2), { regenerate: true });
    expect(regen.messages.at(-2)).toEqual(history[0]);
    expect(regen.messages.at(-1)!.role).toBe("system");
    expect(applyMacros("<BOT> and <user> and {{Char}}", { char: "M", user: "U" })).toBe("M and U and M");
  });

  test("group chats: round robin after the last speaker, or the member named in the last user message", () => {
    const members = [{ id: "a", name: "Mira" }, { id: "b", name: "Zoë" }, { id: "c", name: "Tam" }];
    expect(pickSpeaker(members, [])).toEqual({ next: "a", index: 0 });
    expect(pickSpeaker(members, [{ role: "assistant", name: "Zoë", content: "hi" }])).toEqual({ next: "c", index: 2 });
    expect(pickSpeaker(members, [], "round_robin", "c")).toEqual({ next: "a", index: 0 });
    expect(pickSpeaker(members, [{ role: "user", content: "tam, what do you think? and zoë?" }], "named")).toEqual({ next: "c", index: 2 });
    expect(pickSpeaker(members, [{ role: "assistant", name: "Tam", content: "." }, { role: "user", content: "Tam and Mira?" }], "named")).toEqual({ next: "a", index: 0 });
    expect(pickSpeaker(members, [{ role: "user", content: "anyone?" }], "named", "a")).toEqual({ next: "b", index: 1 });
  });
});

// ---- client-side sealing ------------------------------------------------------------------------------

describe("memory encryption (client helpers)", () => {
  test("seal and open round trip; the wrong key, the wrong purpose or a changed byte fails", async () => {
    const k = await deriveViewingKey("sk-ar-v1-" + "a".repeat(48));
    const other = await deriveViewingKey("sk-ar-v1-" + "b".repeat(48));
    expect(k.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(k.keyId).not.toBe(other.keyId);
    const s = await sealMemory(k, { kind: "fact", text: SECRET_PHRASE, at: 1 });
    expect(s).toMatch(/^arm1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(s).not.toContain("lighthouse");
    expect(await openMemory(k, s)).toEqual({ kind: "fact", text: SECRET_PHRASE, at: 1 });
    expect(await sealMemory(k, { kind: "fact", text: SECRET_PHRASE })).not.toBe(s); // a fresh IV every time
    await expect(openMemory(other, s)).rejects.toThrow("does not open");
    await expect(open(k, s, "card")).rejects.toThrow("does not open");
    const flipped = s.slice(0, -2) + (s.at(-2) === "A" ? "B" : "A") + s.at(-1);
    await expect(openMemory(k, flipped)).rejects.toThrow(CardError);
    await expect(deriveViewingKey("short")).rejects.toThrow("16 bytes");
  });

  test("scopes are stable per key and character, and reveal neither", async () => {
    const k = await deriveViewingKey(new Uint8Array(32).fill(7));
    const k2 = await deriveViewingKey(new Uint8Array(32).fill(8));
    const s = await memoryScope(k, "ch_000000000000000000000001");
    expect(s).toMatch(/^[0-9a-f]{32}$/);
    expect(await memoryScope(k, "ch_000000000000000000000001")).toBe(s);
    expect(await memoryScope(k, "ch_000000000000000000000002")).not.toBe(s);
    expect(await memoryScope(k2, "ch_000000000000000000000001")).not.toBe(s);
  });

  test("private cards: sealCard gives the ciphertext and the plaintext's hash; a passphrase key works too", async () => {
    const k = await viewingKeyFromPassphrase("correct horse battery staple", "salt-1", 1_000);
    const sealed = await sealCard(k, V2);
    expect(sealed.card_hash).toBe(await cardHash(V2));
    expect(sealed.sealed_card).not.toContain("Mira");
    expect(await openCard(k, sealed.sealed_card)).toEqual(normalizeCard(V2));
    expect(memoryForPrompt([{ kind: "summary", text: "old", at: 1 }, { kind: "fact", text: "f1" }, { kind: "summary", text: "new", at: 2 }])).toEqual({ summary: "new", facts: ["f1"] });
    expect(b64ToBytes(bytesToB64(new Uint8Array([0, 255, 128])))).toEqual(new Uint8Array([0, 255, 128]));
    expect(await seal(k, 1)).toMatch(/^arm1\./);
  });
});

// ---- the router -----------------------------------------------------------------------------------------

type Auth = Record<string, string>;
let h: Harness;
let owner: { auth: Auth; hash: string };
let stranger: { auth: Auth };
const lastBody = async (id = "alpha") => (await (await fetch(h.mocks[id]!.url + "/_stats")).json()).lastBody as { messages: { role: string; content: string }[]; [k: string]: unknown };
const create = async (auth: Auth, json: unknown) => h.request("/api/v1/characters", { method: "POST", headers: auth, json });

beforeAll(async () => {
  h = await startRouter({ providers: [{ id: "alpha", name: "Alpha", models: [MODELS.llama, MODELS.qwen] }] }); // one provider, so lastBody() is the call just made
  owner = await h.fundedKey(20n);
  stranger = await h.fundedKey(5n);
});
afterAll(async () => h?.close());

describe("registry", () => {
  let pub: string;
  let unl: string;

  test("import: public from JSON, unlisted from PNG; discovery lists public cards by tag and text", async () => {
    const a = await create(owner.auth, { visibility: "public", card: V2, model: LLAMA });
    expect(a.status).toBe(201);
    const ja = (await a.json()).data;
    expect(ja).toMatchObject({ visibility: "public", name: "Mira", tags: ["fantasy", "adventure"], creator: "mapmaker", spec: "chara_card_v2", card_hash: await cardHash(V2), default_model: LLAMA, owner: true });
    expect(ja.id).toMatch(/^ch_[0-9a-f]{24}$/);
    expect(ja.model).toBe(`@character/${ja.id}`);
    pub = ja.id;
    const png = bytesToB64(writeCardToPng(V3, buildPng(), "v3"));
    const b = await create(owner.auth, { visibility: "unlisted", png });
    expect(b.status).toBe(201);
    const jb = (await b.json()).data;
    expect(jb).toMatchObject({ visibility: "unlisted", name: "Zoë Brightwater", spec: "chara_card_v3", card_hash: await cardHash(V3) });
    unl = jb.id;

    const list = async (qs: string) => ((await (await h.request(`/api/v1/characters${qs}`)).json()).data as { id: string }[]).map((x) => x.id);
    expect(await list("")).toEqual([pub]);
    expect(await list("?tag=Fantasy")).toEqual([pub]);
    expect(await list("?tag=romance")).toEqual([]);
    expect(await list("?q=mapmak")).toEqual([pub]);
    expect(await list("?q=zo%C3%AB")).toEqual([]); // unlisted cards are never listed
    expect(await list("?q=%25")).toEqual([]);
    const mine = (await (await h.request("/api/v1/characters?mine=1", { headers: owner.auth })).json()).data as { id: string; card?: unknown }[];
    expect(mine.map((x) => x.id).sort()).toEqual([pub, unl].sort());
    expect(mine[0]!.card).toBeUndefined();
    expect((await h.request("/api/v1/characters?mine=1")).status).toBe(401);
  });

  test("an unlisted card is readable by id; export gives JSON v2/v3 and a PNG that reads back to the same hash", async () => {
    const one = (await (await h.request(`/api/v1/characters/${unl}`)).json()).data;
    expect(one).toMatchObject({ id: unl, owner: false, card: normalizeCard(V3) });
    const j3 = await (await h.request(`/api/v1/characters/${pub}/export?spec=v3`)).json();
    expect(j3.spec).toBe("chara_card_v3");
    expect(await cardHash(toV2(normalizeCard(j3)))).toBe(await cardHash(V2));
    const j2 = await h.request(`/api/v1/characters/${pub}/export?format=json&spec=v2`);
    expect(j2.headers.get("content-disposition")).toContain("Mira.json");
    expect(await cardHash(await j2.json())).toBe(await cardHash(V2));
    const p = await h.request(`/api/v1/characters/${unl}/export?format=png`);
    expect(p.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await p.arrayBuffer());
    expect(crcOk(bytes)).toBe(true);
    expect(await cardHash(readCardFromPng(bytes))).toBe(await cardHash(V3));
    expect((await h.request(`/api/v1/characters/${pub}/export?format=gif`)).status).toBe(400);
    expect((await (await h.request(`/api/v1/characters/${pub}/greetings`)).json()).data.greetings).toEqual([V2.data.first_mes, ...V2.data.alternate_greetings]);
  });

  test("only the owner edits or deletes; a bad card, a bad model or both card and png are refused", async () => {
    expect((await h.request(`/api/v1/characters/${pub}`, { method: "PUT", headers: stranger.auth, json: { model: QWEN } })).status).toBe(404);
    expect((await h.request(`/api/v1/characters/${pub}`, { method: "DELETE", headers: stranger.auth })).status).toBe(404);
    const put = await h.request(`/api/v1/characters/${pub}`, { method: "PUT", headers: owner.auth, json: { model: QWEN } });
    expect((await put.json()).data).toMatchObject({ default_model: QWEN, name: "Mira" });
    expect((await create(owner.auth, { card: { spec: "chara_card_v2", data: {} } })).status).toBe(400);
    expect((await create(owner.auth, { card: V2, png: "x" })).status).toBe(400);
    expect((await create(owner.auth, { card: V2, model: "nobody/nothing" })).status).toBe(404);
    expect((await create(owner.auth, { png: bytesToB64(buildPng()) })).status).toBe(400);
    expect((await create({}, { card: V2 })).status).toBe(401);
    await h.request(`/api/v1/characters/${pub}`, { method: "PUT", headers: owner.auth, json: { model: LLAMA } });
  });
});

describe("private cards", () => {
  let id: string;
  const secretCard = { ...V2, data: { ...V2.data, name: "Nightjar", description: `A spy. Codeword ${SECRET_PHRASE}.`, character_book: undefined } };

  test("plaintext is refused; only the sealed card and its hash are stored, and only the owner can read them", async () => {
    const refused = await create(owner.auth, { visibility: "private", card: secretCard });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.type).toBe("plaintext_refused");
    expect((await create(owner.auth, { visibility: "private", sealed_card: JSON.stringify(secretCard), card_hash: await cardHash(secretCard) })).status).toBe(400);
    const k = await deriveViewingKey(new Uint8Array(32).fill(1));
    const sealed = await sealCard(k, secretCard);
    const r = await create(owner.auth, { visibility: "private", sealed_card: sealed.sealed_card, card_hash: sealed.card_hash, model: LLAMA });
    expect(r.status).toBe(201);
    const j = (await r.json()).data;
    expect(j).toMatchObject({ visibility: "private", name: null, tags: [], creator: null, spec: null, card_hash: sealed.card_hash, sealed_card: sealed.sealed_card });
    id = j.id;
    const [row] = await h.ctx.db.select().from(characters).where(eq(characters.id, id));
    expect(JSON.stringify(row)).not.toContain(SECRET_PHRASE);
    expect(JSON.stringify(row)).not.toContain("Nightjar");
    expect(row!.card).toBeNull();
    expect((await h.request(`/api/v1/characters/${id}`, { headers: stranger.auth })).status).toBe(404);
    expect((await h.request(`/api/v1/characters/${id}`)).status).toBe(404);
    expect((await h.request(`/api/v1/characters/${id}/export`)).status).toBe(404);
    expect((await (await h.request(`/api/v1/characters/${id}`, { headers: owner.auth })).json()).data.sealed_card).toBe(sealed.sealed_card);
    expect(await openCard(k, sealed.sealed_card)).toEqual(normalizeCard(secretCard));
    // Turning it shared needs the card itself; turning a shared one private drops its plaintext.
    expect((await h.request(`/api/v1/characters/${id}`, { method: "PUT", headers: owner.auth, json: { visibility: "public" } })).status).toBe(400);
  });

  test("chat needs the decrypted card, checked against the hash; the card and memory are used and not stored", async () => {
    const chat = (json: Record<string, unknown>, auth: Auth = owner.auth) => h.request(`/api/v1/characters/${id}/chat`, { method: "POST", headers: auth, json: { messages: [{ role: "user", content: "hello" }], ...json } });
    expect((await (await chat({})).json()).error.type).toBe("card_required");
    expect((await chat({ card: { ...secretCard, data: { ...secretCard.data, name: "Other" } } })).status).toBe(409);
    expect((await chat({ card: secretCard }, stranger.auth)).status).toBe(404);
    const ok = await chat({ card: secretCard, memory: { summary: `Summary ${SECRET_PHRASE}`, facts: ["likes tea"] }, session_id: "s-1" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-anyroute-character-session")).toBe("s-1");
    const sent = await lastBody();
    expect(sent.messages[0]!.content).toContain(`Codeword ${SECRET_PHRASE}`);
    expect(sent.messages[0]!.content).toContain("Things Nightjar remembers:\n- likes tea");
    for (const k of ["card", "memory", "session_id", "greeting", "regenerate", "user_name"]) expect(sent[k]).toBeUndefined();
    const tables = [await h.ctx.db.select().from(characters), await h.ctx.db.select().from(generations), await h.ctx.db.select().from(characterMemory), await h.ctx.db.select().from(characterUsage)];
    const everything = JSON.stringify(tables, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(everything).not.toContain(SECRET_PHRASE);
    expect(await h.ctx.db.select().from(characterUsage).where(eq(characterUsage.characterId, id))).toEqual([]);
  });
});

describe("character chat and the @character proxy", () => {
  let pub: string;
  let unl: string;
  beforeAll(async () => {
    pub = (await (await create(owner.auth, { visibility: "public", card: V2, model: LLAMA })).json()).data.id;
    unl = (await (await create(owner.auth, { visibility: "unlisted", card: V3 })).json()).data.id;
  });

  test("POST /characters/:id/chat assembles the card and runs the normal chat path (receipt, public-lane note)", async () => {
    const r = await h.request(`/api/v1/characters/${pub}/chat`, { method: "POST", headers: stranger.auth, json: { model: QWEN, user_name: "Ash", greeting: 1, messages: [{ role: "user", content: "Is the lighthouse working?" }] } });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-anyroute-character")).toBe(pub);
    expect(r.headers.get("x-anyroute-character-lane")).toBe("public");
    expect(r.headers.get("x-anyroute-character-note")).toContain("no attested provider");
    const j = await r.json();
    expect(j.receipt.payload.model).toBe(QWEN);
    expect(j.character).toMatchObject({ id: pub, card_hash: await cardHash(V2), lane: "public", greeting: 1, lorebook_entries: 2 });
    const sent = await lastBody();
    expect(sent.model).toBeDefined();
    expect(sent.messages.map((m) => m.role)).toEqual(["system", "assistant", "user", "system"]);
    expect(sent.messages[1]!.content).toBe("You again, Ash?");
    expect(sent.messages[0]!.content).toContain("The lighthouse has been dark");
    expect(sent.messages[3]!.content).toBe("Reply as Mira only.");
  });

  test('`model: "@character/<id>"` on /chat/completions uses the default model, or models[0]; streams work', async () => {
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: stranger.auth, json: { model: `@character/${pub}`, messages: [{ role: "user", content: "hi" }] } });
    expect(r.status).toBe(200);
    expect((await r.json()).receipt.payload.model).toBe(LLAMA);
    const q = await h.request("/v1/chat/completions", { method: "POST", headers: stranger.auth, json: { model: `@character/${pub}`, models: [QWEN], messages: [{ role: "user", content: "hi" }] } });
    expect((await q.json()).receipt.payload.model).toBe(QWEN);
    const noDefault = await h.request("/api/v1/chat/completions", { method: "POST", headers: stranger.auth, json: { model: `@character/${unl}`, messages: [{ role: "user", content: "hi" }] } });
    expect(noDefault.status).toBe(400);
    expect((await noDefault.json()).error.type).toBe("model_required");
    const s = await h.request("/api/v1/chat/completions", { method: "POST", headers: stranger.auth, json: { model: `@character/${unl}`, models: [LLAMA], stream: true, messages: [{ role: "user", content: "dragons?" }] } });
    expect(s.status).toBe(200);
    const events = await sse(s);
    expect(events.done).toBe(true);
    expect(events.events.at(-1)?.character).toMatchObject({ id: unl, lorebook_entries: 1 });
    expect((await lastBody()).messages[0]!.content).toContain("Dragons nest on the north cliffs");
    expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: stranger.auth, json: { model: "@character/ch_000000000000000000000000", messages: [{ role: "user", content: "hi" }] } })).status).toBe(404);
    expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: stranger.auth, json: { model: LLAMA, models: [`@character/${pub}`], messages: [{ role: "user", content: "hi" }] } })).status).toBe(400);
    expect((await h.request("/api/v1/completions", { method: "POST", headers: stranger.auth, json: { model: `@character/${pub}`, prompt: "hi" } })).status).toBe(400);
  });

  test("regenerate drops the last reply; a public card records calls and cost for its creator, an unlisted one does not", async () => {
    const before = await h.ctx.db.select().from(characterUsage).where(eq(characterUsage.characterId, pub));
    const r = await h.request(`/api/v1/characters/${pub}/chat`, {
      method: "POST",
      headers: stranger.auth,
      json: { regenerate: true, messages: [{ role: "user", content: "one" }, { role: "assistant", content: "bad reply" }] },
    });
    expect(r.status).toBe(200);
    const sent = await lastBody();
    expect(sent.messages.map((m) => m.content)).not.toContain("bad reply");
    const after = await h.ctx.db.select().from(characterUsage).where(eq(characterUsage.characterId, pub));
    expect(after).toHaveLength(1);
    expect(after[0]!.calls).toBe((before[0]?.calls ?? 0) + 1);
    expect(after[0]!.cost).toBeGreaterThan(before[0]?.cost ?? 0n);
    expect(Object.keys(after[0]!).sort()).toEqual(["calls", "characterId", "cost", "period"]);
    expect(await h.ctx.db.select().from(characterUsage).where(eq(characterUsage.characterId, unl))).toEqual([]);
    const usage = await h.request(`/api/v1/characters/${pub}/usage`, { headers: owner.auth });
    expect((await usage.json()).data[0]).toMatchObject({ period: new Date().toISOString().slice(0, 10), calls: after[0]!.calls });
    expect((await h.request(`/api/v1/characters/${pub}/usage`, { headers: stranger.auth })).status).toBe(404);
  });

  test("group chats: the next speaker among readable characters", async () => {
    const r = await h.request("/api/v1/characters/group/next", { method: "POST", json: { members: [pub, unl], mode: "named", messages: [{ role: "user", content: "Zoë Brightwater, your turn" }] } });
    expect((await r.json()).data).toMatchObject({ next: unl, index: 1, model: `@character/${unl}` });
    const rr = await h.request("/api/v1/characters/group/next", { method: "POST", json: { members: [pub, unl], last_speaker: unl } });
    expect((await rr.json()).data.next).toBe(pub);
  });
});

describe("memory ledger", () => {
  test("stores ciphertext only: plaintext and embeddings without opt-in are refused; list, search and delete", async () => {
    const k = await deriveViewingKey(new Uint8Array(32).fill(3));
    const scope = await memoryScope(k, "ch_000000000000000000000abc");
    const post = (json: Record<string, unknown>, auth: Auth = owner.auth) => h.request("/api/v1/memory", { method: "POST", headers: auth, json: { scope, kind: "fact", key_id: k.keyId, ...json } });
    expect((await post({ sealed: SECRET_PHRASE })).status).toBe(400);
    expect((await post({ sealed: await sealMemory(k, { kind: "fact", text: SECRET_PHRASE }), embedding: [1, 0] })).status).toBe(400);
    const a = await post({ sealed: await sealMemory(k, { kind: "fact", text: SECRET_PHRASE }), embedding: [1, 0, 0], embedding_opt_in: true });
    expect(a.status).toBe(201);
    const ja = (await a.json()).data;
    expect(ja).toMatchObject({ scope, kind: "fact", key_id: k.keyId, has_embedding: true, dims: 3 });
    const b = (await (await post({ kind: "summary", sealed: await sealMemory(k, { kind: "summary", text: "s" }) })).json()).data;
    expect(b.has_embedding).toBe(false);
    const other = await post({ sealed: await sealMemory(k, { kind: "fact", text: "x" }), embedding: [0, 1, 0], embedding_opt_in: true });
    const jo = (await other.json()).data;

    const rows = await h.ctx.db.select().from(characterMemory);
    expect(JSON.stringify(rows)).not.toContain(SECRET_PHRASE);
    const list = await (await h.request(`/api/v1/memory?scope=${scope}`, { headers: owner.auth })).json();
    expect(list.data.map((x: { id: string }) => x.id).sort()).toEqual([ja.id, b.id, jo.id].sort());
    expect(list.data[0].sealed).toBeUndefined();
    expect((await (await h.request(`/api/v1/memory?scope=${scope}`, { headers: stranger.auth })).json()).data).toEqual([]);
    const got = (await (await h.request(`/api/v1/memory/${ja.id}`, { headers: owner.auth })).json()).data;
    expect(await openMemory(k, got.sealed)).toEqual({ kind: "fact", text: SECRET_PHRASE });
    expect((await h.request(`/api/v1/memory/${ja.id}`, { headers: stranger.auth })).status).toBe(404);

    const found = (await (await h.request("/api/v1/memory/search", { method: "POST", headers: owner.auth, json: { scope, embedding: [0.9, 0.1, 0], k: 2 } })).json()).data;
    expect(found.map((x: { id: string }) => x.id)).toEqual([ja.id, jo.id]);

    const upd = await h.request(`/api/v1/memory/${b.id}`, { method: "PUT", headers: owner.auth, json: { sealed: await sealMemory(k, { kind: "summary", text: "s2" }), key_id: k.keyId } });
    expect(await openMemory(k, (await (await h.request(`/api/v1/memory/${b.id}`, { headers: owner.auth })).json()).data.sealed)).toMatchObject({ text: "s2" });
    expect(upd.status).toBe(200);

    expect((await h.request(`/api/v1/memory/${ja.id}`, { method: "DELETE", headers: owner.auth })).status).toBe(200);
    expect((await h.request("/api/v1/memory", { method: "DELETE", headers: owner.auth })).status).toBe(400);
    expect((await (await h.request(`/api/v1/memory?scope=${scope}`, { method: "DELETE", headers: owner.auth })).json()).data.deleted).toBe(2);
    expect(await h.ctx.db.select().from(characterMemory)).toEqual([]);
  });
});

describe("the attested lane by default", () => {
  let a: Harness;
  const claim = { source: "https://provider.example/terms", as_of: "2025-01-15" };
  beforeAll(async () => {
    a = await startRouter({ providers: [{ id: "vendor", name: "Vendor", models: [MODELS.qwen] }, { id: "enclave", name: "Enclave", models: [MODELS.llamaPricey], tee: "dev" }] });
    const put = (id: string, json: unknown) => a.request(`/api/v1/disclosure/${id}`, { method: "PUT", headers: { "x-admin-token": ADMIN }, json });
    expect((await put("enclave", { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } })).status).toBe(200);
    await runAttestor(a.ctx);
    await a.ctx.catalog.refresh();
  });
  afterAll(async () => a?.close());

  test("a model with an attested provider runs on lane attested; one without says so; a lane the caller picks is kept", async () => {
    const k = await a.fundedKey(10n);
    const id = (await (await a.request("/api/v1/characters", { method: "POST", headers: k.auth, json: { visibility: "public", card: V2, model: LLAMA } })).json()).data.id;
    const chat = (json: Record<string, unknown>, headers: Auth = {}) => a.request(`/api/v1/characters/${id}/chat`, { method: "POST", headers: { ...k.auth, ...headers }, json: { messages: [{ role: "user", content: "hi" }], ...json } });
    const att = await chat({});
    expect(att.status).toBe(200);
    expect(att.headers.get("x-anyroute-character-lane")).toBe("attested");
    expect(att.headers.get("x-anyroute-character-note")).toBeNull();
    expect((await att.json()).receipt.payload).toMatchObject({ lane: "attested", provider: "enclave" });
    const pub = await chat({ model: QWEN });
    expect(pub.headers.get("x-anyroute-character-lane")).toBe("public");
    expect(pub.headers.get("x-anyroute-character-note")).toContain("public lane");
    const chosen = await chat({ provider: { lane: "public" } });
    expect(chosen.headers.get("x-anyroute-character-lane")).toBe("public");
    expect(chosen.headers.get("x-anyroute-character-note")).toBeNull();
  });
});
