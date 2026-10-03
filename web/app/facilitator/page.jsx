import PageFrame from '../../components/PageFrame';
import { Code } from '../../components/UI';
import FacilitatorState from './FacilitatorState';
import { LISTING_EXAMPLE, SELLER_EXAMPLE } from '../../lib/facilitator';

export const metadata = { title: 'x402 facilitator for Robinhood Chain | Anyroute', description: 'Verify and settle x402 USDG payments on Robinhood Chain (eip155:4663). USDG goes from the payer straight to the seller; the facilitator only pays the gas.' };

export default function FacilitatorPage() {
  return <PageFrame><main className="page-main" id="content">
    <div className="page-title" data-reveal>
      <span className="eyebrow">PAY / X402 FACILITATOR</span>
      <h1>Get paid in USDG.<br />We only pay the gas.</h1>
      <p>A hosted x402 facilitator for Robinhood Chain (eip155:4663). Send it a buyer’s payment and it verifies and settles it. USDG moves from the payer straight to your payTo address. The facilitator never holds it.</p>
    </div>
    <FacilitatorState />
    <article className="page-body prose">
      <h2 id="use">Point your server at it.</h2>
      <p>Use https://anyroute.tech/facilitator as the facilitator address, with network eip155:4663 and asset USDG. It speaks x402 v1 and v2 and answers GET /supported, POST /verify and POST /settle. Verify before you do the work, settle after.</p>
      <Code label="Verify, work, settle (JavaScript)">{SELLER_EXAMPLE}</Code>
      <h2 id="checks">What it checks before it relays.</h2>
      <ul>
        <li><b>The signature.</b> The payer’s EIP-712 signature over USDG’s own domain, from a plain wallet or a smart wallet.</li>
        <li><b>The recipient and amount.</b> The authorization pays your payTo at least the amount you asked for.</li>
        <li><b>The time window.</b> validBefore must outlive the relay by at least 6 seconds.</li>
        <li><b>The nonce, once.</b> An authorization settles at most once, on chain and in the facilitator’s own record, so a replay is refused.</li>
        <li><b>The balance.</b> The payer holds enough USDG.</li>
      </ul>
      <h2 id="costs">What it costs.</h2>
      <p>No fee during the launch waiver: you receive the full amount. The smallest payment it settles is 0.01 USDG, because each settle costs gas. To accept smaller payments, prepay a gas float in USDG; each small settle is debited at its measured gas plus a buffer. When the relay key runs below its gas floor the facilitator refuses with facilitator_unavailable instead of queueing your payment.</p>
      <h2 id="listing">Get listed.</h2>
      <p>Sign a listing with your payTo key: the paid URL, a price hint, an output schema and tags. Listed sellers appear at GET /facilitator/discovery/resources in the same item shape x402 discovery clients read. Listings are screened against the public OFAC SDN list. Payers are not, because the facilitator never holds the funds it relays.</p>
      <Code label="Sign and send a listing (viem)">{LISTING_EXAMPLE}</Code>
      <h2 id="receipts">Every settle is signed.</h2>
      <p>Each settle gets a receipt signed with the router’s receipt key: the transaction, amount, payTo and network, and no payer. Receipts are rooted every hour with the router’s other receipts. Read one at GET /facilitator/receipts/&#123;id&#125;, and check its signature and anchor proof with POST /api/v1/receipts/verify.</p>
      <h2 id="limits">What it does not do.</h2>
      <ul>
        <li>It cannot make a seller deliver. It relays payments; it does not judge the work.</li>
        <li>A listing is a hint. Your own 402 response stays the price and payTo a buyer should trust.</li>
        <li>The first payTo to list a URL owns that entry.</li>
        <li>It settles USDG on Robinhood Chain only.</li>
      </ul>
    </article>
  </main></PageFrame>;
}
