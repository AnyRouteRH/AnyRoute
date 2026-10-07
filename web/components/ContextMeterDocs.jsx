export default function ContextMeterDocs() {
  return <section id="context-meter">
    <h2>Keep room in Chat</h2>
    <p>See about how much of the selected model’s context window your conversation uses, including the system prompt, attachments and your draft. At 80%, Chat warns that older messages may be cut. At 100%, sending stops until you shorten the draft, summarize, or choose a model with more room. Choosing a smaller model updates the meter and shows a notice.</p>
    <p>Summarize and continue asks the same selected model for a summary, then starts a new chat with that summary as its first message. The summary uses normal billing, spending limits and receipts. A link opens the previous chat during this visit; the existing encrypted history option controls saving. The draft and system prompt stay in place. Summaries may lose details; if the request needs more room, older messages are left out and Chat tells you. Saved routes require choosing a single model first.</p>
    <h3>API details</h3>
    <p>No new endpoint or response field is added. Chat reads <code>context_length</code> from <code>GET /api/v1/models</code> and sends summaries through <code>POST /api/v1/chat/completions</code> with the same key, spending controls and privacy routing as ordinary replies.</p>
    <p>The browser uses returned prompt and completion counts when available, without adding cumulative prompt counts twice. Other text uses a rounded-up characters-divided-by-four estimate with message overhead. Counts always say “about”: tokenization varies, images have a rough allowance, and PDFs use a file-size allowance rather than extracted text. These allowances can undercount. Provider limits still apply. The router reads ordinary requests and summary requests in memory. No new server storage or background work is added; the meter and return link stay in browser memory.</p>
  </section>;
}
