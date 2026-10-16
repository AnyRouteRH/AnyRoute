import { chatCost, formatChatCost, savedChatCost } from "../../lib/chat-cost.js";
import s from "./ChatCost.module.css";
import { chatCharges, chargeLinks } from '../../lib/charge-links.js'; // J182
import { formatUsd } from '../../lib/arena.js';

export default function ChatCost({ lanes, chat }) {
  const label = formatChatCost(chat ? savedChatCost(chat) : chatCost(lanes));
  if (chat) return <span className={s.total}>This chat: {label}</span>; // J182: history renders this inside its Open chat button.
  const charges = chatCharges(chat?.lanes || lanes);
  return <div className={s.total}><span role={chat ? undefined : 'status'} aria-live={chat ? undefined : 'polite'} aria-atomic="true">This chat: {label}</span>
    {!!charges.length && <details><summary>View reply charges</summary><ul>{charges.map((row, index) => {
      const links = chargeLinks(row.receipt, row.model);
      const amount = row.cost == null ? 'Cost not saved' : formatUsd(Number(row.cost));
      return <li key={row.id}>Reply {index + 1}: {links.receipt ? <a href={links.receipt}>{amount} · Receipt</a> : <span>{amount} · No signed receipt recorded</span>}{links.model && <> · <a href={links.model}>View model</a></>}</li>;
    })}</ul><p>Older totals may include replies whose details were not saved.</p></details>}
  </div>;
}
