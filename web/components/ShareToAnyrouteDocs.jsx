export default function ShareToAnyrouteDocs() {
  return <section id="install-app">
    <h3>Install Anyroute</h3>
    <p>Open Chat and choose Install app from the page or your browser menu. On iPhone or iPad, open Chat in Safari and choose Share, then Add to Home Screen.</p>
    <section id="share-to-anyroute">
      <h4>Share to Anyroute from your phone</h4>
      <p>After installing, choose Anyroute in your phone’s share sheet to bring text, a link or images into Chat. Review the draft, choose a model and press Send. Sharing never sends a message for you. If you are signed out, sign in and then press Send.</p>
      <p>Phone share-sheet support depends on your browser and operating system. If Anyroute is absent, open Chat and paste your text or attach your images there. Images use the same preparation as other Chat attachments: up to 6 images, each up to 8 MB, re-encoded to JPEG with metadata stripped on your device. Choose a vision model to attach them.</p>
      <p>Text links use <code>GET /harness/?share_title=&amp;share_text=&amp;share_url=</code>. The draft joins nonempty title, text and URL fields with newlines; limits are 512, 16,000 and 2,048 characters, with 16,384 characters overall. These values are plain text, never instructions to open a URL. Query strings can appear in browser history or hosting access logs before Chat removes the shared fields from the address.</p>
      <p>The manifest uses one multipart <code>POST /harness/?share_target=1</code> target for text and images, with fields <code>share_title</code>, <code>share_text</code>, <code>share_url</code> and <code>share_files</code>. The installed service worker intercepts it without forwarding the body to the server. No sign-in is required to open a draft; sending uses the normal Chat key authentication. Original files wait in service-worker memory for a single-use handoff, usable for five minutes, with at most two pending shares. Another share or browser suspension can discard them; share again if needed. There is no persistent share cache. Ordinary sent requests are readable by the router in memory.</p>
    </section>
  </section>;
}
