import { z } from "zod";
import { directoryQuery } from "../agents/profiles.ts";
export const directoryMcpArgs = { anyroute_agent_directory: z.strictObject({ tag: directoryQuery.shape.tag, cursor: directoryQuery.shape.cursor, limit: z.number().int().min(1).max(50).optional() }) };
export const directoryMcpTools = [{ name: "anyroute_agent_directory", title: "Find public agent profiles", description: "Read opt-in public profiles, optionally filtered by an exact capability tag. Owner-supplied tags are not verified abilities. Available when AGENT_PROFILES_ENABLED is on.", inputSchema: { type: "object", properties: { tag: { type: "string", minLength: 1, maxLength: 40 }, cursor: { type: "string", pattern: "^[A-Za-z0-9_-]{24}$" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } }];
export function directoryMcpPath(args: Record<string, unknown>) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) if (v !== undefined) query.set(k, String(v));
  return "/api/v1/agents/profiles?" + query;
}
