'use client';
import { useEffect, useRef, useState } from 'react';
import { HOSTS_PATH, hostPath, hostId, describeHost, operatorHeader } from '../../lib/hosts';
import s from './hosts.module.css';
const Chip = ({ tone, children }) => <span className={s.chip} data-tone={tone}>{children}</span>;
const When = ({ value }) => <time dateTime={value}>{value ? new Date(value).toLocaleString() : 'Not recorded'}</time>;

export function HostRecord({ host }) {
  const v = describeHost(host);
  return <article className={s.record}>
    <div className={s.head}><div><h2>{v.name}</h2><code>{v.id}</code></div><Chip tone={v.hardware.tone}>{v.hardware.label}</Chip></div>
    <p><Chip>{v.status}</Chip> {v.probation ? <>Probation until <When value={v.shadow_until}/>.</> : 'No active probation recorded.'} Hardware: {v.tee_kind || 'Not established'}.</p>
    <p>Last successful hardware check: <When value={v.attestation?.last_verified_at}/>. <a href={v.verifyHref}>Inspect verification and its limits →</a></p>
    <div className={s.grid}>
      <section><h3>Running an approved build</h3><Chip tone={v.build.tone}>{v.build.label}</Chip><p>{v.build.text}</p></section>
      <section><h3>Work anchored</h3><Chip tone={v.anchor.tone}>{v.anchor.label}</Chip><p>{v.anchoring?.roots || 0} roots recorded; {v.anchoring?.anchored_roots || 0} confirmed on chain.</p>{v.anchoring?.latest && <><p>{v.anchoring.latest.receipts} receipts in the latest root, covering <When value={v.anchoring.latest.from_ts}/> to <When value={v.anchoring.latest.to_ts}/>.</p><code className={s.digest}>{v.anchoring.latest.root}</code>{v.anchoring.latest.tx_hash && <p>Transaction: <code className={s.digest}>{v.anchoring.latest.tx_hash}</code></p>}</>}<p>A root covers signed host receipts collected by the router. Check a receipt’s inclusion at <code>/api/v1/host-anchors/proof/:leaf</code> when that proof endpoint is enabled.</p></section>
      <section><h3>Uptime</h3><p className={s.number}>{v.uptimeText}</p><p>Successful observed requests and probes across served models over 30 days. This is not continuous availability.</p></section>
      <section><h3>Invoice earnings</h3><p className={s.number}>{v.earningsText}</p><p>{v.earnings?.basis}</p>{v.operator && <dl><dt>Invoiced USDG units</dt><dd>{v.operator.invoiced_usdg_units}</dd><dt>Unpaid USDG units</dt><dd>{v.operator.unpaid_usdg_units}</dd><dt>Decimals</dt><dd>{v.operator.decimals}</dd><dt>Payout mode</dt><dd>{v.operator.payout_mode}</dd><dt>Payout address</dt><dd className={s.digest}>{v.operator.payout_address || 'Not configured'}</dd></dl>}</section>
    </div>
    <section><h3>Proof-time</h3><p>Time the router’s record shows a fresh hardware attestation held. Earlier time outside the record is unknown.</p>{v.windows.length ? v.windows.map(w => <div key={w.name} className={s.window}><strong>{w.label}{w.shareText && ` · ${w.shareText}`}</strong><p>{w.caption}</p></div>) : <p>No proof-time record available.</p>}</section>
    <section><h3>Models served</h3><ul>{(v.models || []).map(id => <li key={id}><code>{id}</code></li>)}</ul></section>
    <section><h3>Build measurements</h3>{v.measurements.length ? v.measurements.map((m, i) => <div className={s.measurement} key={i}><Chip>{m.current ? 'Current recorded measurement' : 'Superseded measurement'}</Chip><p>{m.status} · Last seen <When value={m.last_seen_at}/>{m.superseded_at && <> · Superseded <When value={m.superseded_at}/></>}</p><dl>{['image_digest', 'compose_hash', 'model_digest'].map(key => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd><code className={s.digest}>{m[key]}</code></dd></div>)}</dl>{m.rekorHref ? <a href={m.rekorHref} rel="noreferrer">Rekor entry →</a> : <p>No Rekor entry recorded.</p>}</div>) : <p>No measurements recorded.</p>}</section>
    <section><h3>Attestation history</h3>{v.events.length ? <ul className={s.events}>{v.events.map(e => <li key={e.id || `${e.at}-${e.kind}`}><When value={e.at}/> · {e.kind} · {e.ok ? 'Passed' : 'Failed'}{e.reason?.message && ` · ${e.reason.message}`}</li>)}</ul> : <p>No history available.</p>}{v.attestation_history && <a href={v.attestation_history.url}>Read the paged history →</a>}</section>
  </article>;
}

export default function Hosts() {
  const [id, setId] = useState('');
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading');
  const [message, setMessage] = useState('');
  const [signing, setSigning] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const update = () => setId(hostId(window.location.search, window.location.hash));
    update(); window.addEventListener('hashchange', update); window.addEventListener('popstate', update);
    return () => { window.removeEventListener('hashchange', update); window.removeEventListener('popstate', update); };
  }, []);
  useEffect(() => {
    const current = ++generation.current;
    const ac = new AbortController(); setData(null); setState('loading'); setMessage('');
    fetch(id ? hostPath(id) : HOSTS_PATH, { signal: ac.signal, headers: { accept: 'application/json' } }).then(async res => {
      if (!res.ok) throw new Error(res.status === 404 ? 'The host record is unavailable on this router.' : 'The router could not return its host record.');
      const json = await res.json(); if (generation.current === current) { setData(json.data); setState('ready'); }
    }).catch(e => { if (e.name !== 'AbortError' && generation.current === current) { setState('error'); setMessage(e.message); } });
    return () => { ++generation.current; ac.abort(); };
  }, [id]);
  const signIn = async () => {
    const current = generation.current; setSigning(true); setMessage('');
    try {
      if (!window.ethereum) throw new Error('Open this page with a wallet that supports signing messages.');
      const auth = await operatorHeader(window.ethereum, id);
      if (generation.current !== current) return;
      const res = await fetch(hostPath(id), { cache: 'no-store', headers: { accept: 'application/json', 'X-Wallet-Auth': auth } });
      if (!res.ok) throw new Error(res.status === 403 ? 'This wallet is not the host’s operator.' : 'The operator signature was not accepted. Sign again to retry.');
      const json = await res.json(); if (generation.current === current) setData(json.data);
    } catch (e) { if (generation.current === current) setMessage(e.message); }
    finally { setSigning(false); }
  };
  return <div className={s.stack}>
    {id && <a href="/hosts/">← All hosts</a>}
    {state === 'loading' && <p role="status">Reading host records…</p>}
    {message && <p role="alert" className={s.notice}>{message}</p>}
    {state === 'ready' && data && (id ? <><HostRecord host={data}/><button className={s.button} onClick={signIn} disabled={signing}>{signing ? 'Waiting for wallet…' : 'Operator: sign to view exact invoices'}</button><p>The wallet signs access to this host’s record. It authorizes no payment. Exact values and payout settings are visible only to the registered operator.</p></> : <div className={s.grid}>{data.length ? data.map(host => { const v = describeHost(host); return <a className={s.listCard} href={v.href} key={v.id}><h2>{v.name}</h2><Chip tone={v.hardware.tone}>{v.hardware.label}</Chip><p>{v.tee_kind} · {v.status}{v.probation && ' · Probation'}</p><p>{v.models.length} models · Inspect host →</p></a>; }) : <p>No hosts with a hardware verification record are listed.</p>}</div>)}
  </div>;
}
