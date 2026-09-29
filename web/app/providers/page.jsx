import PageFrame from "../../components/PageFrame";
import Providers from "../../components/Providers";

export const metadata = { title: "Providers — Anyroute", description: "Every provider the router lists, with the attestation status the router itself has verified, and how to run a provider." };

export default function ProvidersPage() {
  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <span className="eyebrow">PROVIDERS / ATTESTATION STATUS</span>
          <h1>
            Who serves
            <br />
            your model.
          </h1>
          <p>Each provider with the hardware and verifiers the router recorded, when it last verified them, and a link to check it yourself. Providers the router has not verified are marked Unverified.</p>
        </div>
        <Providers />
      </main>
    </PageFrame>
  );
}
