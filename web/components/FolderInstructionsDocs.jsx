// G157
export default function FolderInstructionsDocs() {
  return <section id="folder-instructions"><h2>Apply instructions to a Chat folder</h2>
    <p>Choose a folder in Chat history and open Instructions. Save up to 4,000 characters to guide every chat in that folder. The composer shows “Folder instructions on”; choose it to edit or clear the text. Moving a chat into or out of a folder changes the instructions from its next message.</p>
    <p>Each request sends the folder instructions as its first system message, followed by the chat’s own system prompt, preset or character when one is set. Both still apply. The context meter, prompt cost estimate and Copy as code include the folder instructions. Empty instructions add nothing to requests.</p>
    <p>Instructions are available with folders when Private mode is on and browser history is unlocked. They stay in the existing passphrase-encrypted history vault, and history exports in JSON carry them in the folder’s optional <code>instructions</code> field. Downloads contain readable text; Markdown exports omit folder metadata. Imports keep the instructions of an existing folder with the same name. Older exports without instructions still work.</p>
    <p>This adds no HTTP endpoint or server configuration flag. The existing <code>POST /api/v1/chat/completions</code> request uses its existing authentication and ordered <code>messages</code> array. Instructions are sent with inference requests; the router reads request text in memory. Browser history encryption does not hide those requests from the router.</p>
  </section>;
}
