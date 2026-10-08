// D143
export default function ChatFoldersDocs() {
  return <section id="chat-folders"><h2>Organize Chat into folders</h2>
    <p>Create folders in Chat history, rename them and move chats from the Move to… menu. On larger screens you can also drag a chat onto a folder. Folder counts show how many chats each holds; on a phone, choose a folder from the dropdown.</p>
    <p>Search titles and messages in the selected folder, or choose Search all chats. All chats includes every saved conversation. Deleting a folder returns its chats to All chats and keeps every conversation.</p>
    <p>Folders are available when you enable Private mode and unlock browser history. Names, folder IDs and each chat’s folder assignment are kept inside the existing passphrase-encrypted vault. Locking drops them from memory; Forget everything removes them with the vault. Nothing about folders is uploaded. The router still reads ordinary requests in memory to route them.</p>
    <p>History exports in JSON keep folders, including empty folders, and chat assignments. Import merges folders with matching names and preserves existing chats. A single-chat export includes its folder; Markdown exports contain conversation text without folder organization. Downloads contain readable text. Older history exports without folders still import. Up to 40 folders can be kept within the existing browser history size limit. There is no new HTTP endpoint or server configuration flag.</p>
  </section>;
}
