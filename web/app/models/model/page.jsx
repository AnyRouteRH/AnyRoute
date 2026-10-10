// E151
import PageFrame from "../../../components/PageFrame";
import ModelPage from "../../../components/ModelPage";
export const metadata = { title: "Model — Anyroute", description: "See a model’s abilities, prices, providers and live health on Anyroute." };
export default function Model() {
  return <PageFrame><main className="page-main" id="content"><div className="page-body catalog-body"><ModelPage /></div></main></PageFrame>;
}
