import { agreementRulesSchema } from "../agreements/rulebook.ts";
import { z } from "zod";
import { agentBreakersSchema } from "./breakers.ts";
import { autonomySchema } from "./autonomy-schema.ts";
import { agentAlertsSchema } from "./alert-policy.ts";
import { canonicalJson, sha256 } from "../lib/util.ts";

const name = z.string().min(1).max(160);
const list = z.array(name).max(64);
const usd = z.number().positive().max(1_000_000);
const tokens = z.number().int().positive().max(10_000_000);
const names = z.strictObject({ allow: list.optional(), deny: list.optional() });
// v6 T: tools also carry a price dimension for paid x402 tools bought with the key's balance (src/tools). allow/deny
// still name declared and MCP tools; for a paid tool they match its resource, host, seller wallet or listing id.
const toolRules = names.extend({ max_price_per_call: usd.optional(), daily_budget: usd.optional(), pass_to_models: z.boolean().optional() });
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const agentPolicySchema = z.strictObject({
  version: z.literal(1),
  models: names,
  lanes: z.array(z.enum(["public", "attested", "unlinkable"])).max(64).optional(),
  caps: z.strictObject({ per_request_usd: usd.optional(), per_hour_usd: usd.optional(), per_day_usd: usd.optional(), per_week_usd: usd.optional(), max_output_tokens: tokens.optional() }),
  tools: toolRules.optional(),
  windows: z.array(z.strictObject({ days: z.array(z.number().int().min(0).max(6)).max(64), start: time, end: time })).max(64).optional(),
  // B: above_calls_per_hour asks first once the rolling hour already holds that many admitted model calls.
  approval: z.strictObject({ above_usd: usd, above_calls_per_hour: z.number().int().positive().max(1_000_000).optional() }),
  breakers: agentBreakersSchema.optional(),
  autonomy: autonomySchema.optional(),
  alerts: agentAlertsSchema.optional(),
  agreements: agreementRulesSchema.optional(),
  actions: z.strictObject({ allow: list.optional(), deny: list.optional(), targets: names.optional(), per_action_usd: usd.optional(), per_day_usd: usd.optional(), approval_above_usd: usd.optional(), max_per_hour: z.number().int().positive().max(100000).optional() }).optional(),
  on_breach: z.enum(["deny", "kill"]),
}).partial({ approval: true });
export type AgentPolicy = z.infer<typeof agentPolicySchema>;
export const canonicalAgentPolicy = (policy: AgentPolicy) => canonicalJson(agentPolicySchema.parse(policy));
export const agentPolicySha256 = (policy: AgentPolicy) => sha256(canonicalAgentPolicy(policy));
export { canonicalJson, sha256 };

const pico = z.union([z.bigint().nonnegative(), z.string().regex(/^\d+$/).transform(BigInt)]);
export const actionName = z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/).max(64);
export const actionIntentSchema = z.strictObject({ kind: z.literal("action"), action: actionName, target: z.string().min(1).max(160).optional(), amount_pico: pico, details_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional() });
export const agentIntentSchema = z.discriminatedUnion("kind", [
  actionIntentSchema,
  z.strictObject({ kind: z.literal("inference"), model: name, lane: z.enum(["public", "attested", "unlinkable"]), est_cost_pico: pico, max_output_tokens: tokens.optional(), tools: list }),
  z.strictObject({ kind: z.literal("mcp_tool"), name }),
  // v6 T: a paid x402 tool call. resource is origin + path (never the query); seller is the payTo wallet.
  z.strictObject({ kind: z.literal("paid_tool"), resource: z.string().url().max(2048), seller: z.string().regex(/^0x[0-9a-fA-F]{40}$/), listing: name.optional(), price_pico: pico }),
]);
export type AgentIntent = z.infer<typeof agentIntentSchema>;
export const intentJson = (intent: AgentIntent) => intent.kind === "inference" ? { ...intent, est_cost_pico: intent.est_cost_pico.toString() } : intent.kind === "paid_tool" ? { ...intent, price_pico: intent.price_pico.toString() } : intent.kind === "action" ? { ...intent, amount_pico: intent.amount_pico.toString() } : { ...intent };
