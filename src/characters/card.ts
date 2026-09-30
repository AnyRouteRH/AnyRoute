// Character cards, lorebooks, prompt assembly and client-side memory encryption.
//
// One self-contained module (no imports, Web Crypto only) shared word for word by the router (src/characters/card.ts) and
// the client (packages/client/src/characters.ts); a test checks the two files are identical, so a card hashes, a lorebook
// matches and a prompt is assembled the same way on both sides.
//
// Cards: Tavern Card v1 (flat), v2 (spec "chara_card_v2") and v3 (spec "chara_card_v3"), as JSON or inside a PNG in a
// tEXt chunk whose keyword is `chara` (v2) or `ccv3` (v3) and whose text is base64 of the card's UTF-8 JSON.
// A card's hash is SHA-256 of the canonical JSON (sorted keys, no whitespace) of the normalized card.
//
// Memory and private cards are sealed on the client with AES-256-GCM under a viewing key derived on the client; the
// router receives only the sealed text ("arm1.<iv>.<ciphertext>", base64url) and never the key.

// ---- types ----------------------------------------------------------------------------------------------------------

export type LoreEntry = {
  keys: string[];
  content: string;
  extensions: Record<string, unknown>;
  enabled: boolean;
  insertion_order: number;
  case_sensitive?: boolean;
  use_regex?: boolean;
  constant?: boolean;
  name?: string;
  priority?: number;
  id?: number | string;
  comment?: string;
  selective?: boolean;
  secondary_keys?: string[];
  position?: "before_char" | "after_char";
};

export type CharacterBook = {
  name?: string;
  description?: string;
  scan_depth?: number;
  token_budget?: number;
  recursive_scanning?: boolean;
  extensions: Record<string, unknown>;
  entries: LoreEntry[];
};

export type CardData = {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  character_book?: CharacterBook;
  tags: string[];
  creator: string;
  character_version: string;
  extensions: Record<string, unknown>;
  // v3 only
  nickname?: string;
  creator_notes_multilingual?: Record<string, string>;
  source?: string[];
  group_only_greetings?: string[];
  creation_date?: number;
  modification_date?: number;
  assets?: { type: string; uri: string; name: string; ext: string }[];
};

export type CharacterCard = { spec: "chara_card_v2"; spec_version: "2.0"; data: CardData } | { spec: "chara_card_v3"; spec_version: "3.0"; data: CardData };

export type ChatMessage = { role: string; content?: unknown; name?: string; [k: string]: unknown };

export class CardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardError";
  }
}

