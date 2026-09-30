import YourHost from './YourHost';
import PageFrame from '../../components/PageFrame';
import Hosts from './Hosts';
import s from './hosts.module.css';
export const metadata = { title: 'Hosts — Anyroute', description: 'Hardware checks, build measurements, anchored work and observed uptime for attested hosts.' };
export default function HostsPage() {
  return <PageFrame><main id="content" className={s.main}><span className="eyebrow">PUBLIC HOST RECORD</span><h1>Evidence of real work.</h1><p className={s.lead}>Inspect the hardware checks, recorded builds and work roots for each host. Every claim below points to the router’s record.</p><YourHost/><Hosts/><p className={s.limit}>On every lane today, AnyRoute’s router reads request text in memory to route it, and the provider that answers reads it too. Hardware attestation does not establish what software does with a prompt. Time between checks is not continuously verified.</p></main></PageFrame>;
}
