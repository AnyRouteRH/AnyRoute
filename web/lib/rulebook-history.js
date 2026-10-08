// D144: only readable history fields reach the interface.
export const historyPath = keyHash => `/api/v1/agents/${encodeURIComponent(keyHash)}/policy/versions`;
export const restorePath = keyHash => `/api/v1/agents/${encodeURIComponent(keyHash)}/policy/restore`;
export const savedByLabel = hash => typeof hash === 'string' ? `Key ${hash.slice(0, 12)}` : 'Saving key unavailable';
export const historySource = source => ({ save: 'Saved rules', approve_and_allow: 'Approved and allowed next time', restore: 'Restored rules', playbook: 'Playbook rules' })[source] || 'Saved rules';
export const restoreConfirmation = date => `Restore the rules saved ${date}? This saves them as the current rulebook. Stop state and inherited rules still apply.`;
