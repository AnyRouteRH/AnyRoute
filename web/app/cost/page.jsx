import PageFrame from '../../components/PageFrame';
import CostEstimator from '../../components/CostEstimator';

export const metadata = { title: 'Estimate model costs — Anyroute', description: 'Compare input, output, per-request and monthly costs using the live model catalogue. Estimate tokens in your browser before signing in.' };
export default function CostPage() {
  return <PageFrame><main className="page-main" id="content">
    <div className="page-title"><span className="eyebrow">MODEL COSTS / LIVE CATALOGUE</span><h1>What will it cost?</h1><p>Estimate a request, compare models and plan a month of use. No sign-in needed.</p></div>
    <div className="page-body catalog-body"><CostEstimator /></div>
  </main></PageFrame>;
}
