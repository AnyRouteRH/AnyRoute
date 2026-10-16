import type { ExternalDoc } from './types';
// J183: browser metadata only; server capture and budgets are unchanged.
export const chatProjectsBrowser: ExternalDoc['browser']['items'][number] = {
  store: 'Existing passphrase-encrypted Chat history vault',
  holds: 'Saved chats and folders may keep an optional project field (a lowercase label of 1–48 letters, digits, dots, underscores or hyphens, or null to follow the default). The chat override wins over its folder default; absent selections leave the key default to the router. Choices persist only with history enabled. The active chat choice, project editor draft, account project suggestions and budget details live in page memory; closing the editor drops its draft and suggestions. Locking history drops folder defaults from later requests; the visible chat choice stays in memory until reset or page close. Forget deletes the existing vault. JSON exports expose readable chat and folder project fields; validated imports preserve them, with existing same-name folders winning. Markdown includes only chat overrides. Copy as code contains the effective header. Every Chat send, summary, retry and continuation passes X-Anyroute-Project to existing server capture and budget checks. Anyroute can read these labels, and the router reads request text in memory on every lane. Labels do not change older charges or signed receipts. Existing owner-only project list and budget APIs supply suggestions and details using the current key; no guard is widened. No new browser store, server table, column, Redis key family, log field, address reader or body reader.',
  evidence: [
    { file: 'web/lib/chat-projects.js', contains: 'export function projectFields' },
    { file: 'web/lib/chat-folders.js', contains: 'setFolderProject: (id, project)' },
    { file: 'web/components/Harness.jsx', contains: 'limits.streamChat = projectStream' },
    { file: 'web/components/harness/PrivateMode.jsx', contains: '...projectFields(lanes[0])' },
  ],
};
