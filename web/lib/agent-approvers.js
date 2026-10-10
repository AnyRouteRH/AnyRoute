// E153
export const APPROVER_MODES = [['owners', 'Owners only'], ['owners_and_admins', 'Owners and admins'], ['specific_members', 'Specific members']];
export const approversPath = hash => `/api/v1/agents/${encodeURIComponent(hash)}/approvers`;
export function approversBody(mode, ids) {
  if (!APPROVER_MODES.some(([value]) => value === mode)) throw new Error('Choose who can approve.');
  return { mode, member_ids: mode === 'specific_members' ? [...new Set(ids)] : [] };
}
