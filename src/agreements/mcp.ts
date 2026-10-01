import type { Context } from "hono";
import { z } from "zod";
import { prepareSchema } from "./routes.ts";
const id = { type: "string", pattern: "^(0|[1-9][0-9]{0,77})[.](0|[1-9][0-9]?)$" };
export const agreementMcpTools = [
  { name: "anyroute_agreement_status", description: "Read an agreement's canonical state, party evidence and router-run jury statement. Only wallet-linked parties can read it.", inputSchema: { type: "object", properties: { id }, required: ["id"], additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "anyroute_agreement_evidence", description: "Upload evidence JSON or text as JSON to your agreement. Router stores encrypted content and its hash; both parties and the router-run jury can read it. The evidence window and size cap apply.", inputSchema: { type: "object", properties: { id, evidence: {} }, required: ["id", "evidence"], additionalProperties: false }, annotations: { readOnlyHint: false, openWorldHint: false } },
  { name: "anyroute_agreement_prepare", description: "Check inherited rulebooks and prepare USDG agreement calldata. Returns calldata for the payer to sign. Reserves no funds and sends no transaction.", inputSchema: { type: "object", properties: { payee: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, milestone_amounts_usdg_units: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", pattern: "^[1-9][0-9]{0,77}$" } }, terms_hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, deadline: { type: "string", pattern: "^[1-9][0-9]{0,77}$" } }, required: ["payee", "milestone_amounts_usdg_units", "terms_hash", "deadline"], additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
];
export const agreementMcpArgs = {
  anyroute_agreement_status: z.strictObject({ id: z.string().regex(/^(0|[1-9]\d{0,77})\.(0|[1-9]\d?)$/) }),
  anyroute_agreement_evidence: z.strictObject({ id: z.string().regex(/^(0|[1-9]\d{0,77})\.(0|[1-9]\d?)$/), evidence: z.unknown().refine(v => v !== undefined) }),
  anyroute_agreement_prepare: prepareSchema,
};
export async function callAgreementMcp(name: string, args: unknown, c: Context, internal: (path: string, init?: RequestInit, c?: Context) => Promise<Record<string, unknown>>) {
  const a = args as { id: string; evidence?: unknown };
  const path = name === "anyroute_agreement_prepare" ? "/api/v1/agreements/prepare" : `/api/v1/agreements/${a.id}${name === "anyroute_agreement_evidence" ? "/evidence" : ""}`;
  return (await internal(path, { method: name === "anyroute_agreement_status" ? "GET" : "POST", signal: c.req.raw.signal, headers: { authorization: c.req.header("authorization") ?? "", "content-type": "application/json" }, ...(name === "anyroute_agreement_status" ? {} : { body: JSON.stringify(name === "anyroute_agreement_evidence" ? a.evidence : args) }) }, c)).data as Record<string, unknown>;
}
