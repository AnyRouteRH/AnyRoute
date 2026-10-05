import PageFrame from "../../components/PageFrame";
import LabsBoard from "./LabsBoard";

export const metadata = { title: "Labs — Anyroute", description: "Features that are built but switched off, or still a pilot. Each one’s state is read live from the router’s public status, with a link to its documentation." };

export default function LabsPage() {
  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <span className="eyebrow">LABS</span>
          <h1>
            Built, but
            <br />
            not switched on.
          </h1>
          <p>These features are in the code and documented, but not every one is switched on here. Each state below comes from GET /api/v1/status when this page opens, so a switch shows the moment it flips. Pilots and switched-off parts that the status does not report carry the state their documentation gives.</p>
        </div>
        <LabsBoard />
      </main>
    </PageFrame>
  );
}
