// C128: sum the dollar amounts shown on reply footers, without floating-point addition.
import { formatUsd } from "./arena.js";
import { replyFacts } from "./harness.js";

export function validChatCost(value) {
  return !!value && typeof value.microUsd === "string" && /^(0|[1-9]\d{0,39})$/.test(value.microUsd)
    && Number.isSafeInteger(value.replies) && value.replies >= 0;
}

export function replyCostUnits(message) {
  if (message?.status === "error") return 0n;
  const cost = replyFacts(message).cost;
  if (!Number.isFinite(cost) || cost <= 0) return 0n;
  const shown = formatUsd(cost).slice(1);
  // The existing footer uses four or six decimal places for ordinary dollar amounts.
  // toFixed uses exponent notation at 1e21; that is not a usable reply amount.
  if (!/^\d+(\.\d{1,6})?$/.test(shown)) return 0n;
  const [whole, fraction = ""] = shown.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function chatCost(lanes = []) {
  let microUsd = 0n, replies = 0;
  const seen = new Set(), remainders = new Set();
  for (const lane of lanes) {
    // Reopened history can omit failed, tool-only or textless replies. Their totals
    // survive as an aggregate, shared by the restored lanes and counted once.
    const remainder = lane.chatCostRemainder;
    if (validChatCost(remainder) && !remainders.has(remainder.id)) {
      remainders.add(remainder.id);
      microUsd += BigInt(remainder.microUsd);
      replies += remainder.replies;
    }
    for (const message of lane.messages || []) {
      if (message.role !== "assistant") continue;
      // Adding a comparison lane copies old messages; it did not buy those replies again.
      if (message.id && seen.has(message.id)) continue;
      if (message.id) seen.add(message.id);
      microUsd += replyCostUnits(message);
      replies++;
    }
  }
  return { microUsd: String(microUsd), replies };
}

export function savedChatCost(chat) {
  return validChatCost(chat?.costSummary) ? chat.costSummary : chatCost(chat?.lanes);
}

export function restoreChatCost(chat, lanes) {
  const total = savedChatCost(chat), retained = chatCost(lanes);
  const units = BigInt(total.microUsd) - BigInt(retained.microUsd);
  const replies = total.replies - retained.replies;
  if (units < 0n || replies < 0) return lanes;
  return lanes.map(lane => ({ ...lane, chatCostRemainder: { id: chat.id, microUsd: String(units), replies } }));
}

export function formatChatCost(total) {
  if (!validChatCost(total)) return "$0 · 0 replies";
  const units = BigInt(total.microUsd);
  const fraction = String(units % 1_000_000n).padStart(6, "0");
  const digits = units >= 10_000n && units % 100n === 0n ? 4 : 6;
  const dollars = units === 0n ? "$0" : `$${units / 1_000_000n}.${fraction.slice(0, digits)}`;
  return `${dollars} · ${total.replies} ${total.replies === 1 ? "reply" : "replies"}`;
}

// Optional import/export metadata is allowlisted; older exports stay byte-compatible.
export function costSummaryFields(chat) {
  if (chat.costSummary === undefined) return {};
  if (!validChatCost(chat.costSummary)) throw new Error("Choose a history export with a valid chat cost.");
  return { costSummary: { microUsd: chat.costSummary.microUsd, replies: chat.costSummary.replies } };
}
