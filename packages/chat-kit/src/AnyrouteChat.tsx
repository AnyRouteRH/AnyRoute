import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ClientOptions } from "./client";
import { acceptsImages, ChatMessage, ModelPicker } from "./components";
import { HistoryPanel } from "./HistoryPanel";
import { injectStyles, type ColorScheme, type ThemeName } from "./styles";
import type { Attachment, ModelInfo } from "./types";
import { useAnyrouteChat, type UseAnyrouteChatOptions } from "./useAnyrouteChat";

export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(png|jpe?g|webp|gif)$/;

export interface AnyrouteChatProps extends UseAnyrouteChatOptions {
  /** "neutral" (default) or "anyroute". */
  theme?: ThemeName;
  /** "auto" (default) follows the system; "light" or "dark" pins it. */
  colorScheme?: ColorScheme;
  /** CSS variable overrides, e.g. { "--ark-accent": "#7c3aed", "--ark-radius": "0" }. */
  vars?: Record<string, string>;
  className?: string;
  style?: CSSProperties;
  /** Header title; omit for no title. */
  title?: ReactNode;
  placeholder?: string;
  /** Show a model picker. `models` fixes its list; otherwise it is fetched from the router. */
  showModelPicker?: boolean;
  models?: ModelInfo[];
  /** Extra picker entries such as presets and characters. */
  pickerExtra?: ModelInfo[];
  /** Image attachments: true, false, or "auto" (when the chosen model takes images, per the model list). */
  attachments?: boolean | "auto";
  /** Privacy label under each reply that carries a receipt (default true). */
  showPrivacyLabels?: boolean;
  /** Where receipt links point: `${verifyBase}/verify/?r=<id>` (default: baseUrl). */
  verifyBase?: string;
  receiptHref?: (receiptId: string) => string;
  /** Show the encrypted history panel (needs `history`). */
  showHistory?: boolean;
  /** Names shown above turns (screen readers hear "<name> said"). */
  names?: { user?: string; assistant?: string };
  /** Shown while the conversation is empty. */
  emptyState?: ReactNode;
  /** Add the kit's stylesheet to the document (default true). Set false when you import styles.css yourself. */
  injectStyles?: boolean;
}

const readImage = (file: File) =>
  new Promise<Attachment>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, type: file.type, url: String(r.result) });
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

