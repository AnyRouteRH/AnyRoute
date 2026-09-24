import PageFrame from '../../../components/PageFrame';
export const metadata={title:'Data notice — Anyroute'};
export default function Privacy(){return <PageFrame><main className="page-main" id="content">
  <div className="page-title" data-reveal><span className="eyebrow">LEGAL / DATA NOTICE</span><h1>Data notice</h1><p>What the router stores, where your prompts go and how to remove your key from this browser.</p></div>
  <div className="side-layout">
    <nav className="side-nav" aria-label="Legal pages" data-reveal="fade"><span className="side-nav-label">Legal</span><a href="/legal/privacy/" aria-current="page">Data notice</a><a href="/legal/terms/">Service notes</a></nav>
    <article className="page-body prose legal-body" data-reveal>
      <h2>What the router stores</h2>
      <p>The router stores what it needs to route and account for calls: API key hashes (never the keys), balances and ledger entries, receipts with token counts, costs and SHA-256 hashes of each request and response, the wallet addresses you link or pay from, and encrypted bring-your-own provider keys. It never stores prompt or response text. The optional response cache is encrypted, scoped to your workspace and expires.</p>
      <h2>Where your prompts go</h2>
      <p>Your prompts are sent to the provider that serves each call, under that provider’s data policy, shown per provider in the dashboard. Private requests go only to attested TEE providers. Deposits, payments and receipt anchors are public on Robinhood Chain. The dashboard keeps your API key in this browser’s storage.</p>
      <h2>Your controls</h2>
      <p>Use “Sign out of this browser” in the dashboard settings to remove the key from this browser. Exports of your keys, balance and receipts are available from the same page. The sample workspace, if you open it, keeps its fictional data in this browser only.</p>
      <div className="note">The operator of this router must publish its legal entity, retention periods and a full privacy policy before offering the service publicly.</div>
      <a className="inline-link" href="/dashboard/#settings">Open workspace settings →</a>
    </article>
  </div>
</main></PageFrame>}
