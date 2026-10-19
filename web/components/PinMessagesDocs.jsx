// K191
export default function PinMessagesDocs() {
  return <section id="pin-messages"><h2>Pin a message in Chat</h2>
    <p>Open Message menu on your message or a reply and choose Pin message. The slim Pinned strip at the top of each conversation shows how many messages are pinned. Choose one to jump to it. Choose Unpin in the strip or Unpin message in its menu to remove the pin. Wait for replies or summaries to finish before changing pins.</p>
    <p>Pins follow the shown message version. Editing a message or regenerating a reply creates an unpinned version; switching back brings its pins back. Shared earlier messages keep their pins. Summarize and continue keeps pinned messages in full alongside the new summary. Pinned turns stay in the summary request; if they need too much room, unpin a message or choose a model with more room. The continued chat’s context meter includes those messages. Print / Save as PDF marks pinned messages.</p>
    <p>Turn on encrypted history to keep pins after closing Chat. Pins use the same browser vault and its Lock and Forget controls. History exports include pins; JSON import restores them. Downloads and printed pages are readable outside the vault. Pins are not synced between browsers, and pinning sends no request.</p>
    <h3>API details</h3>
    <p>No new endpoint, authentication rule, flag or migration is added. An optional boolean <code>pinned</code> on user and assistant messages extends version 1 of the existing browser history format, including branch nodes. Older exports without this field still open. Summaries use the existing authenticated <code>POST /api/v1/chat/completions</code> path, billing and spending controls. The router reads ordinary inference and summary request text in memory.</p>
  </section>;
}
