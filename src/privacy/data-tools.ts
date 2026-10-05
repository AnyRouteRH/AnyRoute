import type { ExternalDoc } from "./types.ts";

// B: the per-call market-data tools (src/data-tools) and decision tags in receipts (src/receipts/decision-tag.ts).
export const dataToolStores: ExternalDoc["otherStores"] = [
  {
    id: "data-tools-readings",
    name: "Market-data tool readings in memory",
    purpose: "When DATA_TOOLS_ENABLED is on, GET /api/v1/data/stock/:symbol and /actions read a Stock Token's Chainlink feed and its uiMultiplier, newUIMultiplier, effectiveAt, paused and oraclePaused views from Robinhood Chain; GET /api/v1/data/ipx/:class reuses the inference price index snapshot. A paid call is charged once, after the reading passed its checks: a prepaid key through the ordinary hold and ledger (kind data_tool), a keyless caller through the existing per-call payment, whose quote binds the method and path.",
    holds: "Public chain readings per token (feed answer, decimals, update time, multiplier values, pause flags) and the read time, and the public index snapshot per class and hour. Nothing about the caller is kept here; the charge is the existing ledger line and, for per-call payments, the existing quote row with the payer's wallet address. No request text: these are GET requests without a body.",
    ttl: "A token reading is reused for 15 seconds and an index snapshot for 60 seconds; both are lost when the router instance exits.",
    requestText: "none",
    evidence: [
      { file: "src/data-tools/stock.ts", contains: "const CACHE_MS = 15_000;" },
      { file: "src/data-tools/charge.ts", contains: "bodySha: sha256(`GET ${new URL(c.req.url).pathname}`)" },
      { file: "src/data-tools/charge.ts", contains: 'export const DATA_TOOL_KIND = "data_tool";' },
      { file: "src/data-tools/routes.ts", contains: "if (!hit || Date.now() - hit.at > 60_000)" },
    ],
  },
  {
    id: "decision-tags",
    name: "Decision tags in signed receipts",
    purpose: "When DECISION_TAGS_ENABLED is on, a chat or completion call may send X-Anyroute-Decision-Tag: a SHA-256 digest the caller computed, for example of an order intent. The router signs it into that call's v1 and v2 receipts as decision_tag, so the caller can later show which model answered before a decision. A malformed tag is refused before anything is charged, and the unlinkable lane refuses a tag because a reused tag joins calls together. An Agent Guard decision whose details_sha256 equals a tag names the same agent's tagged calls as informed_by; it reads the stored receipts and stores nothing new.",
    holds: "The 64-hex digest as sent, inside the generation's stored receipt and receipt_v2. Never the intent itself, which the router never receives.",
    ttl: "Kept with the generation record and its receipt, under their existing retention.",
    requestText: "hashes",
    evidence: [
      { file: "src/receipts/decision-tag.ts", contains: 'export const DECISION_TAG_HEADER = "x-anyroute-decision-tag";' },
      { file: "src/receipts/decision-tag.ts", contains: 'if (tag && lane === "unlinkable")' },
      { file: "src/api/chat.ts", contains: "...decisionTagFields(decisionTagOf(ctx.cfg.decisionTagsEnabled, p.c, p.disc.lane))" },
      { file: "src/agents/guard-links.ts", contains: "and g.receipt->>'decision_tag' = ${tag}" },
    ],
  },
];
