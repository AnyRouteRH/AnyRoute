import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AnyrouteChat, CHAT_KIT_CSS, createEncryptedHistory, memoryStorage, STYLE_ELEMENT_ID, THEME_VARS, THEMES, type ModelInfo } from "../src";
import { fakeFetch, textChunks } from "./fake-fetch";

afterEach(() => {
  cleanup();
  document.getElementById(STYLE_ELEMENT_ID)?.remove();
});

const type = (text: string) => {
  const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
};

const MODELS: ModelInfo[] = [
  { id: "vendor/model-a", name: "Model A", input_modalities: ["text"] },
  { id: "vendor/vision-b", name: "Vision B", input_modalities: ["text", "image"] },
];

describe("<AnyrouteChat>", () => {
  test("streams a reply, sends model, system prompt, key and lane, and links the receipt", async () => {
    const f = fakeFetch({ "/api/v1/chat/completions": [{ kind: "stream", chunks: textChunks("Hello there, friend.") }] });
    render(<AnyrouteChat baseUrl="https://router.test" getKey={async () => "ar-test-key"} lane="attested" model="vendor/model-a" systemPrompt="Be brief." fetch={f.fetch} verifyBase="https://site.test" />);
    type("Hi");
    await screen.findByText("Hello there, friend.");
    const call = f.calls[0];
    expect(call.url).toBe("https://router.test/api/v1/chat/completions");
    expect(call.headers.authorization).toBe("Bearer ar-test-key");
    expect(call.headers["x-anyroute-lane"]).toBe("attested");
    expect(call.body).toMatchObject({ model: "vendor/model-a", stream: true, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }] });
    const link = await screen.findByRole("link", { name: "Signed receipt rcpt_1" });
    expect(link.getAttribute("href")).toBe("https://site.test/verify/?r=rcpt_1");
    expect(screen.getByRole("status").textContent).toContain("Reply: Hello there, friend.");
    expect(screen.getByRole("log", { name: "Conversation" })).toBeTruthy();
  });

  test("sends @preset/ and @character/ models as written", async () => {
    const note = "No attested provider for this model; ran on the public lane.";
    const f = fakeFetch({ "/api/v1/chat/completions": [{ kind: "stream", chunks: textChunks("ok") }, { kind: "stream", chunks: textChunks("ok"), headers: { "x-anyroute-character-note": note } }] });
    const { unmount } = render(<AnyrouteChat apiKey="k" preset="support" fetch={f.fetch} />);
    type("a");
    await waitFor(() => expect(f.calls.length).toBe(1));
    expect(f.calls[0].body.model).toBe("@preset/support");
    expect(f.calls[0].url).toBe("/api/v1/chat/completions");
    unmount();
    render(<AnyrouteChat apiKey="k" character="ada" fetch={f.fetch} resolveModel={(m) => ({ model: m, systemPrompt: "You are Ada." })} />);
    type("b");
    await waitFor(() => expect(f.calls.length).toBe(2));
    expect(f.calls[1].body.model).toBe("@character/ada");
    expect(f.calls[1].body.messages[0]).toEqual({ role: "system", content: "You are Ada." });
    expect(await screen.findByText(note)).toBeTruthy();
  });

  test("Stop ends a stream that is still running and keeps what arrived", async () => {
    const f = fakeFetch({ "/api/v1/chat/completions": [{ kind: "stream", chunks: textChunks("First part never finished"), hold: true }] });
    render(<AnyrouteChat apiKey="k" model="vendor/model-a" fetch={f.fetch} />);
    type("Go");
    await screen.findByText(/First/);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("Stopped");
    expect(screen.queryByText(/never finished/)).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    f.release();
  });

  test("Escape in the composer stops a stream", async () => {
    const f = fakeFetch({ "/api/v1/chat/completions": [{ kind: "stream", chunks: textChunks("Held reply"), hold: true }] });
    render(<AnyrouteChat apiKey="k" model="vendor/model-a" fetch={f.fetch} />);
    type("Go");
    await screen.findByText(/Held/);
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Escape" });
    await screen.findByText("Stopped");
    f.release();
  });

  test("Regenerate asks again without the old reply and replaces it", async () => {
    const f = fakeFetch({ "/api/v1/chat/completions": [{ kind: "stream", chunks: textChunks("Answer one.") }, { kind: "stream", chunks: textChunks("Answer two.", "rcpt_2") }] });
    render(<AnyrouteChat apiKey="k" model="vendor/model-a" fetch={f.fetch} />);
    type("Question");
    await screen.findByText("Answer one.");
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await screen.findByText("Answer two.");
    expect(screen.queryByText("Answer one.")).toBeNull();
    expect(f.calls[1].body.messages).toEqual([{ role: "user", content: "Question" }]);
  });

  test("a 429 shows the router's message and Retry-After, and Retry sends again", async () => {
    const f = fakeFetch({
      "/api/v1/chat/completions": [
        { kind: "json", status: 429, headers: { "retry-after": "7" }, body: { error: { code: 429, message: "Rate limit exceeded (1 requests/min).", type: "rate_limited", metadata: { retry_after_ms: 7000 } } } },
        { kind: "stream", chunks: textChunks("Now it works.") },
      ],
    });
    const errors: unknown[] = [];
    render(<AnyrouteChat apiKey="k" model="vendor/model-a" fetch={f.fetch} onError={(e) => errors.push(e)} />);
    type("Hello");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Rate limit exceeded");
    expect(alert.textContent).toContain("Try again in 7 s.");
    expect((errors[0] as { status: number; retryAfterMs: number }).status).toBe(429);
    expect((errors[0] as { retryAfterMs: number }).retryAfterMs).toBe(7000);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Now it works.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(f.calls[1].body.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  test("an error inside the stream is shown as the reply's error", async () => {
    const f = fakeFetch({ "/api/v1/chat/completions": [{ kind: "stream", chunks: [{ error: { code: 502, message: "Provider stream was interrupted.", type: "provider_interrupted" }, choices: [] }] }] });
    render(<AnyrouteChat apiKey="k" model="vendor/model-a" fetch={f.fetch} />);
    type("Hello");
    expect((await screen.findByRole("alert")).textContent).toContain("Provider stream was interrupted.");
  });

  test("the model picker lists models for the lane and attachments follow the model", async () => {
    const f = fakeFetch({ "/api/v1/models": [{ kind: "json", status: 200, body: { data: [...MODELS.map((m) => ({ ...m, lanes: ["public", "attested"] })), { id: "vendor/public-only", lanes: ["public"] }] } }] });
    render(<AnyrouteChat apiKey="k" lane="attested" model="vendor/model-a" showModelPicker fetch={f.fetch} />);
    const select = (await screen.findByLabelText("Model")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    expect(f.calls[0].url).toBe("/api/v1/models?lane=attested");
    expect(screen.queryByRole("button", { name: "Attach image" })).toBeNull();
    fireEvent.change(select, { target: { value: "vendor/vision-b" } });
    expect(await screen.findByRole("button", { name: "Attach image" })).toBeTruthy();
  });

  test("an image attachment is sent as an image_url part", async () => {
    const f = fakeFetch({ "/api/v1/chat/completions": [{ kind: "stream", chunks: textChunks("A cat.") }] });
    const { container } = render(<AnyrouteChat apiKey="k" model="vendor/vision-b" models={MODELS} attachments fetch={f.fetch} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([137, 80, 78, 71])], "cat.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => void fireEvent.change(input));
    await screen.findByRole("button", { name: "Remove cat.png" });
    type("What is this?");
    await screen.findByText("A cat.");
    const content = f.calls[0].body.messages[0].content;
    expect(content[0]).toEqual({ type: "text", text: "What is this?" });
    expect(content[1].type).toBe("image_url");
    expect(content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  test("the privacy label is fetched from the receipt when opened", async () => {
    const f = fakeFetch({
      "/api/v1/chat/completions": [{ kind: "stream", chunks: textChunks("Private answer.") }],
      "/api/v1/receipts/rcpt_1/privacy": [{ kind: "json", status: 200, body: { data: { receipt_id: "rcpt_1", lane: "attested", summary: ["Only the attested enclave read the prompt."], label: { prompt_readers: { text: "The router in memory and the attested enclave." }, stored: "nothing" } } } }],
    });
    render(<AnyrouteChat apiKey="k" model="vendor/model-a" fetch={f.fetch} />);
    type("Secret");
    await screen.findByText("Private answer.");
    const summary = screen.getByText("Privacy label");
    const details = summary.closest("details") as HTMLDetailsElement;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(await screen.findByText("Only the attested enclave read the prompt.")).toBeTruthy();
    expect(screen.getByText("Who could read the prompt")).toBeTruthy();
    expect(screen.getByText("The router in memory and the attested enclave.")).toBeTruthy();
    expect(screen.getAllByText("Attested lane").length).toBeGreaterThan(0);
  });

  test("code blocks have a copy button", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => void copied.push(t) }, configurable: true });
    const f = fakeFetch({ "/api/v1/chat/completions": [{ kind: "stream", chunks: textChunks("```js\nconsole.log(1)\n```") }] });
    render(<AnyrouteChat apiKey="k" model="vendor/model-a" fetch={f.fetch} />);
    type("code please");
    const btn = await screen.findByRole("button", { name: "Copy code" });
    await act(async () => void fireEvent.click(btn));
    expect(copied).toEqual(["console.log(1)"]);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  test("finished replies are written to an unlocked encrypted history and can be loaded back", async () => {
    const history = createEncryptedHistory({ storage: memoryStorage(), iterations: 100_000 });
    await history.create({ passphrase: "correct horse battery" });
    const f = fakeFetch({ "/api/v1/chat/completions": [{ kind: "stream", chunks: textChunks("Kept reply.") }] });
    render(<AnyrouteChat apiKey="k" model="vendor/model-a" fetch={f.fetch} history={history} showHistory chatId="chat-1" />);
    type("Keep this");
    await screen.findByText("Kept reply.");
    await waitFor(() => expect(history.list().length).toBe(1));
    expect(history.list()[0]).toMatchObject({ id: "chat-1", title: "Keep this", turns: 1 });
    expect(history.get("chat-1")!.messages.map((m) => m.text)).toEqual(["Keep this", "Kept reply."]);
    fireEvent.click(await screen.findByRole("button", { name: "New chat" }));
    await waitFor(() => expect(screen.queryByText("Kept reply.")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Keep this" }));
    expect(await screen.findByText("Kept reply.")).toBeTruthy();
  });
});

describe("theming", () => {
  test("every theme sets every variable, in light and dark", () => {
    for (const t of Object.values(THEMES)) for (const scheme of [t.light, t.dark]) for (const v of THEME_VARS) expect(scheme[v]).toBeTruthy();
    for (const v of THEME_VARS) expect(CHAT_KIT_CSS).toContain(`${v}:`);
    expect(CHAT_KIT_CSS).toContain('[data-theme="anyroute"]');
    expect(CHAT_KIT_CSS).toContain("@media (prefers-color-scheme: dark)");
    // Zero specificity, so a host rule always wins.
    expect(CHAT_KIT_CSS.split("\n").filter((l) => l.startsWith(".ark"))).toEqual([]);
  });

  test("the root carries theme, scheme and overrides, and the stylesheet is injected once", () => {
    render(
      <>
        <AnyrouteChat apiKey="k" model="m" theme="anyroute" colorScheme="dark" vars={{ "--ark-accent": "#7c3aed" }} className="mine" title="Support" />
        <AnyrouteChat apiKey="k" model="m" />
      </>,
    );
    const roots = document.querySelectorAll(".ark-root");
    const root = roots[0] as HTMLElement;
    expect(root.dataset.theme).toBe("anyroute");
    expect(root.dataset.scheme).toBe("dark");
    expect(root.className).toBe("ark-root mine");
    expect(root.style.getPropertyValue("--ark-accent")).toBe("#7c3aed");
    expect((roots[1] as HTMLElement).dataset.theme).toBe("neutral");
    expect((roots[1] as HTMLElement).dataset.scheme).toBe("auto");
    expect(document.querySelectorAll(`#${STYLE_ELEMENT_ID}`).length).toBe(1);
    expect(document.getElementById(STYLE_ELEMENT_ID)!.textContent).toBe(CHAT_KIT_CSS);
    expect(screen.getByRole("heading", { name: "Support" })).toBeTruthy();
  });

  test("injectStyles={false} leaves the document alone", () => {
    render(<AnyrouteChat apiKey="k" model="m" injectStyles={false} />);
    expect(document.getElementById(STYLE_ELEMENT_ID)).toBeNull();
  });
});
