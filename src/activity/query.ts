import { z } from "zod";
import { fail } from "../lib/errors.ts";
import { sha256 } from "../lib/util.ts";
export const ACTIVITY_KINDS = ["call", "approval", "alert", "deposit", "agreement", "policy", "balance"] as const;
const instant = z.string().datetime({ offset: true }).refine(v => !/\.\d{7}/.test(v), "Use at most six fractional digits.");
const micros = (v: string) => BigInt(Date.parse(v)) * 1000n + BigInt((v.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0").slice(3, 6));
const cursorShape = z.strictObject({ at: instant, id: z.string().min(1).max(512), filter: z.string().length(64) });
export function activityQuery(q: Record<string, string>) {
  const from = q.from === undefined ? undefined : instant.parse(q.from);
  const to = q.to === undefined ? undefined : instant.parse(q.to);
  if (from && to && micros(from) >= micros(to)) fail(400, "from must be before to.", "invalid_request");
  let cursor: z.infer<typeof cursorShape> | undefined;
  if (q.cursor !== undefined) try {
    if (q.cursor.length > 1500 || !/^[\w-]+$/.test(q.cursor)) throw new Error();
    cursor = cursorShape.parse(JSON.parse(Buffer.from(q.cursor, "base64url").toString()));
  } catch { fail(400, "Invalid activity cursor.", "invalid_request"); }
  return { from, to, cursor, kind: q.kind === undefined ? undefined : z.enum(ACTIVITY_KINDS).parse(q.kind),
    key: q.key === undefined ? undefined : z.string().regex(/^[a-f0-9]{64}$/).parse(q.key),
    model: q.model === undefined ? undefined : z.string().min(1).max(256).parse(q.model),
    limit: z.coerce.number().int().min(1).max(100).parse(q.limit ?? 50), format: z.enum(["json", "csv"]).parse(q.format ?? "json") };
}
export type ActivityQuery = ReturnType<typeof activityQuery>;
export const activityFingerprint = (q: ActivityQuery, scope: object) => sha256(JSON.stringify({ scope, kind: q.kind, key: q.key, model: q.model, from: q.from, to: q.to }));
