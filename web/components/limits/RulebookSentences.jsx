// B124: one display for the saved rules; the existing editor stays behind Edit.
import { rulebookWords } from '../../lib/rulebook-words';
import { StopResume } from './SpendingLimits';
import st from './RulebookSentences.module.css';

export function RulebookSentences({ policy }) {
  return <ul className={st.sentences}>{rulebookWords(policy).map((text, index) => <li key={index}>{text}</li>)}</ul>;
}
export default function RulebookCard({ policy, inherited = [], stop, busy, children }) {
  return <div className={st.card}>
    <RulebookSentences policy={policy}/>{inherited.map((row, index) => <div key={row.key_hash ?? index}><h4>Inherited rules</h4><RulebookSentences policy={row.policy}/></div>)}
    <StopResume id="rulebook-summary" stop={stop} disabled={busy}/>
    <details className={st.editor}><summary>Edit</summary>{children}</details>
  </div>;
}
