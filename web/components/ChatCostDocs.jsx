// C128
export default function ChatCostDocs() {
  return <section id="chat-cost"><h2>This chat’s cost</h2>
    <p>See the running cost and reply count in the Chat header. Comparing models adds up replies from every lane. Failed and free replies count toward the reply count and add $0.</p>
    <p>The total adds the amounts shown beside replies. It updates as cost arrives during a reply; a reply without a reported cost adds $0 until that amount arrives. Stopped replies include any reported charge. Copies of an earlier reply in another comparison lane count once.</p>
    <p>Saved chats show the same total in history. Totals are kept with the conversation in the existing passphrase-encrypted browser history, including totals for replies whose contents are not saved. Older saved chats use the costs still available in their saved replies. History stays off until you enable it; there is no new API or account setting.</p>
  </section>;
}
