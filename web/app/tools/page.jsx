import PageFrame from "../../components/PageFrame";
import ToolsCatalog from "../../components/ToolsCatalog";

export const metadata = { title: "Anyroute paid tools", description: "x402 tools any Anyroute key can pay from its balance, each with a daily known-answer probe, and how a paid call is held, charged and receipted." };

export default function ToolsPage() {
  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <span className="eyebrow">TOOLS / PAID BY YOUR BALANCE</span>
          <h1>
            One balance
            <br />
            pays any tool.
          </h1>
          <p>Where a router has its paid tool market switched on, an Anyroute key can call any x402 tool priced in USDG on Robinhood Chain. The router pays the seller, charges the key the price plus its take and signs a receipt. Your rulebook decides which tools, how much per call and how much per day.</p>
        </div>
        <ToolsCatalog />
      </main>
    </PageFrame>
  );
}