// ---- small helpers --------------------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const obj = (v: unknown) => (isObj(v) ? v : {});
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Deterministic JSON: keys sorted recursively, undefined dropped. */
export function canonicalCardJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (isObj(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
async function sha256Hex(data: string | Uint8Array) {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[\s]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(clean + "===".slice((clean.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64url = (b: Uint8Array) => bytesToB64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---- normalization --------------------------------------------------------------------------------------------------

function normEntry(e: unknown, i: number): LoreEntry {
  const r = obj(e);
  const out: LoreEntry = {
    keys: strs(r.keys),
    content: str(r.content),
    extensions: obj(r.extensions),
    enabled: r.enabled !== false,
    insertion_order: Number.isFinite(r.insertion_order) ? Number(r.insertion_order) : i,
  };
  if (typeof r.case_sensitive === "boolean") out.case_sensitive = r.case_sensitive;
  if (typeof r.use_regex === "boolean") out.use_regex = r.use_regex;
  if (typeof r.constant === "boolean") out.constant = r.constant;
  if (typeof r.name === "string") out.name = r.name;
  if (Number.isFinite(r.priority)) out.priority = Number(r.priority);
  if (typeof r.id === "number" || typeof r.id === "string") out.id = r.id;
  if (typeof r.comment === "string") out.comment = r.comment;
  if (typeof r.selective === "boolean") out.selective = r.selective;
  if (Array.isArray(r.secondary_keys)) out.secondary_keys = strs(r.secondary_keys);
  if (r.position === "before_char" || r.position === "after_char") out.position = r.position;
  return out;
}

function normBook(b: unknown): CharacterBook | undefined {
  if (!isObj(b)) return undefined;
  const out: CharacterBook = { extensions: obj(b.extensions), entries: (Array.isArray(b.entries) ? b.entries : []).map(normEntry) };
  if (typeof b.name === "string") out.name = b.name;
  if (typeof b.description === "string") out.description = b.description;
  if (Number.isFinite(b.scan_depth)) out.scan_depth = Number(b.scan_depth);
  if (Number.isFinite(b.token_budget)) out.token_budget = Number(b.token_budget);
  if (typeof b.recursive_scanning === "boolean") out.recursive_scanning = b.recursive_scanning;
  return out;
}

function normData(d: Record<string, unknown>, v3: boolean): CardData {
  const out: CardData = {
    name: str(d.name).trim(),
    description: str(d.description),
    personality: str(d.personality),
    scenario: str(d.scenario),
    first_mes: str(d.first_mes),
    mes_example: str(d.mes_example),
    creator_notes: str(d.creator_notes),
    system_prompt: str(d.system_prompt),
    post_history_instructions: str(d.post_history_instructions),
    alternate_greetings: strs(d.alternate_greetings),
    tags: [...new Set(strs(d.tags).map((t) => t.trim()).filter(Boolean))],
    creator: str(d.creator),
    character_version: str(d.character_version),
    extensions: obj(d.extensions),
  };
  const book = normBook(d.character_book);
  if (book) out.character_book = book;
  if (v3) {
    if (typeof d.nickname === "string") out.nickname = d.nickname;
    if (isObj(d.creator_notes_multilingual)) out.creator_notes_multilingual = Object.fromEntries(Object.entries(d.creator_notes_multilingual).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    if (Array.isArray(d.source)) out.source = strs(d.source);
    out.group_only_greetings = strs(d.group_only_greetings);
    if (Number.isFinite(d.creation_date)) out.creation_date = Number(d.creation_date);
    if (Number.isFinite(d.modification_date)) out.modification_date = Number(d.modification_date);
    if (Array.isArray(d.assets)) out.assets = d.assets.filter(isObj).map((a) => ({ type: str(a.type), uri: str(a.uri), name: str(a.name), ext: str(a.ext) }));
  }
  if (!out.name) throw new CardError("The card has no name.");
  return out;
}

/** Any Tavern card (v1 flat, v2, v3, as an object or JSON text) as a normalized v2 or v3 card. Throws CardError. */
export function normalizeCard(input: unknown): CharacterCard {
  let raw = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new CardError("The card is not valid JSON.");
    }
  }
  if (!isObj(raw)) throw new CardError("A card must be a JSON object.");
  if (raw.spec === "chara_card_v3") return { spec: "chara_card_v3", spec_version: "3.0", data: normData(obj(raw.data), true) };
  if (raw.spec === "chara_card_v2") return { spec: "chara_card_v2", spec_version: "2.0", data: normData(obj(raw.data), false) };
  if (raw.spec !== undefined) throw new CardError(`Unknown card spec ${JSON.stringify(String(raw.spec).slice(0, 40))}; expected chara_card_v2 or chara_card_v3.`);
  // v1: the fields sit at the top level (some exports also carry a v2 `data` object without a spec).
  const flat = isObj(raw.data) && typeof raw.data.name === "string" ? raw.data : raw;
  return { spec: "chara_card_v2", spec_version: "2.0", data: normData(flat, false) };
}

const V3_ONLY = ["nickname", "creator_notes_multilingual", "source", "group_only_greetings", "creation_date", "modification_date", "assets"] as const;

/** The card as spec v2 (v3-only fields dropped, `use_regex` kept only in v3). */
export function toV2(card: CharacterCard): CharacterCard {
  const data = { ...card.data } as Record<string, unknown>;
  for (const k of V3_ONLY) delete data[k];
  if (card.data.character_book) data.character_book = { ...card.data.character_book, entries: card.data.character_book.entries.map(({ use_regex: _u, ...e }) => e) };
  return { spec: "chara_card_v2", spec_version: "2.0", data: data as CardData };
}

/** The card as spec v3 (group_only_greetings defaults to an empty list). */
export function toV3(card: CharacterCard): CharacterCard {
  return { spec: "chara_card_v3", spec_version: "3.0", data: { ...card.data, group_only_greetings: card.data.group_only_greetings ?? [] } };
}

/** SHA-256 (hex) of the normalized card's canonical JSON. */
export const cardHash = async (card: unknown) => sha256Hex(canonicalCardJson(normalizeCard(card)));

// ---- PNG ------------------------------------------------------------------------------------------------------------

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type PngChunk = { type: string; data: Uint8Array };

export function readPngChunks(png: Uint8Array): PngChunk[] {
  if (png.length < 8 || PNG_SIG.some((b, i) => png[i] !== b)) throw new CardError("Not a PNG file.");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: PngChunk[] = [];
  let at = 8;
  while (at + 12 <= png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (at + 12 + len > png.length) throw new CardError("The PNG is truncated.");
    out.push({ type, data: png.subarray(at + 8, at + 8 + len) });
    at += 12 + len;
    if (type === "IEND") break;
  }
  if (!out.length || out[0]!.type !== "IHDR" || out.at(-1)!.type !== "IEND") throw new CardError("The PNG has no IHDR or IEND chunk.");
  return out;
}

export function writePngChunks(chunks: PngChunk[]): Uint8Array {
  const size = 8 + chunks.reduce((n, c) => n + 12 + c.data.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(PNG_SIG, 0);
  let at = 8;
  for (const c of chunks) {
    const typeBytes = Uint8Array.from(c.type, (ch) => ch.charCodeAt(0));
    view.setUint32(at, c.data.length);
    out.set(typeBytes, at + 4);
    out.set(c.data, at + 8);
    const crcIn = new Uint8Array(4 + c.data.length);
    crcIn.set(typeBytes, 0);
    crcIn.set(c.data, 4);
    view.setUint32(at + 8 + c.data.length, crc32(crcIn));
    at += 12 + c.data.length;
  }
  return out;
}

/** A tEXt chunk's keyword and text (Latin-1, which base64 is a subset of). */
function textChunk(c: PngChunk): { keyword: string; text: string } | null {
  if (c.type !== "tEXt") return null;
  const nul = c.data.indexOf(0);
  if (nul < 1) return null;
  return { keyword: String.fromCharCode(...c.data.subarray(0, nul)), text: Array.from(c.data.subarray(nul + 1), (b) => String.fromCharCode(b)).join("") };
}
function makeTextChunk(keyword: string, text: string): PngChunk {
  const data = new Uint8Array(keyword.length + 1 + text.length);
  for (let i = 0; i < keyword.length; i++) data[i] = keyword.charCodeAt(i);
  for (let i = 0; i < text.length; i++) data[keyword.length + 1 + i] = text.charCodeAt(i) & 0xff;
  return { type: "tEXt", data };
}

/** The card inside a PNG: the `ccv3` chunk when present, else `chara`. Throws CardError when there is none. */
export function readCardFromPng(png: Uint8Array): CharacterCard {
  const texts = readPngChunks(png).map(textChunk).filter((t): t is { keyword: string; text: string } => t !== null);
  const pick = texts.find((t) => t.keyword === "ccv3") ?? texts.find((t) => t.keyword === "chara");
  if (!pick) throw new CardError("The PNG has no character card (no `chara` or `ccv3` tEXt chunk).");
  let json: unknown;
  try {
    json = JSON.parse(dec.decode(b64ToBytes(pick.text)));
  } catch {
    throw new CardError(`The PNG's \`${pick.keyword}\` chunk is not base64 JSON.`);
  }
  return normalizeCard(json);
}

/** A valid 1x1 transparent PNG, used when a card is exported without its own image. */
export const BLANK_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/**
 * Write a card into a PNG (any existing `chara`/`ccv3` chunks are replaced), before IEND. Spec v3 writes both `ccv3`
 * and a v2 `chara` chunk so older readers still load it; v2 writes `chara` only. The spec defaults to the card's own.
 * Without an image a 1x1 PNG is used.
 */
export function writeCardToPng(card: unknown, png: Uint8Array | null = null, specIn?: "v2" | "v3"): Uint8Array {
  const n = normalizeCard(card);
  const spec = specIn ?? (n.spec === "chara_card_v3" ? "v3" : "v2");
  const chunks = readPngChunks(png ?? b64ToBytes(BLANK_PNG_B64)).filter((c) => {
    const t = textChunk(c);
    return !(t && (t.keyword === "chara" || t.keyword === "ccv3"));
  });
  const b64 = (c: CharacterCard) => bytesToB64(enc.encode(JSON.stringify(c)));
  const add = spec === "v3" ? [makeTextChunk("ccv3", b64(toV3(n))), makeTextChunk("chara", b64(toV2(n)))] : [makeTextChunk("chara", b64(toV2(n)))];
  return writePngChunks([...chunks.slice(0, -1), ...add, chunks.at(-1)!]);
}

// ---- macros, lorebook and prompt assembly -----------------------------------------------------------------------------

export const DEFAULT_MAIN_PROMPT = "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}. Stay in character and keep the story consistent.";

/** Replace {{char}}, {{user}}, <BOT>, <USER> (any case) and {{original}}. */
export function applyMacros(text: string, names: { char: string; user: string; original?: string }): string {
  return text
    .replace(/\{\{original\}\}/gi, names.original ?? "")
    .replace(/\{\{char\}\}|<bot>/gi, names.char)
    .replace(/\{\{user\}\}|<user>/gi, names.user);
}

/** The text of a message's content (string, or the text parts of an array). */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (isObj(p) && typeof p.text === "string" ? p.text : "")).join(" ");
  return "";
}

const REGEX_KEY = /^\/(.+)\/([a-z]*)$/s;
// Patterns that can backtrack for a very long time (nested quantifiers, backreferences) are refused, since a public card's
// lorebook runs on the router: a key that looks unsafe simply never matches.
const UNSAFE_REGEX = /(\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{?])|\\[1-9]|\\k</;
export const MAX_SCAN_CHARS = 20_000;

function compileKey(key: string, entry: LoreEntry): RegExp | null {
  const m = REGEX_KEY.exec(key);
  const src = m ? m[1]! : entry.use_regex ? key : null;
  if (src === null) return null;
  if (src.length > 256 || UNSAFE_REGEX.test(src)) return /(?!)/;
  const flags = [...new Set(((m?.[2] ?? "") + (entry.case_sensitive ? "" : "i")).replace(/[^imsu]/g, ""))].join("");
  try {
    return new RegExp(src, flags);
  } catch {
    return /(?!)/;
  }
}

function keyHits(keys: string[], text: string, entry: LoreEntry): boolean {
  for (const key of keys) {
    if (!key) continue;
    const re = compileKey(key, entry);
    if (re) {
      if (re.test(text)) return true;
    } else if (entry.case_sensitive ? text.includes(key) : text.toLowerCase().includes(key.toLowerCase())) return true;
  }
  return false;
}

/**
 * Lorebook entries triggered by the last `scan_depth` messages (default 4): constant entries always; others when one of
 * their keys appears (substring, or a /regex/ key, case-insensitive unless the entry says otherwise), and for a selective
 * entry also one of its secondary keys. Ordered by insertion_order, then cut to the book's token_budget (4 chars a token).
 */
export function matchLorebook(book: CharacterBook | undefined, messages: ChatMessage[], opts: { scanDepth?: number } = {}): LoreEntry[] {
  if (!book?.entries?.length) return [];
  const depth = Math.max(1, Math.min(100, opts.scanDepth ?? book.scan_depth ?? 4));
  const text = messages
    .filter((m) => m.role !== "system")
    .slice(-depth)
    .map((m) => messageText(m.content))
    .join("\n")
    .slice(-MAX_SCAN_CHARS);
  const hits = book.entries.filter((e) => {
    if (!e.enabled || !e.content) return false;
    if (e.constant) return true;
    if (!keyHits(e.keys, text, e)) return false;
    return !(e.selective && e.secondary_keys?.length) || keyHits(e.secondary_keys, text, e);
  });
  hits.sort((a, b) => a.insertion_order - b.insertion_order || (b.priority ?? 0) - (a.priority ?? 0));
  const budget = book.token_budget && book.token_budget > 0 ? book.token_budget * 4 : Infinity;
  const out: LoreEntry[] = [];
  let used = 0;
  for (const e of hits) {
    if (used + e.content.length > budget) continue;
    used += e.content.length;
    out.push(e);
  }
  return out;
}

export type MemoryInput = { summary?: string; facts?: string[] };
export type BuildOptions = {
  userName?: string;
  /** 0 = first_mes, 1.. = alternate_greetings[n-1]. */
  greeting?: number;
  /** Drop the trailing assistant message(s) so the model writes that turn again. */
  regenerate?: boolean;
  memory?: MemoryInput;
};
export type BuiltPrompt = { messages: ChatMessage[]; lore: (string | number)[]; greeting: number | null };

/** Every greeting of a card: first_mes, then the alternate greetings. */
export const greetingsOf = (card: CharacterCard) => [card.data.first_mes, ...card.data.alternate_greetings].filter((g) => g.trim().length > 0);

/**
 * The messages sent to the model for one character turn, in this order:
 *   1. one system message: the card's system_prompt (or the default, {{original}} = the default), lorebook entries placed
 *      before_char, the description, personality and scenario, the other matched lorebook entries, the memory the client
 *      sent (summary, then facts), then the example dialogue;
 *   2. the greeting (first_mes, or the alternate chosen) as the first assistant message, unless the history starts with one;
 *   3. the conversation, as sent (without its trailing assistant turn when regenerating);
 *   4. the card's post_history_instructions as a last system message.
 */
export function buildCharacterMessages(cardIn: unknown, history: ChatMessage[], opts: BuildOptions = {}): BuiltPrompt {
  const card = normalizeCard(cardIn);
  const d = card.data;
  const names = { char: d.nickname || d.name, user: (opts.userName ?? "").trim() || "User" };
  const m = (t: string) => applyMacros(t, names).trim();
  let convo = history.filter((x) => isObj(x));
  if (opts.regenerate) while (convo.length && convo.at(-1)!.role === "assistant") convo = convo.slice(0, -1);
  const lore = matchLorebook(d.character_book, convo);
  const sections: string[] = [];
  sections.push(m(d.system_prompt ? applyMacros(d.system_prompt, { ...names, original: DEFAULT_MAIN_PROMPT }) : DEFAULT_MAIN_PROMPT));
  for (const e of lore.filter((e) => e.position === "before_char")) sections.push(m(e.content));
  if (d.description.trim()) sections.push(m(d.description));
  if (d.personality.trim()) sections.push(`${names.char}'s personality: ${m(d.personality)}`);
  if (d.scenario.trim()) sections.push(`Scenario: ${m(d.scenario)}`);
  for (const e of lore.filter((e) => e.position !== "before_char")) sections.push(m(e.content));
  const summary = opts.memory?.summary?.trim();
  const facts = (opts.memory?.facts ?? []).map((f) => f.trim()).filter(Boolean);
  if (summary) sections.push(`Memory of earlier chats (summary): ${summary}`);
  if (facts.length) sections.push(`Things ${names.char} remembers:\n${facts.map((f) => `- ${f}`).join("\n")}`);
  const examples = d.mes_example
    .split(/<START>/i)
    .map((b) => m(b))
    .filter(Boolean);
  if (examples.length) sections.push(`Example dialogue:\n${examples.join("\n\n")}`);
  const messages: ChatMessage[] = [{ role: "system", content: sections.filter(Boolean).join("\n\n") }];

  const greetings = greetingsOf(card);
  const firstTurn = convo.find((x) => x.role !== "system");
  let greeting: number | null = null;
  if (greetings.length && firstTurn?.role !== "assistant") {
    greeting = Math.max(0, Math.min(greetings.length - 1, Math.trunc(opts.greeting ?? 0)));
    messages.push({ role: "assistant", content: m(greetings[greeting]!) });
  }
  messages.push(...convo);
  if (d.post_history_instructions.trim()) messages.push({ role: "system", content: m(applyMacros(d.post_history_instructions, { ...names, original: "" })) });
  return { messages, lore: lore.map((e, i) => e.id ?? e.name ?? i), greeting };
}

// ---- group chats ----------------------------------------------------------------------------------------------------

export type GroupMember = { id: string; name: string };

/**
 * Who speaks next in a group chat. "named": the first member named in the last user message (not the one who spoke
 * last, unless nobody else is named), else round robin. "round_robin": the member after the last speaker, where the last
 * speaker is `lastSpeaker` or the `name` of the last assistant message.
 */
export function pickSpeaker(members: GroupMember[], messages: ChatMessage[], mode: "round_robin" | "named" = "round_robin", lastSpeaker?: string): { next: string; index: number } {
  if (!members.length) throw new CardError("A group needs at least one member.");
  const lastAssistant = [...messages].reverse().find((x) => x.role === "assistant");
  const lastId = lastSpeaker ?? members.find((x) => x.id === lastAssistant?.name || x.name === lastAssistant?.name)?.id;
  const lastIdx = members.findIndex((x) => x.id === lastId);
  if (mode === "named") {
    const lastUser = messageText([...messages].reverse().find((x) => x.role === "user")?.content).toLowerCase();
    const found = members
      .map((x, i) => {
        const esc = x.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const at = x.name ? lastUser.search(new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, "u")) : -1;
        return { i, at };
      })
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at);
    const pick = found.find((x) => x.i !== lastIdx) ?? found[0];
    if (pick) return { next: members[pick.i]!.id, index: pick.i };
  }
  const index = (lastIdx + 1) % members.length;
  return { next: members[index]!.id, index };
}

// ---- client-side sealing (memory and private cards) ------------------------------------------------------------------

export type ViewingKey = { enc: CryptoKey; mac: CryptoKey; keyId: string };
export const SEALED_RE = /^arm1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/;
export const SCOPE_RE = /^[0-9a-f]{32}$/;
export const KEY_ID_RE = /^[0-9a-f]{16}$/;

const hkdf = async (ikm: CryptoKey, info: string, usage: "enc" | "mac") =>
  crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("anyroute/viewing-key/v1"), info: enc.encode(info) },
    ikm,
    usage === "enc" ? { name: "AES-GCM", length: 256 } : { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    usage === "enc" ? ["encrypt", "decrypt"] : ["sign"],
  );

async function hmacHex(key: CryptoKey, data: string) {
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

/**
 * The viewing key, derived on the client from a high-entropy secret (32 random bytes the user keeps, or an API key
 * secret). The router never receives it. For a passphrase use viewingKeyFromPassphrase.
 */
export async function deriveViewingKey(secret: string | Uint8Array): Promise<ViewingKey> {
  const material = typeof secret === "string" ? enc.encode(secret) : secret;
  if (material.length < 16) throw new CardError("A viewing key needs at least 16 bytes of secret material.");
  const ikm = await crypto.subtle.importKey("raw", material as BufferSource, "HKDF", false, ["deriveKey"]);
  const [encKey, mac] = await Promise.all([hkdf(ikm, "anyroute/memory/enc/v1", "enc"), hkdf(ikm, "anyroute/memory/mac/v1", "mac")]);
  return { enc: encKey, mac, keyId: (await hmacHex(mac, "key-id")).slice(0, 16) };
}

/** A viewing key from a passphrase (PBKDF2-SHA256, 600,000 rounds by default) and a salt the client keeps. */
export async function viewingKeyFromPassphrase(passphrase: string, salt: string, iterations = 600_000): Promise<ViewingKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode("anyroute/passphrase/v1|" + salt), iterations }, base, 256);
  return deriveViewingKey(new Uint8Array(bits));
}

