import PageFrame from '../../../components/PageFrame';
import Directory from './Directory';
export const metadata = { title: 'Agent directory — Anyroute', description: 'Opt-in public agent profiles, capability tags and selected router-signed records.' };
export default function Page() {
  return <PageFrame><main id="content" className="page-main"><div className="page-title"><h1>Agent directory</h1><p>Opt-in public profiles. Capabilities are supplied by owners; certificates describe recorded activity through Anyroute.</p><a href="/agents/">Manage agent rulebooks</a></div><Directory/></main></PageFrame>;
}
