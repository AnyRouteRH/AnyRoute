import type { TableDoc } from "./types.ts";
// C134: no additional body/address reader, Redis family or log field.
export function describeProjects(tables: Record<string, TableDoc>) {
  tables.keys.columns.project = "Owner-chosen default project label, lowercased, 1–48 letters, digits, dots, underscores or hyphens. PATCH replaces or clears it. Not a secret; retained with the key even after disabling.";
  tables.generations.columns.project = "Owner-chosen project label from X-Anyroute-Project or the key default, captured for this call. Null when absent. Retained with the call; not included in the signed receipt. Anyroute can read it. Activity JSON/CSV and Insights return labels and use them to filter within existing account/key permissions. A project-filtered Activity feed includes calls only; generation-linked refunds in Insights follow the original call label, unlinked refunds have no project. Labels can encode sensitive details; use non-sensitive names. No request text is read to derive the label. The unlinkable lane refuses project tags to preserve separation between calls. Statements are unchanged.";
}
