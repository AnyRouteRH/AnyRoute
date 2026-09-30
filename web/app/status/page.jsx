import PageFrame from "../../components/PageFrame";
import ProofTime from "../../components/ProofTime";
import StatusBoard from "../../components/StatusBoard";

export const metadata = { title: "Anyroute status", description: "Availability, latency and error budgets for each privacy lane and API surface, incidents with Atom and RSS feeds, attestation advisories, and how long each attesting provider held a fresh attestation." };

export default function StatusPage() {
  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <span className="eyebrow">STATUS</span>
          <h1>
            Every lane,
            <br />
            measured in the open.
          </h1>
          <p>Availability, latency and error budgets for the public, attested and unlinkable lanes, against published targets. The public lane is counted from each request’s outcome. The private lanes are counted only through noisy hourly totals, so this page cannot single out any request.</p>
        </div>
        <StatusBoard />
        <div className="page-title" id="proof-time" style={{ marginTop: "clamp(48px, 7vw, 96px)" }}>
          <span className="eyebrow">STATUS / PROOF-TIME</span>
          <h2 className="h2" style={{ margin: "20px 0 22px", maxWidth: 780 }}>
            Uptime is nice.
            <br />
            Proof-time is better.
          </h2>
          <p>Being reachable is not the same as being verified. For each provider that runs in a confidential virtual machine, this is how long the router actually held a fresh attestation it checked itself. Every gap is listed as a gap.</p>
        </div>
        <ProofTime />
      </main>
    </PageFrame>
  );
}
