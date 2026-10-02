'use client';
import ProofBadge from '../../../components/ProofBadge';
import { PROFILE_SUMMARY, profileLink, safeHomepage } from '../../../lib/agent-profiles';
export default function ProfileCard({ card, detail = false }) {
  const homepage = safeHomepage(card.homepage);
  return <article className="control-panel">
    <h2>{detail ? card.name : <a href={profileLink(card)}>{card.name}</a>}</h2><p>{card.description}</p>
    <p>Capabilities supplied by the owner: {card.capabilities.join(', ') || 'None listed'}</p>
    {homepage && <p><a href={homepage} rel="noopener noreferrer">Owner’s homepage</a></p>}
    <ul>{Object.entries(card.anyroute.rulebook_summary).map(([key, value]) => <li key={key}>{PROFILE_SUMMARY[key] || key}: {value ? 'Yes' : 'No'}</li>)}</ul>
    <ProofBadge evidence={{ source: "profile", data: card.anyroute }} explain /><p>Sealed hosting: {card.anyroute.status.sealed}.</p>
    <h3>Valid track-record certificates</h3><a href="/verify/#proof-certificates">How to check certificates →</a>
    {!card.anyroute.certificates.length && <p>No currently valid certificate published.</p>}
    {card.anyroute.certificates.map(c => <section key={c.payload.pseudonym}><p>{c.payload.claims.join(', ')}<br/>Expires: <time dateTime={c.payload.expires_at}>{c.payload.expires_at}</time></p><p>{c.payload.notice}</p>{detail && <details><summary>Signed certificate JSON</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify((({ valid, ...certificate }) => certificate)(c), null, 2)}</pre></details>}</section>)}
    <p className="help-text">{card.anyroute.notice}</p>
  </article>;
}
