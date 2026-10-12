// G165
import PageFrame from "../../../components/PageFrame";
import ModelCompare from "../../../components/ModelCompare";
export const metadata = { title: "Compare models — Anyroute", description: "Compare model abilities, token prices, context and provider uptime side by side." };
export default function CompareModels() {
  return <PageFrame><main className="page-main" id="content"><div className="page-body catalog-body"><ModelCompare /></div></main></PageFrame>;
}
