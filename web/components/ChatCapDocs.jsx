// G162
export default function ChatCapDocs() {
  return <section id="chat-cap"><h2>A spending cap for each chat</h2>
    <p>Open the chat’s cost chip to choose $0.50, $1, $2, $5 or a custom amount. Chat holds a send when the amount already spent plus the next request’s estimate would pass the cap. Raise the cap or choose Send anyway for that one send. In Chat settings in the Tools panel, choose a default for new chats.</p>
    <p>This is a browser-side guard. Key budgets and agent rulebooks are the hard limits enforced by the router. Estimates use the existing cost calculator’s text-token rates, expected output and listed request fee, adding every comparison lane. Output uses the request’s token limit when supplied, otherwise 512 tokens. Image, audio, search, cache and separate reasoning charges are not included; actual charges can differ. Missing prices hold the send for review. Retries, tool follow-ups and summaries are checked too.</p>
    <p>Caps travel with conversations in the existing passphrase-encrypted browser history and history exports and imports. History must be enabled to retain a chat’s cap after closing the page. Older chats have no cap. The default is a browser preference and is not encrypted; it never changes an existing chat’s cap. Remove cap restores the usual send behaviour.</p>
    <p>No new API, server setting or migration is added. History’s optional <code>spendingCap</code> is a positive integer micro-dollar string. The existing browser preferences hold <code>defaultChatCap</code> as the same kind of string or <code>null</code>. Cap checks do not upload data. The router still reads ordinary inference request text in memory.</p>
  </section>;
}
