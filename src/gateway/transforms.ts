import { estimatePromptTokens } from "../router/pricing.ts";

// `transforms: ["middle-out"]`: when a prompt would not fit the model's context, drop messages
// from the middle of the conversation (keeping the system prompt(s) and the most recent turns),
// then truncate the middle of any single oversized message.

export function middleOut(body: Record<string, unknown>, contextTokens: number, reserveOutput: number) {
  const budget = Math.max(256, contextTokens - reserveOutput);
  if (!Array.isArray(body.messages)) return { removed: 0, truncated: 0 };
  let messages = [...(body.messages as any[])];
  let removed = 0;
  let truncated = 0;
  const fits = () => estimatePromptTokens({ ...body, messages }) <= budget;
  while (!fits()) {
    const removable = messages.map((m, i) => ({ m, i })).filter(({ m, i }) => m?.role !== "system" && i < messages.length - 1);
    if (!removable.length) break;
    const target = removable[Math.floor(removable.length / 2)].i;
    // Keep tool call/result pairs intact: drop a tool result together with its call.
    const next = messages[target + 1];
    const span = messages[target]?.tool_calls && next?.role === "tool" && target + 1 < messages.length - 1 ? 2 : 1;
    messages.splice(target, span);
    removed += span;
  }
  if (!fits()) {
    messages = messages.map((m) => {
      if (typeof m?.content !== "string") return m;
      const maxChars = Math.max(200, Math.floor((budget * 3) / Math.max(1, messages.length)));
      if (m.content.length <= maxChars) return m;
      truncated++;
      const half = Math.floor(maxChars / 2);
      return { ...m, content: m.content.slice(0, half) + "\n…[middle-out truncated]…\n" + m.content.slice(-half) };
    });
  }
  body.messages = messages;
  return { removed, truncated };
}
