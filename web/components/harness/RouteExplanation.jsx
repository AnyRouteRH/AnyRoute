import { routeEvidence, routeSentence } from '../../lib/route-explanation.js';
import styles from './RouteExplanation.module.css';

// V84: hide unavailable evidence. No request, catalog or provider-label inference.
export default function RouteExplanation({ receipt, header }) {
  const route = routeEvidence(receipt, header);
  if (!route) return null;
  return <details className={styles.explanation}>
    <summary>Why this route?</summary>
    <p>{routeSentence(route)}</p>
    {receipt?.payload?.council && <p>This receipt describes the judge call. Each member call has its own receipt.</p>}
    <p className={styles.limit}>Recorded by the router. Check the receipt signature in the <a href="/verify/#v-receipt">receipt checker</a>; the Harness has not checked it.</p>
  </details>;
}
