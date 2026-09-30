/** Conservative prompt-token estimate used only for holds and context checks. */
export function estimatePromptTokens(body: Record<string, unknown>): number {
  const messages = Array.isArray(body.messages) ? (body.messages as any[]) : [];
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    if (typeof m?.content === "string") chars += m.content.length;
    else if (Array.isArray(m?.content))
      for (const p of m.content) {
        if (p?.type === "text") chars += String(p.text ?? "").length;
        else if (p?.type === "image_url") images++;
        else chars += JSON.stringify(p ?? "").length;
      }
    chars += 16;
    if (m?.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  if (typeof body.prompt === "string") chars += body.prompt.length;
  if (body.tools) chars += JSON.stringify(body.tools).length;
  if (body.response_format) chars += JSON.stringify(body.response_format).length;
  return Math.ceil(chars / 3) + images * 1_600 + 8;
}

