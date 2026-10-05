import { PROOF_STATES } from '../lib/proof-badge.js';
import s from './Verify.module.css';
import badgeStyles from './ProofBadge.module.css';
const checks = {
  hardware: ['Compare the provider id below with the receipt. Read the current quote checks and their gaps; a receipt records the check at the time of that call.', '#provider-id', 'Look up hardware evidence'],
  encrypted: ['Use the device-encryption gateway setup. Check the receipt’s end_to_end_encrypted and e2ee fields; a model’s Encrypted chat capability alone does not show this path was used.', '/docs/#e2ee-phala', 'Check the encrypted-chat setup'],
  unlinkable: ['Use Tor onion access and blind tokens. Check the receipt’s unlinkable lane and blind-payment fields. Timing and purchase size can still suggest links.', '/docs/#private', 'Check the transport and payment requirements'],
  standard: ['Inspect the receipt and provider record below. A lane name, a private switch or an owner’s description cannot replace hardware evidence.', '#provider-id', 'Look up the provider record'],
  cached: ['Inspect the receipt’s mode and provider fields for cache. A stored answer does not prove that hardware ran for this call.', '#receipt-id', 'Read the receipt record'],
  signed: ['Retrieve the receipt JSON and paste it into the browser checker below. A recorded signature or receipt id does not establish validity; check the key and anchoring limits too.', '#v-receipt', 'Open the signature checker'],
};
export default function ProofGuide() {
  return <div className={`${s.stack} ${badgeStyles.guide}`}>{Object.entries(PROOF_STATES).map(([key, state]) => <section key={key} id={`proof-${key}`} className={s.section} tabIndex={-1}>
    <h2>{state.label}</h2><p className={s.lead}>{state.explanation}</p><p>{checks[key][0]} <a href={checks[key][1]}>{checks[key][2]} →</a></p>
  </section>)}<section id="proof-certificates" className={s.section}><h2>Track-record certificates</h2><p>These are router-signed records of an agent’s history through Anyroute, with a fresh pseudonym and a seven-day lifetime. They do not prove current hardware, answer quality or activity outside Anyroute. Inspect the signed certificate JSON and expiry on the profile. The receipt checker below checks receipts, not track-record certificates.</p><a href="/docs/#agent-autonomy">Read the certificate format and limits →</a></section></div>;
}
