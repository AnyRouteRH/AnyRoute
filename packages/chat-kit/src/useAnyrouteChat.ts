import { useCallback, useEffect, useRef, useState } from "react";
import { applyChunk, ChatError, streamChat, wireMessage, type ClientOptions } from "./client";
import type { EncryptedHistory } from "./history";
import type { Attachment, ChatMessage, Receipt } from "./types";

/** What `resolveModel` may return: a model id, or a model id plus a system prompt to use with it. */
export type ResolvedModel = string | { model: string; systemPrompt?: string; params?: Record<string, unknown> };

export interface UseAnyrouteChatOptions extends ClientOptions {
  /** A model id ("vendor/model"), a preset ("@preset/name" or "@preset/name@3") or a character ("@character/id"). */
  model?: string;
  /** Shorthand for model "@preset/<preset>". Wins over `model`. */
  preset?: string;
  /** Shorthand for model "@character/<character>". Wins over `model` and `preset`. */
  character?: string;
  systemPrompt?: string;
  /** Extra body fields sent with every request (temperature, max_tokens, provider, ...). */
  params?: Record<string, unknown>;
  /**
   * Turn the chosen model into what is sent. By default ids, presets and characters go to the router as written
   * (the router resolves "@preset/" and "@character/"). Use this to map a character or alias on the client instead.
   */
  resolveModel?: (model: string) => ResolvedModel | Promise<ResolvedModel>;
  /** An encrypted history: every finished reply is written to it while it is unlocked. */
  history?: EncryptedHistory;
  /** The id this conversation is kept under (a random one by default). */
  chatId?: string;
  initialMessages?: ChatMessage[];
  onReceipt?: (receipt: Receipt, message: ChatMessage) => void;
  onError?: (error: ChatError) => void;
  onFinish?: (message: ChatMessage) => void;
}

export type ChatStatus = "idle" | "streaming" | "error";

export interface UseAnyrouteChat {
  messages: ChatMessage[];
  status: ChatStatus;
  error: ChatError | null;
  /** The model as chosen (before resolveModel), e.g. "@preset/support". */
  model: string;
  setModel: (model: string) => void;
  chatId: string;
  send: (text: string, attachments?: Attachment[]) => Promise<void>;
  stop: () => void;
  /** Ask again for the last reply (also what Retry does after an error). */
  regenerate: () => Promise<void>;
  /** Start a new, empty conversation. */
  reset: () => void;
  /** Open a conversation kept in the (unlocked) history. */
  load: (chatId: string) => boolean;
  setMessages: (messages: ChatMessage[]) => void;
}

