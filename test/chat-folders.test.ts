import { test, expect } from "bun:test";
import { createHistory, memoryStorage } from "../web/lib/private-history.js";
import { exportJson } from "../web/lib/harness-history.js";
import { parseFolderImport, searchFolder } from "../web/lib/chat-folders.js";

test("D143: history is opt-in and folders cannot bypass the locked vault", async () => {
  const storage = memoryStorage();
  const h = createHistory({ storage, iterations: 100000 });
  expect(await storage.get()).toBeNull();
  expect(h.unlocked).toBe(false);
  await expect(h.createFolder("Work")).rejects.toThrow("locked");
  expect(await storage.get()).toBeNull();
  await h.create("sample folder passphrase");
  await h.createFolder("Work");
  const folder = h.listFolders()[0];
  const incoming = parseFolderImport(exportJson([{ id: "chat", title: "Notes", at: 1, folderId: folder.id, lanes: [{ modelId: null, messages: [{ id: "u", role: "user", text: "Read this", files: [] }] }] }], [folder]));
  expect((await h.importFolderHistory(incoming)).count).toBe(1);
  expect(searchFolder([h.get("chat")], "read", folder.id)).toHaveLength(1);
  await h.deleteFolder(folder.id);
  expect(h.get("chat").folderId).toBeUndefined();
  expect(h.list()).toHaveLength(1);
  h.lock();
  await expect(h.importFolderHistory(incoming)).rejects.toThrow("locked");
  await expect(h.renameFolder(folder.id, "New")).rejects.toThrow("locked");
  await expect(h.deleteFolder(folder.id)).rejects.toThrow("locked");
});
