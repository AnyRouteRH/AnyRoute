import type { Review, Verdict } from "../types.ts";

export const CREATED = "When the row was created.";
export const UPDATED = "When the row was last changed.";

/** Retention wording shared by tables the code never prunes. */
export const KEPT = "No automatic deletion: no job or route in the code removes rows from this table.";
export const KEPT_APPEND = "No automatic deletion, and rows are never changed after they are written.";

/** A reviewed justification for a column the rules flag: the flags it covers, the verdict and the reason. */
export const rv = (covers: string[], verdict: Verdict, why: string): Review => ({ covers: [...covers].sort(), verdict, why });

/** Shorthand for the most common review: a JSON column whose contents are fixed fields chosen by our code. */
export const JSON_FIELDS = (why: string): Review => rv(["type:json"], "no-request-content", why);
