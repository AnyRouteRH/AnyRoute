import PageFrame from "../../components/PageFrame";
import ProofGuide from "../../components/ProofGuide";
import Verify from "../../components/Verify";
import GettingStartedReceiptVisit from "../../components/GettingStartedReceiptVisit"; // C135

export const metadata = { title: "Verify a provider — Anyroute", description: "What the router has and has not verified about a provider’s attestation, and a receipt checker that runs in your browser." };

export default function VerifyPage() {
  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <span className="eyebrow">VERIFY / PROVIDERS AND RECEIPTS</span>
          <h1>
            Check it
            <br />
            yourself.
          </h1>
          <p>What the router has verified about a provider’s hardware attestation, what it has not, and a receipt checker that runs in your browser against the keys the router publishes. Anything unverified stays marked unverified.</p>
        </div>
        <Verify />
        <GettingStartedReceiptVisit /> {/* C135 */}
        <ProofGuide />
      </main>
    </PageFrame>
  );
}
