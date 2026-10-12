import type { ExternalDoc } from "./types";
// G157: describe the addition to the existing browser folder metadata.
export const folderInstructionsBrowser: ExternalDoc["browser"]["items"][number] = {
  store: "IndexedDB (existing encrypted Chat history vault)",
  holds: "Each Chat folder may keep instructions of up to 4,000 characters in its optional instructions field, inside the existing passphrase-encrypted history document. There is no new browser key, server table, column, Redis family or log field. The editor draft, current folder and ordered system messages are decrypted page memory only; locking or forgetting history removes the active folder metadata and editor draft, so later requests no longer use them. System-message snapshots already attached to on-screen replies or linked summaries remain in page memory for context counting until those chats are reset or the page closes; they are not saved in history. Closing the editor drops its draft. JSON exports and imports carry readable instructions with folder metadata, including single-chat exports; matching folder names keep the existing instructions. Markdown omits this metadata. From the next message after a move or edit, inference sends the current folder instructions as the first system message before the chat prompt; the router reads request text in memory on every lane. Copy as code also contains readable instructions. Context and cost estimates read them in browser memory. Empty instructions add no request message.",
  evidence: [
    { file: "web/lib/folder-instructions.js", contains: "export const MAX_FOLDER_INSTRUCTIONS = 4000" },
    { file: "web/lib/chat-folders.js", contains: "setFolderInstructions: (id, instructions)" },
    { file: "web/components/harness/FolderInstructions.jsx", contains: "export function FolderInstructionsBridge" },
    { file: "web/lib/harness.js", contains: "wire.push(...systemMessages(" },
  ],
};
