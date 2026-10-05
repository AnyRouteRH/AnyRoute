# @anyroute/chat-kit

An embeddable, white-label React chat for Anyroute. Drop `<AnyrouteChat>` into your app and you get a streamed chat with markdown and copyable code, Stop and Regenerate, image attachments for vision models, a model picker, presets, the privacy label and signed receipt of every reply, and a chat history that is encrypted in the viewer's browser under a key only they hold.

- **No runtime dependencies.** React 18 or later is the only peer. ESM build with type declarations.
- **No Tailwind, no CSS framework.** One small stylesheet driven by CSS variables, with zero specificity, so any rule of yours wins.
- **Two themes, light and dark each:** `neutral` and `anyroute`. `colorScheme="auto"` follows the system.
- **Accessible:** labelled controls, keyboard first (Enter sends, Shift+Enter adds a line, Escape stops), visible focus, and a polite live region that announces when a reply starts and what it said when it ends.
- **MIT licensed** (this package folder).

## Install

```sh
npm install @anyroute/chat-kit
```

## Use

```tsx
import { AnyrouteChat } from "@anyroute/chat-kit";

export function Support() {
  return (
    <div style={{ height: 600 }}>
      <AnyrouteChat
        baseUrl="https://your-router.example"
        getKey={() => fetch("/my-session-key").then((r) => r.text())}
        model="@preset/support"
        systemPrompt="You answer questions about our product."
        theme="neutral"
        title="Support"
      />
    </div>
  );
}
```

`<AnyrouteChat>` fills its parent's height, so give the parent one.

### Keys

Pass `apiKey` for a fixed key, or `getKey` to fetch a short-lived one when each request is made (recommended for anything public: mint a scoped key on your server and hand it to the page). The key is sent only as `Authorization: Bearer` to `baseUrl`.

`baseUrl` defaults to `""`, the page's own origin. That is the simplest white-label setup: put your own proxy at `/api/v1/*` that adds the key on the server, and the browser never sees one.

### Models, presets and characters

`model` takes any id the router knows:

| You pass | Sent as `model` |
| --- | --- |
| `model="vendor/model"` | `vendor/model` |
| `preset="support"` or `model="@preset/support"` | `@preset/support` (pin a version with `@preset/support@3`) |
| `character="ada"` or `model="@character/ada"` | `@character/ada` |

Presets and characters are resolved by the router: `@character/<id>` runs the character card (system prompt, lorebook, greeting) on the normal chat path, so lanes and receipts apply, and the kit shows the router's `X-Anyroute-Character-Note` under the reply when it sends one. To resolve a character (or any alias) in the page instead, pass `resolveModel`, which may also supply a system prompt and extra parameters:

```tsx
<AnyrouteChat
  character="ada"
  resolveModel={async (m) => (m === "@character/ada" ? { model: "vendor/model", systemPrompt: "You are Ada, a patient maths tutor." } : m)}
/>
```

`params` adds fields to every request (`temperature`, `max_tokens`, `provider`, and so on). `lane="attested"` sends `X-Anyroute-Lane: attested`, and the model picker then lists only the models the router serves on that lane.

## Components

| Component | What it is |
| --- | --- |
| `<AnyrouteChat>` | The whole chat: header with optional title and model picker, optional history panel, message list, composer. |
| `<ChatMessage>` | One turn: markdown for replies, images for user turns, model, receipt link, Retry or Regenerate, privacy label. |
| `<ModelPicker>` | A labelled select over `GET /api/v1/models` (or a list you pass), plus extra entries such as presets. |
| `<PrivacyLabel>` | The receipt's privacy label (`GET /api/v1/receipts/{id}/privacy`), fetched when first opened. |
| `<ReceiptLink>` | A link to a reply's signed receipt at `${verifyBase}/verify/?r=<id>`, or your own `href(id)`. |
| `<HistoryPanel>` | Create or unlock the encrypted history, list, open, remove, export, import, lock, delete. |
| `<Markdown>` | The safe markdown renderer (parsed to data, never injected as HTML; only http, https and mailto links). |

### `<AnyrouteChat>` props

Every `useAnyrouteChat` option (below), plus:

| Prop | Default | |
| --- | --- | --- |
| `theme` | `"neutral"` | `"neutral"` or `"anyroute"` |
| `colorScheme` | `"auto"` | `"light"`, `"dark"` or `"auto"` |
| `vars` | | CSS variable overrides, e.g. `{ "--ark-accent": "#7c3aed" }` |
| `className`, `style` | | On the root element |
| `title` | | Header title |
| `placeholder` | `"Write a message"` | |
| `showModelPicker` | `false` | |
| `models`, `pickerExtra` | | Fixed model list; extra entries such as `{ id: "@preset/support", name: "Support" }` |
| `attachments` | `"auto"` | `true`, `false`, or `"auto"`: on when the chosen model lists `image` among its input modalities |
| `showPrivacyLabels` | `true` | |
| `verifyBase`, `receiptHref` | `baseUrl` | Where receipt links point |
| `showHistory` | `false` | Show `<HistoryPanel>` (needs `history`) |
| `names` | `You`, `Assistant` | Labels above turns |
| `emptyState` | | Shown before the first message |
| `injectStyles` | `true` | Set `false` if you import `@anyroute/chat-kit/styles.css` yourself |

## The hook

Build your own UI on the same logic:

