import type { ExternalDoc } from "./types";
// D143: supplement to the existing browser history inventory; no server readers or stores.
export const chatFoldersBrowser: ExternalDoc["browser"]["items"][number] = {
  store: "IndexedDB (existing encrypted Chat history vault)",
  holds: "Opt-in Chat folders keep up to 40 folder ids and names plus each saved chat's optional folderId inside the same passphrase-encrypted anyroute-private-history vault as chats and private prompts. No additional browser storage key or server table, column, Redis family or log field is created. Unlocked folder names, assignments, counts, selection and search text live in page memory; counts are derived from chats and selection/search are not persisted. A drag carries only a chat id in browser drag data. Deleting a folder removes its assignments and keeps every chat. Locking drops the decrypted folders with history; Forget deletes the vault. Without browser storage the existing memory fallback lasts only for the tab. JSON downloads expose readable chats, folder ids/names and assignments, including empty folders in a full-history export; single-chat downloads include only its folder. Import validates and merges this metadata in one encrypted write, maps colliding folder ids and keeps existing chats. Markdown exports omit folder organization. Folder operations do not upload data; ordinary inference requests are still read by the router in memory.",
  evidence: [
    { file: "web/lib/chat-folders.js", contains: "export function folderVaultEdits" },
    { file: "web/lib/private-history.js", contains: "folders = s.folders" },
    { file: "web/components/harness/ChatFolders.jsx", contains: "FOLDER_DRAG_TYPE" },
  ],
};
