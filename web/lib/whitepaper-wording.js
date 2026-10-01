// Shared by the source checks and static-export audit; match words, not identifiers inside links.
export const WHITEPAPER_BANNED_WORDS = /\b(?:earn(?:s|ed|ing)?|yield(?:s|ed|ing)?|APY|returns|passive\s+income|trustless|decentralized|demo|test(?:s|ed|ing)?|mock(?:s|ed|ing)?|simulated|placeholder|local[ -]build)\b|can(?:'|’|&apos;|&#x27;)t\s+read\s+your\s+prompts/i;

export function whitepaperText(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&(?:nbsp|#160);/g, " ");
}
