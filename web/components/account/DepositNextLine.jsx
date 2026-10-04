import { depositNextText } from '../../lib/deposit-progress.js';
export default function DepositNextLine({ info, lane = 'escrow' }) {
  return <p className="help-text">{depositNextText(info, lane)}{lane === 'escrow' && info?.fast_credit?.enabled && ' Early credit depends on confirmations, a current rate and room under the account and shared caps. Per-deposit limits still apply.'}</p>;
}