/** The opaque memory scope of one character under this key: the router can group blobs by it but not tell whose they are. */
export const memoryScope = async (key: ViewingKey, characterId: string) => (await hmacHex(key.mac, "scope|" + characterId)).slice(0, 32);

/** Seal any JSON value: "arm1.<iv>.<AES-256-GCM ciphertext>", bound to its purpose so a memory blob cannot pass as a card. */
export async function seal(key: ViewingKey, value: unknown, purpose: "memory" | "card" = "memory"): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`anyroute/${purpose}/v1`) }, key.enc, enc.encode(JSON.stringify(value))));
  return `arm1.${b64url(iv)}.${b64url(ct)}`;
}

/** Open a sealed value. Throws CardError when the key or the purpose is wrong or the text was changed. */
export async function open<T = unknown>(key: ViewingKey, sealed: string, purpose: "memory" | "card" = "memory"): Promise<T> {
  if (!SEALED_RE.test(sealed)) throw new CardError("Not a sealed value (arm1.<iv>.<ciphertext>).");
  const [, iv, ct] = sealed.split(".");
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(iv!) as BufferSource, additionalData: enc.encode(`anyroute/${purpose}/v1`) }, key.enc, b64ToBytes(ct!) as BufferSource);
    return JSON.parse(dec.decode(pt)) as T;
  } catch {
    throw new CardError("This sealed value does not open with this viewing key.");
  }
}

