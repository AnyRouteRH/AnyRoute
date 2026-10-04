import PageFrame from "../../components/PageFrame";
import { RegistryList } from "../../components/Registry";

export const metadata = { title: "Registry — Anyroute", description: "Every endpoint that attests through the router, the software measurements it verified over time, and an embeddable badge for each." };

export default function RegistryPage() {
  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <span className="eyebrow">REGISTRY / ATTESTED ENDPOINTS</span>
          <h1>
            What ran,
            <br />
            and when.
          </h1>
          <p>Each attested endpoint with the measurement the router verified, how long it held a fresh attestation and every time its software changed. Read live from the router’s public record.</p>
        </div>
        <RegistryList />
      </main>
    </PageFrame>
  );
}
