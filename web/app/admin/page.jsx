import PageFrame from "../../components/PageFrame";
import RushAdmin from "./RushAdmin";

export const metadata = { title: "Service operations — Anyroute", description: "Operator access to upstream balances and daily account counts." };
export default function AdminPage() {
  return <PageFrame><main className="page-main" id="content"><div className="page-title"><span className="eyebrow">OPERATIONS</span><h1>Prepare for demand.</h1><p>Inspect upstream balances and daily account counts with the service operator token.</p></div><RushAdmin /></main></PageFrame>;
}
