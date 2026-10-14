// H174
export default function PrintChatDocs() {
  return <section id="print-chat"><h2>Print or save a chat as PDF</h2>
    <p>Open Chat menu beside the chat actions and choose Print / Save as PDF. Choose your printer or Save as PDF in your browser’s print dialog. The layout includes the chat title, date, shown messages, each reply’s model, cost and receipt ID, and available images. Markdown is rendered and long code lines wrap. Comparison lanes print one after another, in the order shown. Only the selected version of each message prints.</p>
    <p>The pages use light colours even in dark mode, with no app controls. Page numbers use print page margins where your browser supports them; otherwise enable headers and footers in the print dialog. Wait for replies to finish before printing. Missing costs and receipts are marked pending or unavailable. Files show their names only. Reasoning, tool traffic, system instructions and other branch versions are left out.</p>
    <p>This uses <code>window.print()</code> in your browser. There is no new endpoint, authentication rule, configuration flag or migration. Printing makes no upload request and keeps no new browser history. Images print from inline bytes already available in the chat; images that need a separate request are marked unavailable. Your printer or PDF destination is chosen by you. Ordinary inference requests still pass through the router in memory.</p>
  </section>;
}