```tsx
import { useAnyrouteChat, ChatMessage } from "@anyroute/chat-kit";

function MyChat() {
  const chat = useAnyrouteChat({ baseUrl: "", model: "@preset/support" });
  return (
    <>
      {chat.messages.map((m) => <ChatMessage key={m.id} message={m} />)}
      <button onClick={() => chat.send("Hello")}>Say hello</button>
      {chat.status === "streaming" ? <button onClick={chat.stop}>Stop</button> : null}
    </>
  );
}
```

Options: `baseUrl`, `apiKey` or `getKey`, `model` or `preset` or `character`, `lane`, `systemPrompt`, `params`, `headers`, `fetch`, `resolveModel`, `history`, `chatId`, `initialMessages`, `onReceipt`, `onError`, `onFinish`.

Returns: `messages`, `status` (`idle`, `streaming`, `error`), `error` (a `ChatError` with `status`, `code` and, for 429 and 503, `retryAfterMs` from `Retry-After`), `model`, `setModel`, `chatId`, `send(text, attachments?)`, `stop()`, `regenerate()`, `reset()`, `load(chatId)`, `setMessages`.

A reply that fails shows the router's message, how long to wait when the router said, and a Retry button. Stop keeps the text that already arrived and marks the reply as stopped.

## Encrypted history

Conversations can be kept in the viewer's browser, encrypted, and nowhere else. The kit never sends the history, the passphrase or the key anywhere.

```tsx
import { AnyrouteChat, createEncryptedHistory } from "@anyroute/chat-kit";

const history = createEncryptedHistory(); // IndexedDB, else localStorage, else memory

<AnyrouteChat model="@preset/support" history={history} showHistory />;
```

How it is protected:

- **AES-GCM with a 256-bit key** over the whole history, with a fresh random 12-byte IV on every write.
- **The key is the viewer's.** Either a passphrase (at least 8 characters) run through PBKDF2 with HMAC-SHA-256, 600 000 rounds and a random 16-byte salt, or a random 32-byte viewing key from `generateViewingKey()` that the viewer saves. The key is a non-extractable WebCrypto key held in memory while unlocked; `lock()` drops it.
- **Nothing readable is stored.** The record holds the KDF name and parameters, the IV and the ciphertext. No titles, dates or counts. The KDF parameters are bound into the AES-GCM additional data, so they cannot be swapped for weaker ones.
- **Argon2id if you want it.** WebCrypto has no Argon2, so pass your own: `createEncryptedHistory({ kdf: { name: "argon2id", derive: (passphrase, salt) => argon2id(...) } })` with any WASM implementation that returns 32 bytes.
- **Export and import.** `exportBlob()` returns the stored record as JSON text, still encrypted, to download or move to another browser. `importBlob(text, secret)` accepts it only if it opens under the secret given, then replaces the history in this browser.
- **No recovery.** A lost passphrase or viewing key means the history cannot be read. `forget()` deletes it.

Attachments are kept by name only; their bytes are not stored. This is the same construction the Anyroute Harness uses for its private-mode history.

Storage adapters: `indexedDBStorage()`, `localStorageStorage()`, `memoryStorage()`, or your own `{ persistent, get, set, delete }`.

## Theming and white-label

Everything visual reads a CSS variable on `.ark-root`:

| Variable | Used for |
| --- | --- |
| `--ark-bg`, `--ark-fg`, `--ark-muted` | Page, text, secondary text |
| `--ark-surface`, `--ark-surface-2` | Header, composer, code bars, hovers |
| `--ark-user-bg`, `--ark-user-fg` | The viewer's turns |
| `--ark-accent`, `--ark-accent-fg` | Send button, links |
| `--ark-danger` | Errors |
| `--ark-focus` | Focus ring |
| `--ark-code-bg` | Code |
| `--ark-radius`, `--ark-gap`, `--ark-max-width` | Shape and rhythm |
| `--ark-font`, `--ark-mono`, `--ark-font-size` | Type |

Three ways to make it yours, from lightest to fullest:

1. **`vars`**: `<AnyrouteChat vars={{ "--ark-accent": "#7c3aed", "--ark-radius": "16px", "--ark-font": "Inter, sans-serif" }} />`.
2. **Your stylesheet**: every kit rule is wrapped in `:where()`, so it has zero specificity. `.ark-root { --ark-accent: #7c3aed }` or `.ark-msg[data-role="user"] .ark-bubble { border-radius: 20px }` always wins, whatever the load order.
3. **Your own markup**: `injectStyles={false}` and style the `ark-*` classes from scratch, or use `useAnyrouteChat` with your own components.

No text in the UI names Anyroute; the `anyroute` theme only borrows the site's colours and type. The title, placeholder, turn names and empty state are props. The root carries `data-theme` and `data-scheme` for your own selectors.

## Example

```sh
cd packages/chat-kit
bun install
bun run example        # http://localhost:5178
```

With no API key the example uses an offline sample router for the example page. It streams replies with sample receipts that are not real Anyroute receipts, and needs no network. Enter a router URL and key to use a real router.

## Develop

```sh
bun run typecheck
bun test               # component tests against a fake fetch
bun run build          # dist/index.js, dist/styles.css, dist/types/
```

The tests render the components in happy-dom against a scripted fake router: streaming, Stop (button and Escape), Regenerate, a 429 with Retry-After and Retry, an error inside the stream, the model picker on a lane, image attachments, privacy labels, code copy, the encrypted history (passphrase, viewing key, custom KDF, tampering, export and import) and the theme variables.
