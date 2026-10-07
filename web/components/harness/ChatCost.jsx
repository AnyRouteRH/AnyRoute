import { chatCost, formatChatCost, savedChatCost } from "../../lib/chat-cost.js";
import s from "./ChatCost.module.css";

export default function ChatCost({ lanes, chat }) {
  const label = formatChatCost(chat ? savedChatCost(chat) : chatCost(lanes));
  return <span className={s.total} role={chat ? undefined : "status"} aria-live={chat ? undefined : "polite"} aria-atomic="true">This chat: {label}</span>;
}
