// G156
export default function EditAndBranchDocs() {
  return <section id="edit-and-branch"><h2>Edit a message and branch the chat</h2>
    <p>Choose Edit beside any message you sent, then Save and resend. Chat starts a new version from that message and keeps the original reply and everything after it. Use the arrows under the message to switch versions, including each version’s later messages. Regenerate keeps the earlier reply as another version too.</p>
    <p>Only the version on screen is sent with your next message and counted by the context meter and chat cost. Replies on other versions were still billed when they ran; switching versions does not refund them.</p>
    <p>Versions stay with a saved chat in the existing passphrase-encrypted browser history, alongside folders and saved answers. Enable Private mode and unlock history to keep conversations through reloads. JSON history exports and imports preserve all versions; Markdown exports show the selected conversation. Downloads contain readable text. Older saved chats still open. The existing history size limit applies across all versions. Document contents, audio and reasoning are not kept in history.</p>
    <p>No HTTP endpoint or configuration flag is added. Requests use POST /api/v1/chat/completions with the existing Chat authentication and limits. Optional branches metadata extends each lane in version 1 of the existing history format; older clients can read the selected messages and ignore it. Branch controls do not upload inactive versions. Anyroute’s router still reads requests in memory to route them.</p>
  </section>;
}
