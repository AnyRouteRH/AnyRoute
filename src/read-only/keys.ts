// E149: owner visibility is projected only for authenticated reads; never stored.
import type { KeyRow } from '../api/auth.ts';
import { fail } from '../lib/errors.ts';

export const readScopeInput = ['inference', 'account', 'read'] as const;
export function readPrincipal(key: KeyRow): KeyRow {
  return key.scope === 'read' ? { ...key, management: true } : key;
}
export function readKeyFields(key: KeyRow) {
  return key.scope === 'read' ? { management: false } : {};
}
export function assertReadProvisioning(caller: KeyRow, spec: { scope?: string; management?: boolean; team?: string | null }) {
  if (caller.scope === 'read') fail(403, "Read-only keys cannot spend or change anything.", 'read_only_key');
  if (spec.scope === 'read' && (spec.management || spec.team)) fail(400, 'A read-only key has account read access; omit management and team.', 'invalid_request');
}
