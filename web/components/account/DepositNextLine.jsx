import { depositNextText } from '../../lib/deposit-progress.js';
export default function DepositNextLine({ info }) {
  return <p className="help-text">{depositNextText(info)}{info?.fast_credit?.enabled && ' Early credit depends on confirmations, a current rate and room under the account and shared caps. Per-deposit limits still apply.'}</p>;
}
