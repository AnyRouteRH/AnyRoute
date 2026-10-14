import type { ExternalDoc } from './types';
// H175: no server storage or readers.
export const askAboutThisBrowser: ExternalDoc['browser']['items'][number] = {
  store: 'Page memory and existing Chat message handling',
  holds: 'Highlighted assistant answer text and floating-button position stay in page memory while selected. Ask about this inserts at most 1,500 selected characters, including a truncation ellipsis, as a plain-text quote in the existing composer. There is no new storage key or separate saved selection. Once sent, quoted text is ordinary message content: it follows existing optional encrypted Chat history, exports and inference request handling. The router reads ordinary inference text in memory. No new table, column, Redis family, log field, server address reader or body reader.',
  evidence: [{ file: 'web/lib/ask-about-this.js', contains: 'export const QUOTE_LIMIT = 1500;' }, { file: 'web/components/harness/AskAboutThis.jsx', contains: 'data-ask-about-reply' }],
};
