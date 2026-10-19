// K194
export const approvalHourPath = id => '/api/v1/agents/approvals/' + encodeURIComponent(id) + '/approve-hour';
export const approvalWindowsPath = hash => '/api/v1/agents/' + encodeURIComponent(hash) + '/approval-windows';
export const approveHour = (request, id, confirmation) => request(approvalHourPath(id), { method: 'POST', body: { confirmation } });
export const endApprovalHour = (request, hash, id) => request(approvalWindowsPath(hash) + '/' + encodeURIComponent(id), { method: 'DELETE' });
export const approvalHourText = (until, now = Date.now()) => `Approved for the next ${Math.max(1, Math.ceil((Date.parse(until) - now) / 60000))} minutes`;
