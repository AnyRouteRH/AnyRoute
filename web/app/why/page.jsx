import PageFrame from '../../components/PageFrame';
import Why from './Why';
export const metadata = { title: 'Why was this request refused? — Anyroute', description: 'Understand the rule that refused a request and find where to change it.', robots: { index: false, follow: false } };
export default function WhyPage() {
  return <PageFrame><main id="content" className="page-main"><div className="page-title"><span className="eyebrow">REQUEST RULES</span><h1>Why was this request refused?</h1><p>Read the reason and find the rule to review.</p></div><Why/></main></PageFrame>;
}
