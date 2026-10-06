import { suggestedModels } from '../../lib/model-alternatives.js';
import s from '../Harness.module.css';
import styles from './ModelAlternatives.module.css';

// B121: native buttons use the existing reply styles and wrap on narrow screens.
export default function ModelAlternatives({ model, suggestions, onRetry, disabled }) {
  const choices = suggestedModels(suggestions);
  if (!choices.length) return null;
  return <div className={`${s.replyError} ${styles.choices}`} role="status">
    {choices.map(choice => <div key={choice.id}>
      <p>{model} isn’t available right now. Try {choice.name} instead.</p>
      <p className={s.note}>{choice.why}</p>
      <button type="button" className="text-button" disabled={disabled} onClick={() => onRetry(choice.id)}>Try {choice.name}</button>
    </div>)}
  </div>;
}
