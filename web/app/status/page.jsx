import PageFrame from "../../components/PageFrame";
import ProofTime from "../../components/ProofTime";

export const metadata = { title: "Proof-time — Anyroute", description: "For each provider that attests, how much of the last 24 hours and 7 days the router held a fresh attestation it verified itself, with measurement changes and the last failure." };

export default function StatusPage() {
  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <span className="eyebrow">STATUS / PROOF-TIME</span>
          <h1>
            Uptime is nice.
            <br />
            Proof-time is better.
          </h1>
          <p>Being reachable is not the same as being verified. For each provider that runs in a confidential virtual machine, this is how long the router actually held a fresh attestation it checked itself. Every gap is listed as a gap.</p>
        </div>
        <ProofTime />
      </main>
    </PageFrame>
  );
}
