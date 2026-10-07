export default function CopyAsCodeDocs() {
  return <section id="copy-as-code">
    <h3>Copy a Chat conversation as code</h3>
    <p>Open More in the Chat header, then choose Copy as code to take the selected conversation and its settings into your own app. Choose curl, TypeScript or Python, then copy the request. Images and files are left out, with their counts shown.</p>
    <p>The request uses <code>POST /api/v1/chat/completions</code> with bearer-key authentication and the same public API base as the quickstart. Set <code>ANYROUTE_API_KEY</code> in your environment; your browser’s key is never included. The model, supported settings, system message, text and tool turns, and current routing headers are copied. Replies use <code>stream: true</code>. TypeScript uses built-in fetch; Python needs requests installed. Temporary Chat spending limits and single-use approval headers are not copied; use a key with the limits you need. Ordinary requests are readable by the router in memory.</p>
  </section>;
}
