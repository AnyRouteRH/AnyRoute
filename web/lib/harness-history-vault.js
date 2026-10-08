import { mergeSavedAnswers } from "./saved-answers.js"; // D140
// These operations run inside the existing vault's serial queue. Metadata and imports are sealed with its key.
import { folderFields } from "./chat-folders.js"; // D143
import { costSummaryFields } from "./chat-cost.js"; // C128
export function savedEntry(chat, previous, at) {
  return { id: String(chat.id), title: String(previous?.title || chat.title || "Untitled").slice(0, 80), at, lanes: chat.lanes, ...folderFields(previous || chat), ...(previous?.pinned ? { pinned: true } : {}), ...costSummaryFields(chat) }; // C128
}

export function historyEdits({ serial, need, seal, maxBytes, maxChats }) {
  const commit = async (s, chats, savedAnswers = s.savedAnswers) => {
    if (chats.length > maxChats || new TextEncoder().encode(JSON.stringify({ chats, ...(s.folders === undefined ? {} : { folders: s.folders }) })).length > maxBytes) {
      throw new Error("History is full. Export or delete conversations before importing more.");
    }
    await seal(s, chats, s.prompts, savedAnswers);
    s.chats = chats;
    s.savedAnswers = savedAnswers; // D140
  };
  return {
    edit: (id, patch) => serial(async () => {
      const s = need();
      const title = patch.title === undefined ? undefined : String(patch.title).trim().slice(0, 80);
      if (title === "") throw new Error("Give the conversation a title.");
      const chats = s.chats.map((c) => c.id !== id ? c : {
        ...c, ...(title === undefined ? {} : { title }),
        ...(typeof patch.pinned === "boolean" ? { pinned: patch.pinned } : {}),
      });
      await commit(s, chats);
    }),
    // Callers validate and deduplicate before this merge. Existing ids are never overwritten.
    importChats: (incoming, incomingAnswers = []) => serial(async () => {
      const s = need();
      const ids = new Set(s.chats.map((c) => c.id));
      const additions = incoming.filter((c) => !ids.has(c.id) && !!ids.add(c.id));
      await commit(s, [...s.chats, ...additions].sort((a, b) => b.at - a.at), mergeSavedAnswers(s.savedAnswers || [], incomingAnswers)); // D140
      return additions.length;
    }),
  };
}
