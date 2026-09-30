// The example app: one <AnyrouteChat> with a theme switch and an encrypted history. With no API key it talks to a
// built-in demo router in this page (canned, streamed replies with a receipt), so it runs with no network at all.
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnyrouteChat, createEncryptedHistory, type ColorScheme, type FetchLike, type ThemeName } from "../src";

const DEMO_MODELS = [
  { id: "demo/fast", name: "Demo fast", input_modalities: ["text"] },
  { id: "demo/vision", name: "Demo vision", input_modalities: ["text", "image"] },
];

const REPLY = [
  "Here is a **streamed** reply from the demo router, with a code block you can copy:",
  "",
  "```ts",
  'import { AnyrouteChat } from "@anyroute/chat-kit";',
  "```",
  "",
  "- Stop ends a reply early (or press Escape).",
  "- Regenerate asks again.",
  "- Your history is encrypted in this browser.",
].join("\n");

/** A router in the page: /api/v1/models, a streamed chat reply with a receipt, and a privacy label. */
const demoFetch: FetchLike = async (input, init) => {
  const path = new URL(String(input), location.href).pathname;
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  if (path === "/api/v1/models") return json({ data: DEMO_MODELS });
  if (path.endsWith("/privacy"))
    return json({ data: { receipt_id: "demo_receipt", lane: "attested", summary: ["This is the demo router: nothing left this page."], label: { stored: "Nothing", network: "Nobody: the demo runs in the page" } } });
  const enc = new TextEncoder();
  const words = REPLY.split(/(?<=\s)/);
  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const abort = () => ctrl.error(new DOMException("aborted", "AbortError"));
      init?.signal?.addEventListener("abort", abort);
      for (const w of words) {
        if (init?.signal?.aborted) return;
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ model: "demo/fast", choices: [{ delta: { content: w } }] })}\n\n`));
        await new Promise((r) => setTimeout(r, 35));
      }
      ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [], receipt: { id: "demo_receipt", v2: { claims: { lane: "attested" } } } })}\n\ndata: [DONE]\n\n`));
      ctrl.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
};

function App() {
  const [theme, setTheme] = useState<ThemeName>("anyroute");
  const [scheme, setScheme] = useState<ColorScheme>("auto");
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const history = useMemo(() => createEncryptedHistory(), []);
  const live = !!key.trim();
  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr", height: "100vh" }}>
      <form style={{ display: "flex", flexWrap: "wrap", gap: 12, padding: 12, font: "14px system-ui" }} onSubmit={(e) => e.preventDefault()}>
        <label>
          Theme{" "}
          <select value={theme} onChange={(e) => setTheme(e.target.value as ThemeName)}>
            <option value="anyroute">Anyroute</option>
            <option value="neutral">Neutral</option>
          </select>
        </label>
        <label>
          Scheme{" "}
          <select value={scheme} onChange={(e) => setScheme(e.target.value as ColorScheme)}>
            <option value="auto">Auto</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label>
          Router URL <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-router" />
        </label>
        <label>
          API key <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="empty: demo router" autoComplete="off" />
        </label>
      </form>
      <AnyrouteChat
        key={live ? "live" : "demo"}
        theme={theme}
        colorScheme={scheme}
        title={live ? "Chat" : "Chat (demo router)"}
        baseUrl={live ? baseUrl : ""}
        apiKey={live ? key : undefined}
        fetch={live ? undefined : demoFetch}
        model={live ? "@preset/default" : "demo/fast"}
        showModelPicker
        pickerExtra={live ? [{ id: "@preset/default", name: "Your default preset" }] : []}
        systemPrompt="You are a helpful assistant."
        history={history}
        showHistory
        verifyBase={live ? baseUrl : "https://example.invalid"}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
