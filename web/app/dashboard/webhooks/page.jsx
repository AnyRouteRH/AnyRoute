import PageFrame from '../../../components/PageFrame';
import Webhooks from '../../../components/account/Webhooks';
export const metadata = { title: 'Webhooks — AnyRoute', description: 'Inspect account event destinations and signing availability.' };
export default function Page() { return <PageFrame><main id="content" className="page-main"><div className="page-title"><h1>Webhooks</h1><p>Send account event notices to your HTTPS endpoint where signing is enabled.</p></div><Webhooks/></main></PageFrame>; }