let counter = 0;
export const makeId = (prefix = "m") => `${prefix}${Date.now().toString(36)}${(++counter).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** The model string an options object asks for. */
export function chosenModel(o: Pick<UseAnyrouteChatOptions, "model" | "preset" | "character">): string {
  if (o.character) return o.character.startsWith("@character/") ? o.character : `@character/${o.character}`;
  if (o.preset) return o.preset.startsWith("@preset/") ? o.preset : `@preset/${o.preset}`;
  return o.model ?? "";
}

const isAbort = (e: unknown) => (e as { name?: string })?.name === "AbortError";

export function useAnyrouteChat(options: UseAnyrouteChatOptions): UseAnyrouteChat {
  const opts = useRef(options);
  opts.current = options;
  const [messages, setMessagesState] = useState<ChatMessage[]>(() => options.initialMessages ?? []);
  const msgs = useRef(messages);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [error, setError] = useState<ChatError | null>(null);
  const [model, setModel] = useState(() => chosenModel(options));
  const [chatId, setChatId] = useState(() => options.chatId ?? makeId("c"));
  const chatRef = useRef(chatId);
  const abort = useRef<AbortController | null>(null);
  const stopped = useRef(false);
  const modelRef = useRef(model);
  modelRef.current = model;

  // Follow the props when the host changes the model or the conversation id.
  const propModel = chosenModel(options);
  useEffect(() => setModel(propModel), [propModel]);
  useEffect(() => {
    if (options.chatId && options.chatId !== chatRef.current) setChatId((chatRef.current = options.chatId));
  }, [options.chatId]);
  useEffect(() => () => abort.current?.abort(), []);

  const commit = useCallback((next: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    msgs.current = typeof next === "function" ? next(msgs.current) : next;
    setMessagesState(msgs.current);
  }, []);
  const patch = useCallback((id: string, fn: (m: ChatMessage) => ChatMessage) => commit((prev) => prev.map((m) => (m.id === id ? fn(m) : m))), [commit]);

  const keep = useCallback(async () => {
    const h = opts.current.history;
    if (!h?.unlocked || !msgs.current.length) return;
    try {
      await h.put({ id: chatRef.current, model: modelRef.current, messages: msgs.current });
    } catch {
      /* a full or locked history does not stop the chat */
    }
  }, []);
  /** Stream a reply to the conversation as it stands. */
  const run = useCallback(async () => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    stopped.current = false;
    const o = opts.current;
    const asked = modelRef.current;
    const reply: ChatMessage = { id: makeId("a"), role: "assistant", text: "", model: asked, status: "streaming", at: Date.now() };
    const history = msgs.current.filter((m) => m.role === "user" || (m.status !== "error" && m.text));
    commit((prev) => [...prev, reply]);
    setStatus("streaming");
    setError(null);
    try {
      const resolved = o.resolveModel ? await o.resolveModel(asked) : asked;
      const r = typeof resolved === "string" ? { model: resolved } : resolved;
      const system = r.systemPrompt ?? o.systemPrompt;
      const body: Record<string, unknown> = {
        ...(o.params ?? {}),
        ...(r.params ?? {}),
        ...(r.model ? { model: r.model } : {}),
        messages: [...(system ? [{ role: "system", content: system }] : []), ...history.map(wireMessage)],
      };
      const res = await streamChat(o, body, ctrl.signal);
      if (res.lane || res.characterNote) patch(reply.id, (m) => ({ ...m, ...(res.lane ? { lane: res.lane } : {}), ...(res.characterNote ? { note: res.characterNote.slice(0, 300) } : {}) }));
      for await (const ev of res.chunks) {
        patch(reply.id, (m) => applyChunk(m, ev));
        if (ev.receipt?.id) {
          const done = msgs.current.find((m) => m.id === reply.id);
          if (done) o.onReceipt?.(ev.receipt, done);
        }
      }
      patch(reply.id, (m) => ({ ...m, status: "done" }));
      setStatus("idle");
    } catch (e) {
      if (isAbort(e) || stopped.current) {
        patch(reply.id, (m) => ({ ...m, status: "stopped" }));
        setStatus("idle");
      } else {
        const err = e instanceof ChatError ? e : new ChatError((e as Error)?.message || "The request failed.", { code: "network" });
        patch(reply.id, (m) => ({ ...m, status: "error", error: err.message }));
        setError(err);
        setStatus("error");
        o.onError?.(err);
      }
    } finally {
      if (abort.current === ctrl) abort.current = null;
    }
    const last = msgs.current.find((m) => m.id === reply.id);
    if (last && last.status !== "error") o.onFinish?.(last);
    await keep();
  }, [commit, patch, keep]);

  const send = useCallback(
    async (text: string, attachments: Attachment[] = []) => {
      const t = text.trim();
      if (!t && !attachments.length) return;
      commit((prev) => [...prev, { id: makeId("u"), role: "user", text: t, attachments: attachments.length ? attachments : undefined, at: Date.now() }]);
      await run();
    },
    [commit, run],
  );

  const stop = useCallback(() => {
    stopped.current = true;
    abort.current?.abort();
  }, []);

  const regenerate = useCallback(async () => {
    const list = msgs.current;
    let end = list.length;
    while (end > 0 && list[end - 1].role === "assistant") end--;
    if (!end) return;
    commit(list.slice(0, end));
    await run();
  }, [commit, run]);

  const reset = useCallback(() => {
    abort.current?.abort();
    commit([]);
    setError(null);
    setStatus("idle");
    setChatId((chatRef.current = makeId("c")));
  }, [commit]);

  const load = useCallback(
    (id: string) => {
      const h = opts.current.history;
      const chat = h?.unlocked ? h.get(id) : null;
      if (!chat) return false;
      abort.current?.abort();
      commit(chat.messages);
      if (chat.model) setModel(chat.model);
      setError(null);
      setStatus("idle");
      setChatId((chatRef.current = chat.id));
      return true;
    },
    [commit],
  );

  return { messages, status, error, model, setModel, chatId, send, stop, regenerate, reset, load, setMessages: commit };
}
