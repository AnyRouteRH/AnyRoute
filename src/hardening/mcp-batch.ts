import type { Context } from "hono";
export const MCP_BATCH_MAX = 20;
export const batchTooLarge = (c: Context) => c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `A JSON-RPC batch may contain at most ${MCP_BATCH_MAX} messages.` } }, 400);
export async function dispatchMcp(c: Context, msg: unknown, handle: (c: Context, msg: unknown) => Promise<Response>): Promise<Response> {
  if (!Array.isArray(msg) || !msg.length) return handle(c, msg);
  if (msg.length > MCP_BATCH_MAX) return batchTooLarge(c);
  const replies = [];
  // Sequential execution bounds concurrent tool calls and retains single-message auth and rulebook guards.
  for (const message of msg) {
    const response = await handle(c, message);
    if (response.status === 429 || response.status === 403 || response.status >= 500) return response;
    if (response.status !== 202) replies.push(await response.json());
  }
  return replies.length ? c.json(replies) : c.body(null, 202);
}
