// D140
export default function SavedAnswersDocs() {
  return <section id="saved-answers"><h2>Save answers in Chat</h2>
    <p>Choose Save beside a finished text reply, then open Saved in the Chat sidebar to find it again. Search questions and answers, read the full reply, follow its receipt link or open the chat while it still exists. Unsave removes the saved copy. Deleting a chat keeps its saved answers.</p>
    <p>Create or unlock browser history with a passphrase first. Saving an answer does not switch the chat’s lane or clear the conversation. Saved answers use that history’s passphrase and stay in the same encrypted browser vault. This does not hide requests from Anyroute: the router still reads request text in memory.</p>
    <p>Each saved answer keeps the reply text, the preceding question, model, reported cost, save date, receipt ID and the chat and reply IDs used to open it again. Missing costs and receipts remain missing. Images, attachments, reasoning and tool results are not included. Saved answers have a separate 256 KB limit; saving never removes an older answer.</p>
    <p>History exports include saved answers even after their chats are deleted. Import a history export to restore them; repeated IDs keep the existing copy. Downloads contain readable text. Locking history drops decrypted answers from memory; Forget everything also deletes saved answers. Browsers without lasting storage keep history only until the tab closes.</p>
    <p>This feature adds no API endpoint, server storage, configuration flag or migration.</p>
  </section>;
}
