import { validateSavedAnswers } from "./saved-answers.js"; // D140
import { folderFields, validateFolders } from "./chat-folders.js"; // D143
import { MAX_BYTES, MAX_CHATS, snapshotLanes, titleOf } from "./private-history.js";
import { chatCost, costSummaryFields } from "./chat-cost.js"; // C128

export const EXPORT_FORMAT = "anyroute-harness-history";
export const EXPORT_VERSION = 1;
const bytes = (value) => new TextEncoder().encode(value).length;
const bad = () => { throw new Error("Choose an Anyroute history JSON export with valid conversations."); };
const text = (value, max, optional = false) => {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) bad();
  return value;
};
const number = (value) => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) bad();
  return value;
};

// Copy only the fields the encrypted history keeps. Never accept executable content, attachments or credentials.
function validateChat(c) {
  if (!c || typeof c !== "object" || !Array.isArray(c.lanes) || !c.lanes.length || c.lanes.length > 3) bad();
  const id = text(c.id, 200);
  const title = text(c.title, 80).trim();
  if (!id.trim() || !title || !Number.isFinite(c.at) || c.at < 0 || c.at > 8.64e15) bad();
  if (c.pinned !== undefined && typeof c.pinned !== "boolean") bad();
  const lanes = c.lanes.map((l) => {
    if (!l || !Array.isArray(l.messages) || l.messages.length > 10000) bad();
    const modelId = l.modelId == null ? null : text(l.modelId, 300);
    const messages = l.messages.map((m) => {
      if (!m || !["user", "assistant"].includes(m.role)) bad();
      const out = { id: text(m.id, 200), role: m.role, text: text(m.text, MAX_BYTES) };
      if (m.role === "user") {
        if (m.files !== undefined && (!Array.isArray(m.files) || m.files.length > 100)) bad();
        out.files = (m.files || []).map((f) => text(f, 500));
      } else {
        for (const key of ["model", "provider", "receiptId", "lane", "disclosure"]) {
          const value = text(m[key], 300, true);
          if (value !== undefined) out[key] = value;
        }
        if (m.stopped !== undefined && typeof m.stopped !== "boolean") bad();
        if (m.stopped) out.stopped = true;
        if (m.ms !== undefined) out.ms = number(m.ms);
        if (m.usage !== undefined) {
          if (!m.usage || typeof m.usage !== "object" || Array.isArray(m.usage)) bad();
          out.usage = {};
          for (const key of ["prompt_tokens", "completion_tokens", "cost"]) {
            if (m.usage[key] !== undefined) out.usage[key] = number(m.usage[key]);
          }
        }
      }
      return out;
    });
    return { modelId, messages };
  });
  return { id, title, at: c.at, pinned: c.pinned === true, lanes, ...folderFields(c), ...costSummaryFields(c) }; // C128
}

// Dedupe ids, plus identical conversation content with different ids. Do not overwrite anything already kept.
export function mergeImport(existing, incoming) {
  const ids = new Set(existing.map((c) => c.id));
  const content = (c) => JSON.stringify(c.lanes.map((l) => [l.modelId, l.messages.map((m) => [m.role, m.text, m.files || []])]));
  const seen = new Set(existing.map(content));
  const additions = [];
  for (const c of incoming) {
    const fingerprint = content(c);
    if (ids.has(c.id) || seen.has(fingerprint)) continue;
    ids.add(c.id);
    seen.add(fingerprint);
    additions.push(c);
  }
  const chats = [...existing, ...additions].sort((a, b) => b.at - a.at);
  if (chats.length > MAX_CHATS || bytes(JSON.stringify({ chats })) > MAX_BYTES) {
    throw new Error("History is full. Export or delete conversations before importing more.");
  }
  return { additions, skipped: incoming.length - additions.length };
}

export function parseImport(source) {
  if (typeof source !== "string" || bytes(source) > MAX_BYTES * 2) throw new Error("Choose a history JSON file smaller than 4 MB.");
  let doc;
  try { doc = JSON.parse(source); } catch { bad(); }
  if (doc?.format !== EXPORT_FORMAT || doc.version !== EXPORT_VERSION || !Array.isArray(doc.chats) || doc.chats.length > MAX_CHATS) bad();
  validateSavedAnswers(doc.savedAnswers); // D140
  return doc.chats.map(validateChat);
}

export function currentChat(lanes, saved, now = Date.now()) {
  const snapshot = snapshotLanes(lanes);
  if (!snapshot.some((l) => l.messages.length)) return null;
  return { id: saved?.id || "c" + now.toString(36), title: saved?.title || titleOf(lanes), at: saved?.at ?? now, pinned: saved?.pinned === true, ...folderFields(saved || {}), lanes: snapshot, costSummary: chatCost(lanes) }; // C128
}

