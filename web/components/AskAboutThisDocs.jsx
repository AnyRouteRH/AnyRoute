// H175
export default function AskAboutThisDocs() {
  return <section id="ask-about-this"><h2>Ask about a highlighted part</h2>
    <p>Select text in an assistant’s answer in Chat, then choose Ask about this. On touch screens, use the floating button beside the selection. You can also press Alt+Shift+Q while the text is selected. The button’s tooltip shows the shortcut.</p>
    <p>The selected plain text becomes a quote above the cursor’s line in the composer. Type your follow-up and send when ready. Each line starts with <code>&gt;</code>; selections longer than 1,500 characters are shortened with an ellipsis. Rendered Markdown and code use the text you selected. In compare mode, the quote goes into the existing shared composer for the focused lane; Send still sends to all compared models.</p>
    <p>No new endpoint, setting or separate storage is added. Selection stays in page memory. Once inserted, the quote is ordinary message text and follows existing Chat history and request handling. Anyroute’s router reads ordinary request text in memory.</p>
  </section>;
}
