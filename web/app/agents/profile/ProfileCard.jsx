'use client';
import ProofBadge from '../../../components/ProofBadge';
import { PROFILE_SUMMARY, bpsPercent, livenessLine, profileLink, reputationLine, safeHomepage } from '../../../lib/agent-profiles';
export default function ProfileCard({ card, detail = false }) {
  const homepage = safeHomepage(card.homepage);
  const live = livenessLine(card.anyroute.liveness), reputation = reputationLine(card.anyroute.reputation);
  const identity = card.anyroute.identity, record = card.anyroute.track_record;
  return <article className="control-panel" style={{ overflowWrap: "anywhere" }}>
    <h2>{detail ? card.name : <a href={profileLink(card)}>{card.name}</a>}</h2><p>{card.description}</p>
    {(live || reputation) && <p data-live={live?.state}>{live && <strong>{live.text}</strong>}{live && reputation && <br/>}{reputation && <span>{reputation.text}</span>}</p>}
    <p>Capabilities supplied by the owner: {card.capabilities.join(', ') || 'None listed'}</p>
    {homepage && <p style={{ overflowWrap: "anywhere" }}>Owner’s homepage: {homepage}</p>}
    {card.payout_wallet && <p style={{ overflowWrap: "anywhere" }}>Wallet for payments, supplied by the owner (USDG on Robinhood Chain): {card.payout_wallet}</p>}
    <ul>{Object.entries(card.anyroute.rulebook_summary).map(([key, value]) => <li key={key}>{PROFILE_SUMMARY[key] || key}: {value ? 'Yes' : 'No'}</li>)}</ul>
    <ProofBadge evidence={{ source: "profile", data: card.anyroute }} explain /><p>Sealed hosting: {card.anyroute.status.sealed}.</p>
    <h3>Valid track-record certificates</h3><a href="/verify/#proof-certificates">How to check certificates →</a>
    {!card.anyroute.certificates.length && <p>No currently valid certificate published.</p>}
    {card.anyroute.certificates.map(c => <section key={c.payload.pseudonym}><p>{c.payload.claims.join(', ')}<br/>Expires: <time dateTime={c.payload.expires_at}>{c.payload.expires_at}</time></p><p>{c.payload.notice}</p>{detail && <details><summary>Signed certificate JSON</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify((({ valid, ...certificate }) => certificate)(c), null, 2)}</pre></details>}</section>)}
    {record && <section><h3>Receipt track record</h3><p>{record.stats.receipts} anchored receipts, ${record.stats.spend_usd} spent, refund rate {bpsPercent(record.stats.refund_rate_bps)}, dispute rate {bpsPercent(record.stats.dispute_rate_bps)}.<br/>Expires: <time dateTime={record.expires_at}>{record.expires_at}</time></p>{detail && <p><a href={record.url}>Signed record and its ERC-8004 validation entry</a></p>}</section>}
    {detail && identity && !identity.opted_out && <section><h3>Identity links</h3><ul>
      <li><a href={identity.card}>Card JSON</a></li>
      <li><a href={identity.receipt_keys}>Receipt keys</a> (current key {identity.receipt_key_id})</li>
      {identity.registration && <li><a href={identity.registration}>ERC-8004 registration file</a></li>}
      <li>ERC-8004 identity: {identity.erc8004.agent_id ? `agent ${identity.erc8004.agent_id} in ${identity.erc8004.registry}` : 'not registered'}</li>
    </ul></section>}
    {detail && card.anyroute.liveness?.receipt && <details><summary>Signed liveness probe receipt</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(card.anyroute.liveness.receipt, null, 2)}</pre></details>}
    <p className="help-text">{card.anyroute.notice}</p>
  </article>;
}
