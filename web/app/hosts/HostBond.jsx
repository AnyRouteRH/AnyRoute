import { describeBond } from '../../lib/host-bonds';
export default function HostBond({ bond }) {
  const b = describeBond(bond);
  if (!b) return null;
  return <section><h3>Work deposit</h3><p><strong>{b.amount}</strong> held by HostBond · {b.active} active.</p>
    <p>A public on-chain work deposit. Routing priority uses eligible active bonds only while the chain index is current. Hardware and lane checks still apply.</p>
    {!b.matched_operator && <p>The on-chain operator does not match this host’s registered wallet, or no bond is recorded for this host id.</p>}
    <p>{b.fresh ? `Index current through block ${b.indexed_block}.` : 'The bond index is catching up or its last completed scan is stale. No routing boost is applied.'}</p>
    {b.queued ? <p>Unbonding: {b.queued}, withdrawable from <time dateTime={b.unbonding.available_at}>{b.unbonding.available_at}</time>, subject to pending slashes.</p> : <p>No unbond request recorded.</p>}
    {b.delisted && <p>HostBond records this host as delisted.</p>}
    <h4>Slash history</h4>{b.slashes.length ? <ul>{b.slashes.map(s => <li key={s.id}>Slash {s.id} · {s.status} · {s.amount}{s.dispute_hash && ' · Disputed'}<ul>{s.transactions.map((t, i) => <li key={`${t.hash}-${i}`}><a href={t.href} rel="noreferrer">{t.event} transaction →</a></li>)}</ul></li>)}</ul> : <p>No slash events recorded.</p>}
    <p>Proposals require independent owner approval and a 72-hour dispute window. The automated worker does not execute disputed proposals.</p>
  </section>;
}
