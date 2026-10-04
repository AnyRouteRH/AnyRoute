import PageFrame from '../../components/PageFrame';
import ZkapiWallet from './wallet';
import './zkapi.css';

export const metadata = { title: 'Pay with zkAPI — Anyroute', description: 'A Sepolia pilot for separating a funding-wallet address from inference requests. Experimental, unaudited ETH notes with explicit network and prompt limits.' };

export default function ZkapiPage() {
  return <PageFrame><main className="page-main" id="content">
    <div className="page-title"><span className="eyebrow">PAY / SEPOLIA PILOT</span><h1>Pay with zkAPI.</h1><p>Keep your funding wallet apart from your AI calls.</p><p>Separate your funding-wallet address from your inference requests using an ETH note. Calls within a lease still link to one key and the operator’s account. This is an experimental, unaudited protocol.</p></div>
    <div className="zkapi-limits" aria-label="Payment and privacy limits">
      <p><strong>Prompts and network.</strong> AnyRoute reads ordinary prompts in memory. The model provider also receives them. AnyRoute sees your IP unless you use its <a href="/docs/#unlinkable" className="inline-link">onion service</a>. This page makes ordinary HTTPS calls; it does not select the onion route. The operator sees your connection and proofs.</p>
      <p><strong>Public chain, changing value.</strong> Deposits and withdrawals are public Sepolia transactions and require ETH for gas. Funding links can still be inferred from amounts, timing, withdrawal addresses or prompt content. ETH’s dollar value changes; usage uses the quote fixed when each lease starts.</p>
      <p><strong>Withdraw before expiry.</strong> An expired active note can be claimed in full by the treasury, including its unused balance. Cooperative withdrawal needs the operator. If it is unavailable, the protocol has an escape process with a challenge window; this page supports mutual close only. The setup is single-party and has no established production audit.</p>
    </div>
    <ZkapiWallet />
  </main></PageFrame>;
}
