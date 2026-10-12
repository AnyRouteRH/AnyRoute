import type { ExternalDoc } from './types';
// G162: only existing browser stores; no server address or body reader.
export const chatCapBrowser: ExternalDoc['browser']['items'][number] = {
  store: 'Existing encrypted Chat history vault and localStorage preferences',
  holds: 'Each saved chat may keep spendingCap as a positive integer micro-dollar string in the existing passphrase-encrypted anyroute-private-history vault. Removing a cap omits the field. History must be enabled to keep a cap after closing the page; locked vaults drop decrypted history from memory and Forget deletes the vault. JSON history exports expose this readable field and validated imports retain it; Markdown exports include the cap as readable text. The existing anyroute-harness-prefs localStorage record holds defaultChatCap (a micro-dollar string or null) until changed or browser data is cleared. The default is not encrypted. Denied storage keeps the default in page memory only. Unlocked cap values, estimates, editor amounts and a held-send callback with its draft and attachments live in page memory. Editing the request or changing the chat clears the held action. A one-send override is not persisted. No new table, column, Redis family, log field, server address reader or body reader. Checks reuse chat costs and catalogue estimates in the browser and do not upload anything; ordinary inference requests still pass through the router, which reads their text in memory. This browser guard does not enforce a hard billing limit.',
  evidence: [
    { file: 'web/lib/chat-cap.js', contains: "export const CHAT_CAP_PREFS = 'anyroute-harness-prefs'" },
    { file: 'web/lib/harness-history-vault.js', contains: '...capFields(chat)' },
    { file: 'web/components/harness/ChatCap.jsx', contains: 'guard.current.sendAnyway(pending.resume)' },
  ],
};
