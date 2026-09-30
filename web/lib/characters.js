// Characters tab helpers: pure functions shared by components/features/Characters.jsx and tests/characters.test.mjs.
// A character is a Tavern character card (V1, V2 or V3, as JSON or inside a PNG) kept on the router and called as
// model "@character/<id>". Cards are parsed here, in the browser; the router is the authority on every rule.

export const CHARACTER_PREFIX = "@character/";
export const ID_RE = /^ch_[0-9a-f]{24}$/;
export const VISIBILITIES = ["public", "unlisted"]; // what the dashboard creates; private cards are sealed on the client
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const SPECS = { chara_card_v2: "2.0", chara_card_v3: "3.0" };
const TEXT_FIELDS = ["name", "description", "personality", "scenario", "first_mes", "mes_example", "system_prompt", "post_history_instructions", "creator", "creator_notes", "character_version"];
const V1_ALIASES = { char_name: "name", char_persona: "personality", world_scenario: "scenario", char_greeting: "first_mes", example_dialogue: "mes_example" };
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export const characterModel = (id) => CHARACTER_PREFIX + id;
export const shortHash = (hash) => String(hash || "").slice(0, 12);
export const specLabel = (spec) => (spec === "chara_card_v3" ? "Card V3" : spec === "chara_card_v2" ? "Card V2" : "Sealed card");
export const exportPath = (id, format = "json", spec = "chara_card_v2") => `/api/v1/characters/${encodeURIComponent(id)}/export?format=${format}&spec=${spec === "chara_card_v3" ? "v3" : "v2"}`;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const latin1 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
};

