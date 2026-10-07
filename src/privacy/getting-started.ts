import type { ExternalDoc } from "./types.ts";
// C135: browser-only checklist state, with no new server persistence or readers.
export const gettingStartedBrowser: ExternalDoc["browser"]["items"][number] = {
  store: "localStorage",
  holds: "Getting started keeps Hide, all-steps-complete and receipt-visit booleans plus at most 100 receipt ids read from authenticated account data under anyroute-getting-started-v1:<connected key public hash>. No API key secret, balance, call text, Telegram user id or rulebook is stored. Home reads existing balance, key, agent, activity and Telegram link APIs in memory within their existing access boundaries. Opening /verify with a remembered receipt id marks only a visit, not signature validity; arbitrary public receipt ids do not count. Preferences do not sync between devices and survive until browser storage is cleared. If storage is unavailable, Hide applies to the current view only and receipt visits cannot be remembered. These stored preferences and ids are not sent to the router; the existing verify page still requests the named receipt and its privacy label.",
  evidence: [{ file: "web/lib/getting-started.js", contains: "export const GETTING_STARTED_PREFIX = 'anyroute-getting-started-v1:';" }, { file: "web/lib/getting-started.js", contains: "export function recordGettingStartedReceiptVisit" }],
};
