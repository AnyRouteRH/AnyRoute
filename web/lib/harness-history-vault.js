// These operations run inside the existing vault's serial queue. Metadata and imports are sealed with its key.
export function savedEntry(chat, previous, at) {
  return { id: String(chat.id), title: String(previous?.title || chat.title || "Untitled").slice(0, 80), at, lanes: chat.lanes, ...(previous?.pinned ? { pinned: true } : {}) };
}

export function historyEdits({ serial, need, seal, maxBytes, maxChats }) {
  const commit = async (s, chats) => {
    if (chats.length > maxChats || new TextEncoder().encode(JSON.stringify({ chats })).length > maxBytes) {
      throw new Error("History is full. Export or delete conversations before importing more.");
    }
    await seal(s, chats);
    s.chats = chats;
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
    importChats: (incoming) => serial(async () => {
      const s = need();
      const ids = new Set(s.chats.map((c) => c.id));
      const additions = incoming.filter((c) => !ids.has(c.id) && !!ids.add(c.id));
      await commit(s, [...s.chats, ...additions].sort((a, b) => b.at - a.at));
      return additions.length;
    }),
  };
}
