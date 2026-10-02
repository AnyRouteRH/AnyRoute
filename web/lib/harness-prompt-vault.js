import { validatePrompts } from "./harness-prompts.js";

// Private-mode prompts get their own budget on top of the history budget, so saving prompts never trims or blocks chats.
export const PRIVATE_PROMPT_BYTES = 256_000;
const size = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

// V81: join the history queue and key; no separate passphrase or plaintext fallback.
export function promptVaultEdits({ serial, need, seal }) {
  return {
    listPrompts: () => {
      const s = need();
      return s.prompts === undefined ? null : structuredClone(s.prompts);
    },
    replacePrompts: (incoming) => {
      const prompts = validatePrompts(incoming);
      if (size(prompts) > PRIVATE_PROMPT_BYTES) return Promise.reject(Object.assign(new Error("The private prompt library is full. Delete or shorten prompts to save more."), { code: "too_large" }));
      return serial(async () => {
        const s = need();
        await seal(s, s.chats, prompts);
        s.prompts = prompts;
      });
    },
  };
}