export function exportJson(chats, savedAnswers = []) {
  return JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, chats, ...(savedAnswers.length ? { savedAnswers: validateSavedAnswers(savedAnswers) } : {}) }, null, 2) + "\n";
export function exportJson(chats, folders = []) {
  return JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, chats, ...(folders.length ? { folders: validateFolders(folders) } : {}) }, null, 2) + "\n";
}

const literal = (value) => String(value).replace(/[\\`*_{}[\]()#+.!|>~-]/g, "\\$&").replace(/[\r\n]+/g, " ");
export function exportMarkdown(chats) {
  return chats.map((c) => {
    const lines = [`# ${literal(c.title)}`, "", `Saved: ${new Date(c.at).toISOString()}`, ""];
    c.lanes.forEach((l, i) => {
      lines.push(`## ${chats.length > 0 && c.lanes.length > 1 ? `Conversation ${i + 1} · ` : ""}${literal(l.modelId || "Model not recorded")}`, "");
      for (const m of l.messages) {
        lines.push(`### ${m.role === "user" ? "You" : "Assistant"}`, "", m.text, "");
        if (m.files?.length) lines.push(`Attachment names: ${m.files.map(literal).join(", ")}`, "");
        if (m.receiptId) lines.push(`Receipt: ${literal(m.receiptId)}`, "");
      }
    });
    return lines.join("\n");
  }).join("\n---\n\n");
}

export function downloadChats(chats, format, scope = globalThis, savedAnswers = []) {
  if (!chats.length && !savedAnswers.length) throw new Error("There are no conversations to export.");
  const json = format === "json";
  const blob = new Blob([json ? exportJson(chats, savedAnswers) : exportMarkdown(chats) + savedAnswers.map((a) => `\n\n# Saved answer\n\n${a.question}\n\n${a.answer}\n\nModel: ${literal(a.model)} · Saved: ${new Date(a.at).toISOString()} · Cost: ${a.cost === null ? "Not reported" : a.cost}\nReceipt: ${literal(a.receiptId)}`).join("\n")], { type: json ? "application/json" : "text/markdown;charset=utf-8" });
export function downloadChats(chats, format, scope = globalThis, folders = []) {
  if (!chats.length && !folders.length) throw new Error("There are no conversations to export.");
  const json = format === "json";
  const blob = new Blob([json ? exportJson(chats, folders) : exportMarkdown(chats)], { type: json ? "application/json" : "text/markdown;charset=utf-8" });
  const url = scope.URL.createObjectURL(blob);
  const link = scope.document.createElement("a");
  link.href = url;
  link.download = chats.length === 1 ? `anyroute-chat.${json ? "json" : "md"}` : `anyroute-history.${json ? "json" : "md"}`;
  scope.document.body.append(link);
  try { link.click(); } finally { link.remove(); scope.setTimeout(() => scope.URL.revokeObjectURL(url), 1000); }
}

// An ephemeral index of decrypted chat data. Its owner unmounts it when the vault locks or the dialog closes.
export function buildSearchIndex(chats) {
  return chats.map((chat) => {
    const fields = [chat.title, ...chat.lanes.flatMap((l) => l.messages.map((m) => m.text))];
    return { chat, fields, lower: fields.map((f) => f.toLowerCase()) };
  });
}
export function searchChats(index, query) {
  const q = query.trim().toLowerCase();
  return index.flatMap(({ chat, fields, lower }) => {
    const hit = q ? lower.findIndex((f) => f.includes(q)) : 0;
    if (hit < 0) return [];
    const messageHit = q ? lower.findIndex((f, i) => i > 0 && f.includes(q)) : -1;
    let snippet = "";
    if (messageHit > 0) {
      const at = lower[messageHit].indexOf(q);
      const start = Math.max(0, at - 45);
      const end = Math.min(fields[messageHit].length, at + q.length + 90);
      snippet = (start ? "…" : "") + fields[messageHit].slice(start, end) + (end < fields[messageHit].length ? "…" : "");
    }
    return [{ chat, snippet }];
  }).sort((a, b) => Number(b.chat.pinned === true) - Number(a.chat.pinned === true) || b.chat.at - a.chat.at);
}
export function highlightParts(value, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text: value, match: false }];
  const lower = value.toLowerCase(), parts = [];
  let start = 0, at;
  while ((at = lower.indexOf(q, start)) !== -1) {
    if (at > start) parts.push({ text: value.slice(start, at), match: false });
    parts.push({ text: value.slice(at, at + q.length), match: true });
    start = at + q.length;
  }
  if (start < value.length) parts.push({ text: value.slice(start), match: false });
  return parts;
}

export function historyShortcut(e) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing || e.repeat) return null;
  if (e.key.toLowerCase() === "k" && !e.shiftKey) return "search";
  if (e.key.toLowerCase() === "e" && e.shiftKey) return "export";
  return null;
}
