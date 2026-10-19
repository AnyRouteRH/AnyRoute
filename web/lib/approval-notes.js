// K186: drafts live only in page memory, keyed by the existing authenticated request function.
const drafts = new WeakMap();
export function setApprovalNote(request, id, value) {
  let notes = drafts.get(request);
  if (!notes) { notes = new Map(); drafts.set(request, notes); }
  if (value) notes.set(id, value); else notes.delete(id);
}
export function approvalNoteBody(request, id) {
  const value = drafts.get(request)?.get(id);
  if (!value?.trim()) return {};
  if (Array.from(value).length > 280 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error('Use plain text up to 280 characters for the decision note.');
  return { decision_note: value.trim() };
}

export const approvalDecisionText = value => ({ approval_requested: 'Approval requested', approval_approved: 'Approved', approval_denied: 'Denied', approval_used: 'Approval used', approval_note_added: 'Decision note added' }[value]);
