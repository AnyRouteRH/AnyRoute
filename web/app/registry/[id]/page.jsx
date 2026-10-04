import PageFrame from "../../../components/PageFrame";
import { RegistryEntry } from "../../../components/Registry";

// One static page serves every /registry/<provider id>/: the router answers any such address with it (src/app.ts), and
// the page reads the id from the address (or from ?p=<id>) and the record from the public API.
export const dynamicParams = false;
export function generateStaticParams() {
  return [{ id: "_" }];
}

export const metadata = { title: "Registry entry — Anyroute", description: "One endpoint’s measurement history as the router recorded it, and its embeddable attestation badge." };

export default function RegistryEntryPage() {
  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <span className="eyebrow">REGISTRY / MEASUREMENT HISTORY</span>
          <h1>
            On the
            <br />
            record.
          </h1>
          <p>Every attestation check the router ran for this endpoint, the software measurements it verified, and the badge that shows it on your site.</p>
        </div>
        <RegistryEntry />
      </main>
    </PageFrame>
  );
}
