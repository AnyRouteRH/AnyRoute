import PageFrame from '../../../components/PageFrame';
export const metadata={title:'Terms — Anyroute'};
export default function Terms(){return <PageFrame><main className="page-main" id="content">
  <div className="page-title" data-reveal><span className="eyebrow">LEGAL / SERVICE NOTES</span><h1>Service notes</h1><p>How routing, fees and Stock Token payments work on this router.</p></div>
  <div className="side-layout">
    <nav className="side-nav" aria-label="Legal pages" data-reveal="fade"><span className="side-nav-label">Legal</span><a href="/legal/privacy/">Data notice</a><a href="/legal/terms/" aria-current="page">Service notes</a></nav>
    <article className="page-body prose legal-body" data-reveal>
      <h2>Launch status</h2>
      <p>AnyRoute’s public preview uses sample data and does not accept deposits or live payments. Customer support details and final service terms will be published before payments are enabled.</p>
      <h2>Routing and fees</h2>
      <p>Anyroute routes AI requests to third-party model providers and settles usage in USDG on Robinhood Chain. Prepaid calls carry a 0% router fee; per-call payments carry a margin of at most 1%; providers are paid their list price minus a settlement fee. Model output comes from the provider that served the call.</p>
      <h2>Paying with a Stock Token</h2>
      <p>Paying with a Stock Token sells a small amount of that token at the Chainlink fair value to cover the USDG owed, within the daily cap you set. This is a payment feature, not investment advice. On-chain transactions are final. Prepaid withdrawal requests require your key’s signature and a proof against an approved settlement record. Independent review and the timelock can delay withdrawals. A missing record or unavailable proof can prevent withdrawal; the seven-day fallback still requires a valid proof.</p>
      <h2>Who approves movements of funds</h2>
      <p>The reviewed contract design requires separate approval for settlement records, exact transfers and provider penalties. A provider dispute invalidates earlier penalty approval. These controls depend on independently operated approval wallets and accurate usage records; they do not verify off-chain usage by themselves. Existing deployments require verification and migration before these protections apply.</p>
      <h2>References</h2>
      <p>References to Robinhood Chain, model authors and other services identify compatibility and the network used. They do not imply endorsement or partnership.</p>
      <div className="note">The operator of this router must publish binding legal and commercial terms before offering the service publicly.</div>
      <a className="inline-link" href="/">Return to Anyroute →</a>
    </article>
  </div>
</main></PageFrame>}
