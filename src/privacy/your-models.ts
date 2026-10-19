import type { ExternalDoc } from './types.ts';
export const yourModelsStores: ExternalDoc['otherStores'] = [{
  id: 'account-models-used', name: 'Your models catalogue response in memory',
  purpose: 'K192: GET /api/v1/account/models/used batches the signed-in catalogue filter with Activity account-or-own-key visibility, including team administrators, session restrictions and removed-key account stamps. No additional persistence or autonomous work.',
  holds: 'Current non-hidden catalogue model ids used in 30 rolling days; decimal-string recorded call and success counts, charges, refunds posted in the period, net spend sorted exactly, success percentage and nullable existing Ways to save alternative. The browser reuses account sign-in and Model watch controls. The URL keeps only filter=your-models, never account data. No new tables, columns, Redis keys, log fields, body or address readers. Ordinary inference reads request text in router memory.',
  ttl: 'No-store HTTP response. Personal results remain only in component memory and are cleared when the connected key changes, the filter is turned off or the catalogue is left. Signed-out visitors make no personal request and see the existing catalogue. Existing source retention unchanged.',
  requestText: 'none', evidence: [{ file: 'src/account/models-used.ts', contains: 'export async function readModelsUsed' }, { file: 'src/api/account-models-used.ts', contains: "c.header('cache-control', 'no-store')" }],
}];