/** Standard or URL-safe base64, with or without padding and line breaks, to bytes. */
export function base64ToBytes(b64) {
  let s = String(b64 || "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const isPng = (bytes) => bytes?.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b);

/**
 * The tEXt chunks of a PNG as { keyword: bytes }. The text stays as raw bytes: PNG says tEXt is Latin-1, but card
 * tools write base64 (ASCII) or, now and then, raw UTF-8 JSON, so the caller decodes. Reading stops at IEND.
 */
export function readPngText(bytes) {
  if (!isPng(bytes)) throw new Error("Not a PNG file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = {};
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    const type = latin1(bytes.subarray(at + 4, at + 8));
    const start = at + 8;
    if (start + length + 4 > bytes.length) throw new Error("The PNG is cut short.");
    if (type === "tEXt") {
      const data = bytes.subarray(start, start + length);
      const nul = data.indexOf(0);
      if (nul > 0) {
        const keyword = latin1(data.subarray(0, nul));
        if (!(keyword in out)) out[keyword] = data.subarray(nul + 1);
      }
    }
    if (type === "IEND") break;
    at = start + length + 4;
  }
  return out;
}

/** A card chunk's text to JSON: base64 of UTF-8 JSON as card tools write it, or raw UTF-8 JSON. */
function chunkJson(raw) {
  let i = 0;
  while (i < raw.length && (raw[i] === 32 || raw[i] === 9 || raw[i] === 10 || raw[i] === 13)) i++;
  const bytes = raw[i] === 123 ? raw : base64ToBytes(latin1(raw));
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

/** The card a PNG carries: the ccv3 chunk when there is one, else chara. */
export function cardFromPng(bytes) {
  const chunks = readPngText(bytes);
  const chunk = chunks.ccv3 ? "ccv3" : chunks.chara ? "chara" : null;
  if (!chunk) throw new Error("This PNG carries no character card: it has no ccv3 or chara text chunk.");
  let json;
  try {
    json = chunkJson(chunks[chunk]);
  } catch {
    throw new Error(`The ${chunk} chunk of this PNG is not a readable card.`);
  }
  return { card: normalizeCard(json), chunk };
}

const text = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/**
 * Any Tavern card (V1 flat fields, V2 or V3) as { spec, spec_version, data }. V1 becomes V2. Fields a card leaves out
 * are filled with empty values; fields this code does not know (V3 assets, nickname, extensions) are kept as they are.
 */
export function normalizeCard(input) {
  if (!isObj(input)) throw new Error("A character card is a JSON object.");
  let spec = input.spec;
  let src;
  if (spec in SPECS) {
    if (!isObj(input.data)) throw new Error(`A ${spec} card keeps its fields in data.`);
    src = input.data;
  } else if (spec === undefined && (typeof input.name === "string" || typeof input.char_name === "string")) {
    // V1 is flat and older tools add their own fields (avatar, chat, create_date): keep only the card's fields.
    spec = "chara_card_v2";
    src = {};
    for (const k of [...TEXT_FIELDS, "alternate_greetings", "tags", "extensions", "character_book"]) if (input[k] !== undefined) src[k] = input[k];
    for (const [old, k] of Object.entries(V1_ALIASES)) if (src[k] === undefined && input[old] !== undefined) src[k] = input[old];
  } else throw new Error(spec ? `Unknown card spec "${spec}". Anyroute reads chara_card_v2 and chara_card_v3, and V1 cards.` : "This is not a character card: it has no spec and no name.");
  const data = { ...src };
  for (const k of TEXT_FIELDS) data[k] = text(src[k]);
  data.alternate_greetings = strings(src.alternate_greetings);
  data.tags = [...new Set(strings(src.tags).map((t) => t.trim()).filter(Boolean))];
  data.extensions = isObj(src.extensions) ? src.extensions : {};
  if (src.character_book == null) delete data.character_book;
  if (!data.name.trim()) throw new Error("The card has no name.");
  return { spec, spec_version: text(input.spec_version) || SPECS[spec], data };
}

/** A .json or .png file's bytes to a card. Returns { card, source: "json" | "png", chunk }; throws with a message to show. */
export function parseCardFile(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (!bytes.length) throw new Error("The file is empty.");
  if (bytes.length > MAX_FILE_BYTES) throw new Error("The file is larger than 20 MB.");
  if (isPng(bytes)) return { ...cardFromPng(bytes), source: "png" };
  let json;
  try {
    json = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch {
    throw new Error("Not a character card: the file is neither JSON nor a PNG.");
  }
  return { card: normalizeCard(json), source: "json", chunk: null };
}

/** first_mes, then the alternate greetings: the order the router numbers them in (0 is first_mes). */
export const greetingsOf = (card) => [card?.data?.first_mes, ...(card?.data?.alternate_greetings || [])].filter((g) => typeof g === "string" && g.trim());

const entries = (card) => (Array.isArray(card?.data?.character_book?.entries) ? card.data.character_book.entries.length : 0);

/** What the import step shows about a parsed card before anything is sent. */
export function cardSummary(card) {
  return { name: card.data.name, tags: card.data.tags, spec: specLabel(card.spec), greetings: greetingsOf(card).length, lorebook: entries(card), creator: card.data.creator || null };
}

/** Short tags for a list row: what the card holds, as far as the router shows it to this key. */
export function characterSummary(ch) {
  const tags = [specLabel(ch.spec)];
  if (ch.card) {
    const n = greetingsOf(ch.card).length;
    tags.push(`${n} greeting${n === 1 ? "" : "s"}`);
    const lore = entries(ch.card);
    if (lore) tags.push(`lorebook · ${lore} entr${lore === 1 ? "y" : "ies"}`);
  } else if (ch.visibility === "private") tags.push("encrypted on your device");
  tags.push(`hash ${shortHash(ch.card_hash)}`);
  return tags;
}

/** The body of a preview call to POST /api/v1/characters/:id/chat: one user turn, not streamed. */
export function chatPreviewBody({ message, model, greeting = 0, userName, maxTokens = 300 } = {}) {
  const content = text(message).trim();
  if (!content) throw new Error("Write a message first.");
  const body = { messages: [{ role: "user", content }], stream: false, max_tokens: maxTokens };
  if (model) body.model = model;
  if (Number.isInteger(greeting) && greeting > 0) body.greeting = greeting;
  if (userName && text(userName).trim()) body.user_name = text(userName).trim();
  return body;
}

/** How SillyTavern connects: Chat Completion, the OpenAI-compatible custom source, the router's base URL and the model. */
export function sillyTavernSnippet(id, base) {
  const url = (base || "https://your-router.example").replace(/\/$/, "") + "/api/v1";
  return `SillyTavern · API Connections
API:                     Chat Completion
Chat Completion Source:  Custom (OpenAI-compatible)
Custom Endpoint:         ${url}
Custom API Key:          your Anyroute key (sk-ar-v1-...)
Model ID:                ${CHARACTER_PREFIX}${id || "ch_<id>"}`;
}

/** The same call from any OpenAI client. models[0] picks the model; without it the card's default model answers. */
export function clientSnippet(id, base, model) {
  const url = (base || "https://your-router.example").replace(/\/$/, "") + "/api/v1";
  return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${url}",
  apiKey: process.env.ANYROUTE_API_KEY,
});

const completion = await client.chat.completions.create({
  model: "${CHARACTER_PREFIX}${id || "ch_<id>"}",${model ? `\n  models: ["${model}"],` : ""}
  messages: [{ role: "user", content: "Hello!" }],
});`;
}

// ---- the sample workspace ----------------------------------------------------------------------------

const MIRA = {
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name: "Captain Mira Voss",
    description: "Captain of the survey ship Long Quiet, three years out from port and still counting stars.",
    personality: "Calm, dry humour, protective of her crew.",
    scenario: "{{user}} has just come aboard as the ship's new navigator.",
    first_mes: "Welcome aboard, navigator. Coffee is in the galley and the charts are a mess. Which do you want first?",
    mes_example: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: ["The alarms stopped an hour ago. Sit down, {{user}}, we need to talk about the course.", "You found the observation deck. Most people take a week."],
    tags: ["sci-fi", "adventure"],
    creator: "sample",
    creator_notes: "A fixed sample for the dashboard.",
    character_version: "1.2",
    character_book: { entries: [{ keys: ["Long Quiet"], content: "A survey ship with a crew of nine." }, { keys: ["galley"], content: "The coffee machine is older than the ship." }] },
    extensions: {},
  },
};
const QUILL = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "Professor Quill",
    description: "A patient librarian who answers every question with a book recommendation.",
    personality: "Curious, kind, a little absent-minded.",
    scenario: "A reading room late in the afternoon.",
    first_mes: "Ah, a visitor. What are you trying to learn today?",
    mes_example: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    tags: ["study", "books"],
    creator: "sample",
    creator_notes: "",
    character_version: "1.0",
    extensions: {},
  },
};

/** Fixed, labelled examples for the sample workspace: never sent to the API. */
export const sampleCharacters = [
  {
    id: "ch_3f9a1c7e5b2d8f0a4c6e1b3d",
    model: CHARACTER_PREFIX + "ch_3f9a1c7e5b2d8f0a4c6e1b3d",
    visibility: "public",
    name: MIRA.data.name,
    tags: MIRA.data.tags,
    creator: "sample",
    spec: "chara_card_v3",
    card_hash: "7c1e9a3f5b0d2e4c6a8f1b3d5e7a9c0b2d4f6e8a1c3e5b7d9f0a2c4e6b8d1f3a",
    default_model: "meta-llama/llama-3.3-70b-instruct",
    card: MIRA,
    owner: true,
    created_at: "2026-09-27T14:20:00.000Z",
    updated_at: "2026-09-29T09:05:00.000Z",
    sample: true,
    preview: { reply: "Charts first, then. Pull up a chair: we are two light-hours off the plotted course and I would like to know why before the crew does.", lane: "attested", note: null },
  },
  {
    id: "ch_a0b1c2d3e4f5a6b7c8d9e0f1",
    model: CHARACTER_PREFIX + "ch_a0b1c2d3e4f5a6b7c8d9e0f1",
    visibility: "unlisted",
    name: QUILL.data.name,
    tags: QUILL.data.tags,
    creator: "sample",
    spec: "chara_card_v2",
    card_hash: "2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a3c5e7b9d1f2a4c6e8b0d3f5a7c9e1b2d",
    default_model: null,
    card: QUILL,
    owner: true,
    created_at: "2026-09-28T11:00:00.000Z",
    updated_at: "2026-09-28T11:00:00.000Z",
    sample: true,
    preview: { reply: "A fine question. Start with a short history of the subject, then come back and tell me which chapter surprised you.", lane: "public", note: "No attested provider serves this model right now, so the call ran on the public lane." },
  },
  {
    id: "ch_5e6f7a8b9c0d1e2f3a4b5c6d",
    model: CHARACTER_PREFIX + "ch_5e6f7a8b9c0d1e2f3a4b5c6d",
    visibility: "private",
    name: null,
    tags: [],
    creator: null,
    spec: null,
    card_hash: "e3c5a7f9b1d2e4f6a8c0b2d4f6e8a1c3e5b7d9f0a2c4e6b8d1f3a5c7e9b0d2f4",
    default_model: "qwen/qwen3-32b",
    sealed_card: "arm1.<iv>.<ciphertext>",
    owner: true,
    created_at: "2026-09-29T18:30:00.000Z",
    updated_at: "2026-09-29T18:30:00.000Z",
    sample: true,
    preview: null,
  },
];
