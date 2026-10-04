export { guardMcpArgs, guardMcpTools, callGuardMcp } from "./mcp-guard.ts"; // V98
import type { Context } from "hono";
import { z } from "zod";
import { ApiError } from "../lib/errors.ts";
import { usdToPico } from "../lib/money.ts";

const guidance = "Check before expensive calls. Never retry a denied call unchanged.";
export const agentMcpTools = [
  { name: "anyroute_agent_rules", title: "Read my agent rulebook", description: `Read the calling key's rulebook, inherited rules, remaining rolling hour/day/week caps in USD and killed state. Needs an API key and enabled agent policies. ${guidance}`, inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "anyroute_agent_check", title: "Check an inference intent", description: `Dry-run an inference intent without sending a prompt or recording a decision. Supply an estimated cost in pico USD (10^12 per USD), or estimated input and output token counts priced from the current model catalog. Returns the router's decision and reasons verbatim. Estimates do not reserve budget or guarantee a later call. Needs an API key and enabled agent policies. ${guidance}`, inputSchema: { type: "object", properties: { model: { type: "string", minLength: 1, maxLength: 160 }, lane: { type: "string", enum: ["public", "attested", "unlinkable"] }, est_cost_pico: { type: "string", pattern: "^[0-9]+$" }, est_input_tokens: { type: "integer", minimum: 0, maximum: 10000000 }, max_output_tokens: { type: "integer", minimum: 1, maximum: 10000000 }, tools: { type: "array", items: { type: "string", minLength: 1, maxLength: 160 }, maxItems: 64 } }, required: ["model", "lane"], anyOf: [{ required: ["est_cost_pico"] }, { required: ["est_input_tokens", "max_output_tokens"] }], additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
];
export const agentMcpArgs = {
  anyroute_agent_rules: z.strictObject({}),
  anyroute_agent_check: z.strictObject({ model: z.string().min(1).max(160), lane: z.enum(["public", "attested", "unlinkable"]), est_cost_pico: z.string().regex(/^\d+$/).optional(), est_input_tokens: z.number().int().min(0).max(10_000_000).optional(), max_output_tokens: z.number().int().positive().max(10_000_000).optional(), tools: z.array(z.string().min(1).max(160)).max(64).default([]) }).refine(a => a.est_cost_pico !== undefined || (a.est_input_tokens !== undefined && a.max_output_tokens !== undefined), { message: "provide est_cost_pico or both est_input_tokens and max_output_tokens" }),
};
type Internal = (path: string, init?: RequestInit, c?: Context) => Promise<Record<string, unknown>>;
export async function callAgentMcp(name: string, args: unknown, c: Context, internal: Internal) {
  const headers = { authorization: c.req.header("authorization")!, "content-type": "application/json" };
  if (name === "anyroute_agent_rules") return (await internal("/api/v1/agents/me", { headers, signal: c.req.raw.signal }, c)).data as Record<string, unknown>;
  const a = args as z.infer<typeof agentMcpArgs.anyroute_agent_check>;
  let cost = a.est_cost_pico;
  if (cost === undefined) {
    const catalog = await internal("/api/v1/models", { headers, signal: c.req.raw.signal }, c);
    const model = (catalog.data as { id: string; pricing: { prompt: string; completion: string } }[]).find(m => m.id === a.model);
    if (!model) throw new ApiError(400, "Model not found in the current catalog; supply est_cost_pico explicitly.", "invalid_request");
    cost = (usdToPico(model.pricing.prompt) * BigInt(a.est_input_tokens!) + usdToPico(model.pricing.completion) * BigInt(a.max_output_tokens!)).toString();
  }
  return (await internal("/api/v1/agents/check", { method: "POST", headers, signal: c.req.raw.signal, body: JSON.stringify({ kind: "inference", model: a.model, lane: a.lane, est_cost_pico: cost, ...(a.max_output_tokens !== undefined ? { max_output_tokens: a.max_output_tokens } : {}), tools: a.tools }) }, c)).data as Record<string, unknown>;
}
