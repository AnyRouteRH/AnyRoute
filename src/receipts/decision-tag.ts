import type { Context } from "hono";
import { z } from "zod";
import { fail } from "../lib/errors.ts";

// B: decision tags. A caller sends `X-Anyroute-Decision-Tag: sha256:<64 hex>`, for example the SHA-256 of the order intent
// its agent is about to act on, and the router signs that digest into the call's v1 and v2 receipts as `decision_tag`. The
// owner can later show which model answered what before a decision: the receipt binds the digest to the model, provider,
// request hash and response hash. The router only ever sees the digest the caller chose, never the intent behind it.
// Off unless DECISION_TAGS_ENABLED: the header is then ignored and nothing is recorded.

export const DECISION_TAG_HEADER = "x-anyroute-decision-tag";

export const decisionTagEnv = {
  DECISION_TAGS_ENABLED: z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase()))).default(false),
};

/** `sha256:<64 lowercase hex>`, or null when the header is absent. A malformed tag is a 400, never silently dropped. */
export function parseDecisionTag(value: string | undefined): string | null {
  if (value === undefined) return null;
  const m = /^(?:sha256:)?([0-9a-fA-F]{64})$/.exec(value.trim());
  if (!m) fail(400, "X-Anyroute-Decision-Tag must be sha256:<64 hex characters>: the SHA-256 of your decision or order intent.", "invalid_decision_tag");
  return `sha256:${m[1].toLowerCase()}`;
}

/** This request's tag, or null when tags are off or none was sent. Checked before anything is priced or spent. */
export function decisionTagOf(enabled: boolean, c: Context, lane: string): string | null {
  if (!enabled) return null;
  const tag = parseDecisionTag(c.req.header(DECISION_TAG_HEADER));
  // A tag the caller reuses joins calls together, which is exactly what the unlinkable lane exists to prevent.
  if (tag && lane === "unlinkable") fail(400, "A decision tag links calls to each other, so the unlinkable lane does not accept one.", "decision_tag_unlinkable");
  return tag;
}

/** The signed receipt field: omitted entirely when there is no tag, so untagged receipts are unchanged. */
export const decisionTagFields = (tag: string | null): { decision_tag?: string } => (tag ? { decision_tag: tag } : {});

/** A tag a verifier is asked to compare: `sha256:<64 hex>` or the bare hex, any case. */
export const expectedDecisionTag = z.string().trim().regex(/^(?:sha256:)?[0-9a-fA-F]{64}$/, "decision_tag must be sha256:<64 hex characters>").transform((v) => `sha256:${v.replace(/^sha256:/, "").toLowerCase()}`);

/**
 * What a receipt verification reports about a decision tag: the tag the receipt's signed contents carry (null when it has
 * none) and, when the caller supplied the tag it expects (the SHA-256 of its order, computed on its side), whether the two
 * are the same. Only digests are compared; the order itself is never sent.
 */
export function decisionTagCheck(signed: unknown, expected: string | undefined) {
  const tag = typeof signed === "string" && /^sha256:[0-9a-f]{64}$/.test(signed) ? signed : null;
  return { decision_tag: tag, decision_tag_valid: expected === undefined ? null : tag === expected };
}
