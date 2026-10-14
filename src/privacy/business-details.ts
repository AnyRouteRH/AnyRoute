import type { ExternalDoc, TableDoc } from "./types.ts";
export const businessDetailsReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/api/business-details.ts", carries: "settings",
  reads: "Optional user-entered business name (160 characters), multi-line postal address (1000), tax ID (120, free text) and reference (240, no email addresses). Unknown fields and control characters are rejected.",
  then: "With STATEMENTS_ENABLED, requires an active account management key to replace or clear the details, excluding sessions, team-only owner/admin keys and read-only keys. Other keys that can read statements can read this account's details; the existing read-only route guard still blocks the new settings route, so those keys use the opt-in statement response instead.",
  kept: "business-details:<account id> in the existing Postgres kv table stores the four fields in plain JSON with an update timestamp, until replaced or deleted. No inference text, new Redis key family, network address reader or log field is added.",
  evidence: [{ file: "src/api/business-details.ts", contains: "businessDetailsBody.parse(await readJson(c))" }],
};
export const businessDetailsStores: ExternalDoc["otherStores"] = [{
  id: "business-details", name: "User-entered statement business identity in kv",
  purpose: "Account management keys optionally save business identity for a Billed to block on statements. Anyroute can read these fields and does not verify them. They are outside the signed statement payload; changing them never changes what is signed.",
  holds: "business-details:<account id> holds business_name, multi-line address, tax_id and reference in kv.value, linked to the account id in kv.key, plus kv.updated_at. The router reads these optional settings in memory. Statement reads with business_details=true add them beside payload, alg, key_id and sig; default statement responses are unchanged. The browser uses these current fields, including for earlier months, for the unsigned Billed to block, CSV and print/PDF. Signed JSON downloads omit them. There is no billing email field; the reference rejects email addresses, but free-text business identity fields can contain personal information supplied by the owner.",
  ttl: "Kept until replaced or deleted, without automatic expiry. Delete in Settings > Statements sends PUT with an empty object and removes the kv row; it does not remove earlier backups or exports on the caller's device. Browser memory holds the form and loaded statement details until navigation; no new browser storage. No new table, column, Redis family or log field.",
  requestText: "none", evidence: [{ file: "src/statements/business-details.ts", contains: "`business-details:${accountId}`" }],
}];
export function describeBusinessDetails(docs: Record<string, TableDoc>) {
  docs.kv.notes?.push(businessDetailsStores[0].holds + " " + businessDetailsStores[0].ttl);
}
