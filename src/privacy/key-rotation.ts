// G158
import type { ExternalDoc, TableDoc } from "./types.ts";
export const rotationReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/key-rotation/routes.ts", carries: "settings", reads: "One strict grace choice: 1h, 24h or 7d.",
  then: "Uses the existing key-edit owner/admin authentication, refuses restricted callers and agent sessions, checks the Credits deposited total directly on chain and account ownership and copies eligible account-backed keys in one transaction. Returns the new secret once with no-store; the router handles it in memory.",
  kept: "The old and new key hashes, rotation time, old-key grace deadline and original rulebook history link in key-rotation:<key hash> rows in kv. Key settings and saved rulebook revisions are copied to existing tables; new usage starts at zero. No secret is stored.",
  evidence: [{ file: "src/key-rotation/routes.ts", contains: "rotationBody.parse(await readJson(c))" }],
};
export const rotationStores: ExternalDoc["otherStores"] = [{
  id: "key-rotation", name: "Key replacement links",
  purpose: "Links retired and replacement account-backed keys while the existing expiry guard ends the old key's access. The account lock serializes rotation. Account-wide notification choices and linked Telegram chats continue on the same account.",
  holds: "key-rotation:<key hash> in kv stores from and to key hashes, at, grace_ends_at and history_key_hash. The replacement keeps the old key's settings, team membership and principal, current policy and saved policy_versions (including saved-by attribution and dates), agent approvers, quiet-alert hour choice and spend-alert rules including sealed webhook destinations. Usage, delivery history, existing agent approvals and spend records stay with the old key. Quiet-alert delivery state and spend-alert history restart for the replacement. The security-alerts event stores a sanitized Key rotated title and actor under its existing family, and uses the existing security_alerts notification type, preferences and quiet-hour delivery. Browser sign-ins, Telegram link credentials and attestation records are not cloned; there is no new address reader, Redis family or log field.",
  ttl: "Rotation links remain with key history until account data is removed. Copied settings use the existing tables' retention. The secret exists in router response memory and the browser's reveal state until dismissed; it is never persisted by the rotation interface.",
  requestText: "none", evidence: [{ file: "src/key-rotation/store.ts", contains: 'const rotationKey = (hash: string) => `key-rotation:${hash}`' }],
}];
export function describeKeyRotation(docs: Record<string, TableDoc>) {
  docs.kv.notes?.push(rotationStores[0].holds + " " + rotationStores[0].ttl);
}