export type MemoryItem = { kind: "summary" | "fact" | "lorebook" | "state"; text: string; at?: number };
export const sealMemory = (key: ViewingKey, item: MemoryItem) => seal(key, item, "memory");
export const openMemory = (key: ViewingKey, sealed: string) => open<MemoryItem>(key, sealed, "memory");

/** A private card for POST /api/v1/characters: the sealed card and its hash. The plaintext never leaves the client. */
export async function sealCard(key: ViewingKey, card: unknown): Promise<{ sealed_card: string; card_hash: string; key_id: string }> {
  const n = normalizeCard(card);
  return { sealed_card: await seal(key, n, "card"), card_hash: await cardHash(n), key_id: key.keyId };
}
export const openCard = async (key: ViewingKey, sealed: string) => normalizeCard(await open(key, sealed, "card"));

/** Opened memory items as the `memory` field of a character chat request (latest summary, then the facts). */
export function memoryForPrompt(items: MemoryItem[]): MemoryInput {
  const summaries = items.filter((i) => i.kind === "summary");
  const latest = summaries.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).at(-1);
  return { ...(latest ? { summary: latest.text } : {}), facts: items.filter((i) => i.kind === "fact").map((i) => i.text) };
}

/** A chat body that asks a model to fold new turns into the rolling summary. The client runs it and seals the answer. */
export function summaryRequest(model: string, previous: string, turns: ChatMessage[], maxWords = 200) {
  const log = turns.map((t) => `${t.name ?? t.role}: ${messageText(t.content)}`).join("\n");
  return {
    model,
    messages: [
      { role: "system", content: `Update the running summary of a role-play chat. Keep names, facts, promises and open threads. At most ${maxWords} words. Reply with the summary only.` },
      { role: "user", content: `Summary so far:\n${previous || "(none)"}\n\nNew turns:\n${log}` },
    ],
    temperature: 0.2,
  };
}
