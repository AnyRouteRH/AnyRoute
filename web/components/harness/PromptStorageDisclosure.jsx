import { PROMPT_KEY } from "../../lib/harness-prompts.js";
import { sourceUrl } from "../../lib/keep";

// V81: website-only storage supplement; the router inventory and its digest stay independent.
export default function PromptStorageDisclosure() {
  return <p>
    The prompt library keeps names, text, tags, pins, optional model choices and system prompts in this browser until you delete them or clear browser storage.
    Ordinary prompts use the <code>{PROMPT_KEY}</code> localStorage key without encryption.
    Private-mode prompts share the encrypted <code>anyroute-private-history</code> IndexedDB vault and its passphrase; locking or forgetting history also locks or deletes them.
    Where IndexedDB is unavailable, private prompts last only for this tab.
    The two libraries stay separate. JSON exports contain readable prompt data, including system prompts.
    Prompts are sent through the existing chat path only when you submit them.
    {" "}<a href={sourceUrl("web/lib/harness-prompts.js")} target="_blank" rel="noopener noreferrer">Prompt storage source</a>
    {" · "}<a href={sourceUrl("web/lib/harness-prompt-vault.js")} target="_blank" rel="noopener noreferrer">Encrypted storage source</a>
  </p>;
}
