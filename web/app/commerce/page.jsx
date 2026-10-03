import PageFrame from "../../components/PageFrame";
import CommerceLedger from "./CommerceLedger";

export const metadata = { title: "Commerce ledger · Anyroute", description: "Paid settlements between agents, sellers and the router, counted only once their receipts are anchored on chain, with self-dealing filtered out. Every filtered figure sits next to the gross one, and a Dune query recomputes the on-chain part." };

export default function CommercePage() {
  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <span className="eyebrow">COMMERCE</span>
          <h1>
            Paid work,
            <br />
            counted honestly.
          </h1>
          <p>Every settlement the router can prove, over the last day, week and month. A settlement counts only once its receipt is anchored on Robinhood Chain, and not when the payer and payee share an owner, send the money back, or are linked by funding. The gross figure always sits next to the filtered one, so you can see what was taken out and why.</p>
        </div>
        <CommerceLedger />
      </main>
    </PageFrame>
  );
}
