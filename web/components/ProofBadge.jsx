"use client";
import { proofBadges } from '../lib/proof-badge.js';
import s from './ProofBadge.module.css';

function Icon({ name }) {
  const paths = { shield: 'M8 1.5 13 3.5v4c0 3-2 5.5-5 7-3-1.5-5-4-5-7v-4ZM5 8l2 2 4-4', lock: 'M4 7V5a4 4 0 0 1 8 0v2M3 7h10v7H3Zm5 3v2', route: 'M2 3h8l3 3-3 3M14 13H6l-3-3 3-3', provider: 'M2 3h12v4H2Zm0 6h12v4H2ZM4 5h1m-1 6h1', signature: 'm3 10 7-7 3 3-7 7H3Zm6-6 3 3M2 15h12' };
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d={paths[name]} /></svg>;
}

// Use linked=false only inside another interactive control; its explanation stays accessible.
export default function ProofBadge({ evidence, now, dark = false, linked = true, explain = false }) {
  return <span className={s.group} data-dark={dark || undefined}>
    {proofBadges(evidence, now).map(mark => <span className={s.item} key={mark.key}>
      {linked && !explain
        // Tap or click shows the explanation; a hover-only title can't be read on touch screens.
        ? <details className={s.pop}><summary className={s.badge} data-tone={mark.tone} title={`${mark.explanation} ${mark.context}`}><Icon name={mark.icon} />{mark.label}</summary><span className={s.popover} role="note">{mark.explanation} {mark.context}</span></details>
        : <span className={s.badge} data-tone={mark.tone} title={`${mark.explanation} ${mark.context}`}><Icon name={mark.icon} />{mark.label}</span>}
      {explain ? <span className={s.explanation}>{mark.explanation} {mark.context}</span> : !linked && <span className="sr-only">{mark.explanation} {mark.context}</span>}
      {linked && <a className={s.check} href={mark.href} aria-label={`How to check: ${mark.label}`} onClick={event => event.stopPropagation()}>How to check</a>}
    </span>)}
  </span>;
}