/** A complete chat: message list, composer, optional model picker and history, streaming, stop and regenerate. */
export function AnyrouteChat(props: AnyrouteChatProps) {
  const { theme = "neutral", colorScheme = "auto", vars, className, style, title, placeholder = "Write a message", showModelPicker = false, models, pickerExtra, attachments = "auto", showPrivacyLabels = true, verifyBase, receiptHref, showHistory = false, names, emptyState, injectStyles: inject = true, ...hookOptions } = props;
  const chat = useAnyrouteChat(hookOptions);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Attachment[]>([]);
  const [note, setNote] = useState("");
  const [catalog, setCatalog] = useState<ModelInfo[]>(models ?? []);
  const [announce, setAnnounce] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ids = { input: useId() };

  useLayoutEffect(() => {
    if (inject) injectStyles();
  }, [inject]);

  const client: ClientOptions = useMemo(
    () => ({ baseUrl: hookOptions.baseUrl, apiKey: hookOptions.apiKey, getKey: hookOptions.getKey, headers: hookOptions.headers, lane: hookOptions.lane, fetch: hookOptions.fetch }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hookOptions.baseUrl, hookOptions.apiKey, hookOptions.getKey, hookOptions.lane, hookOptions.fetch],
  );

  const current = catalog.find((m) => m.id === chat.model) ?? models?.find((m) => m.id === chat.model);
  const canAttach = attachments === true || (attachments === "auto" && acceptsImages(current));
  const streaming = chat.status === "streaming";
  const last = chat.messages[chat.messages.length - 1];

  // Keep the newest turn in view while it streams.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last?.text, chat.messages.length]);

  // Screen readers hear the start and the end of a reply, not every token.
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (streaming && !wasStreaming.current) setAnnounce("Replying.");
    if (!streaming && wasStreaming.current && last?.role === "assistant") {
      setAnnounce(last.status === "error" ? `Error: ${last.error ?? "the reply failed."}` : last.status === "stopped" ? "Stopped." : `Reply: ${last.text.slice(0, 1200)}`);
    }
    wasStreaming.current = streaming;
  }, [streaming, last]);

  const submit = () => {
    if (streaming || (!draft.trim() && !pending.length)) return;
    const text = draft;
    const files = pending;
    setDraft("");
    setPending([]);
    setNote("");
    void chat.send(text, files);
  };

  const addFiles = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    const room = MAX_ATTACHMENTS - pending.length;
    const ok = list.filter((f) => IMAGE_TYPES.test(f.type) && f.size <= MAX_ATTACHMENT_BYTES).slice(0, Math.max(0, room));
    setNote(ok.length < list.length ? `Only PNG, JPEG, WebP and GIF images up to 8 MB, ${MAX_ATTACHMENTS} at most.` : "");
    const read = await Promise.all(ok.map(readImage));
    setPending((p) => [...p, ...read]);
  };

  const rootStyle = { ...(vars ?? {}), ...(style ?? {}) } as CSSProperties;
  const retryAfterMs = chat.error?.retryAfterMs ?? null;

  return (
    <div className={`ark-root${className ? " " + className : ""}`} data-theme={theme} data-scheme={colorScheme} style={rootStyle}>
      {title || showModelPicker ? (
        <header className="ark-header">
          {title ? <h2 className="ark-title">{title}</h2> : <span className="ark-title" />}
          {showModelPicker ? <ModelPicker value={chat.model} onChange={chat.setModel} models={models} client={client} extra={pickerExtra} disabled={streaming} onModels={setCatalog} /> : null}
        </header>
      ) : null}
      {showHistory && hookOptions.history ? <HistoryPanel history={hookOptions.history} onOpen={chat.load} onNew={chat.reset} currentId={chat.chatId} /> : null}
      <div className="ark-log" ref={logRef} role="log" aria-label="Conversation" aria-live="off" tabIndex={0}>
        {chat.messages.length ? (
          chat.messages.map((m, i) => (
            <ChatMessage
              key={m.id}
              message={m}
              client={client}
              showPrivacy={showPrivacyLabels}
              verifyBase={verifyBase ?? hookOptions.baseUrl}
              receiptHref={receiptHref}
              names={names}
              onRegenerate={i === chat.messages.length - 1 && m.role === "assistant" ? chat.regenerate : undefined}
              retryAfterMs={i === chat.messages.length - 1 ? retryAfterMs : null}
            />
          ))
        ) : (
          <div className="ark-empty">{emptyState ?? "Start the conversation below."}</div>
        )}
      </div>
      <div className="ark-sr" role="status" aria-live="polite" aria-atomic="true">
        {announce}
      </div>
      <form
        className="ark-composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="ark-composer-inner">
          {pending.length ? (
            <div className="ark-pending" aria-label="Attached images">
              {pending.map((a, i) => (
                <button key={i} type="button" className="ark-btn" onClick={() => setPending((p) => p.filter((_, k) => k !== i))} aria-label={`Remove ${a.name}`}>
                  {a.name} (remove)
                </button>
              ))}
            </div>
          ) : null}
          <label className="ark-sr" htmlFor={ids.input}>
            Message
          </label>
          <textarea
            id={ids.input}
            value={draft}
            placeholder={placeholder}
            rows={2}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape" && streaming) {
                e.preventDefault();
                chat.stop();
              }
            }}
            aria-describedby={note ? ids.input + "-note" : undefined}
          />
          <div className="ark-actions">
            {canAttach ? (
              <>
                <input
                  ref={fileRef}
                  hidden
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  aria-label="Attach images"
                  onChange={(e) => {
                    const el = e.currentTarget;
                    void addFiles(el.files).then(() => void (el.value = ""));
                  }}
                />
                <button type="button" className="ark-btn" onClick={() => fileRef.current?.click()} disabled={streaming}>
                  Attach image
                </button>
              </>
            ) : null}
            <span className="ark-spacer" id={ids.input + "-note"}>
              {note}
            </span>
            {streaming ? (
              <button type="button" className="ark-btn" onClick={chat.stop}>
                Stop
              </button>
            ) : (
              <button type="submit" className="ark-btn ark-btn-primary" disabled={!draft.trim() && !pending.length}>
                Send
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
