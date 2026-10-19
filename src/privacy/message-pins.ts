import type { ExternalDoc } from './types';
// K191: one optional field inside the existing encrypted browser vault.
export const messagePinsBrowser: ExternalDoc['browser']['items'][number] = {
  store: 'Existing passphrase-encrypted Chat history vault and browser memory',
  holds: 'An optional boolean pinned on each user or assistant message, including branch nodes, records pins for that message version. The strip shows only the selected branch. Pins preserve otherwise empty or failed replies as text, reply status (waiting and streaming reopen as stopped), and existing supported image and reply metadata; document contents, audio and reasoning remain excluded from saved history. The flag stays in page memory unless encrypted history is enabled, then uses the existing vault, limits, Lock and Forget controls with no new storage key. JSON exports expose readable pins and all branch versions; validated imports restore pins and statuses, older exports omit the flag, Markdown adds Pinned markers, and print marks pinned messages on the shown path. Existing image and attachment import rules are unchanged. Pin and unpin send no request. Summarize and continue keeps pinned messages and prepared attachments in memory alongside the summary, without replaying tool calls or old cumulative context baselines, and retains pinned turns in the existing authenticated summary request; too-large pinned turns stop summarizing with an explanation. Ordinary inference and summary text is read by the router in memory. No new server table, column, Redis family, log field, address reader, body reader, endpoint or background work.',
  evidence: [
    { file: 'web/lib/message-pins.js', contains: 'export function pinFields' },
    { file: 'web/lib/pin-summary.js', contains: 'export function keepSummaryPins' },
    { file: 'web/components/harness/MessagePins.jsx', contains: 'export function MessagePinsStrip' },
  ],
};
