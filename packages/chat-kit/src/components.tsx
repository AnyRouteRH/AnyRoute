import { useEffect, useId, useRef, useState } from "react";
import { getJson, receiptLane, type ClientOptions } from "./client";
import { Markdown } from "./Markdown";
import { fetchPrivacyLabel, isReceiptId, receiptHref } from "./privacy";
import type { ChatMessage as Message, ModelInfo, PrivacyLabelData } from "./types";

// ---------------------------------------------------------------- receipts

export interface ReceiptLinkProps {
  receiptId: string;
  /** Where receipts are checked: `${verifyBase}/verify/?r=<id>`. */
  verifyBase?: string;
  /** Your own link for a receipt (white-label). Wins over verifyBase. */
  href?: (receiptId: string) => string;
  children?: React.ReactNode;
}

/** A link to a reply's signed receipt. Renders nothing for an id that is not a plain token. */
export function ReceiptLink({ receiptId, verifyBase, href, children }: ReceiptLinkProps) {
  if (!isReceiptId(receiptId)) return null;
  return (
    <a className="ark-receipt" href={href ? href(receiptId) : receiptHref(receiptId, verifyBase)} target="_blank" rel="noopener noreferrer" aria-label={`Signed receipt ${receiptId}`}>
      {children ?? "Receipt"}
    </a>
  );
}

// ---------------------------------------------------------------- privacy label

export interface PrivacyLabelProps {
  /** A label you already have; otherwise it is fetched by receipt id when first opened. */
  label?: PrivacyLabelData | null;
  receiptId?: string;
  client?: ClientOptions;
  /** The lane from the receipt, shown when the router has no label endpoint. */
  lane?: string;
  /** Open on first render (and fetch straight away). */
  defaultOpen?: boolean;
  title?: string;
}

const LANES: Record<string, string> = { public: "Public lane", attested: "Attested lane", unlinkable: "Unlinkable lane" };

/** The receipt's privacy label: who could read the prompt, who saw the address, how it was paid, what was kept. */
export function PrivacyLabel({ label: given, receiptId, client, lane, defaultOpen = false, title = "Privacy label" }: PrivacyLabelProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [state, setState] = useState<{ label: PrivacyLabelData | null; reason: string; loading: boolean }>({ label: given ?? null, reason: "", loading: false });
  useEffect(() => {
    if (given !== undefined) return setState({ label: given, reason: "", loading: false });
    if (!open || !receiptId || !client || state.label || state.loading) return;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    fetchPrivacyLabel(client, receiptId, ctrl.signal).then((r) => !ctrl.signal.aborted && setState({ label: r.label, reason: r.reason, loading: false }));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, receiptId, given]);
  const l = state.label;
  const laneName = LANES[l?.lane || lane || ""] ?? (l?.lane || lane || "");
  return (
    <details className="ark-privacy" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        {title}
        {laneName ? <span className="ark-lane"> {laneName}</span> : null}
      </summary>
      <div className="ark-privacy-body" aria-busy={state.loading || undefined}>
        {state.loading ? <p>Loading the label.</p> : null}
        {l ? (
          <>
            {l.summary.length ? (
              <ul>
                {l.summary.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            ) : null}
            {l.rows.length ? (
              <dl>
                {l.rows.map((r) => (
                  <div key={r.key} style={{ display: "contents" }}>
                    <dt>{r.title}</dt>
                    <dd>{r.text}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </>
        ) : !state.loading ? (
          <p>{state.reason === "absent" || !receiptId ? "This router does not publish privacy labels. The signed receipt still records the lane." : "The label could not be loaded."}</p>
        ) : null}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------- model picker

export interface ModelPickerProps {
  value: string;
  onChange: (model: string) => void;
  /** The models to offer; fetched from GET /api/v1/models (with ?lane=) when not given. */
  models?: ModelInfo[];
  client?: ClientOptions;
  label?: string;
  /** Extra entries such as presets or characters: { id: "@preset/support", name: "Support" }. */
  extra?: ModelInfo[];
  disabled?: boolean;
  onModels?: (models: ModelInfo[]) => void;
}

/** Whether a model takes images (per the catalogue). Unknown means no. */
export const acceptsImages = (m: ModelInfo | undefined) => !!(m?.input_modalities ?? m?.architecture?.input_modalities ?? []).includes("image");

export function ModelPicker({ value, onChange, models: given, client, label = "Model", extra = [], disabled, onModels }: ModelPickerProps) {
  const id = useId();
  const [models, setModels] = useState<ModelInfo[] | null>(given ?? null);
  const [failed, setFailed] = useState(false);
  const cb = useRef(onModels);
  cb.current = onModels;
  useEffect(() => {
    if (given) return void (setModels(given), cb.current?.(given));
    if (!client) return;
    const ctrl = new AbortController();
    const path = "/api/v1/models" + (client.lane ? `?lane=${encodeURIComponent(client.lane)}` : "");
    getJson<{ data?: ModelInfo[] }>(client, path, ctrl.signal)
      .then((body) => {
        let rows = (Array.isArray(body?.data) ? body.data : []).filter((m) => m && typeof m.id === "string");
        // Fail closed on a lane: only models the router lists for that lane.
        if (client.lane) rows = rows.filter((m) => !Array.isArray(m.lanes) || m.lanes.includes(client.lane!));
        setModels(rows);
        cb.current?.(rows);
      })
      .catch(() => !ctrl.signal.aborted && (setFailed(true), setModels([])));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [given, client?.baseUrl, client?.lane]);
  const all = [...extra, ...(models ?? [])];
  const known = all.some((m) => m.id === value);
  return (
    <div className="ark-picker">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-busy={models === null || undefined}>
        {!known ? <option value={value}>{value || (models === null ? "Loading models" : "Choose a model")}</option> : null}
        {all.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id}
          </option>
        ))}
      </select>
      {failed ? <span className="ark-error">Models could not be loaded.</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------- one message

export interface ChatMessageProps {
  message: Message;
  client?: ClientOptions;
  /** Show the privacy label under replies that carry a receipt. */
  showPrivacy?: boolean;
  verifyBase?: string;
  receiptHref?: (receiptId: string) => string;
  /** Shown on the last reply only. */
  onRegenerate?: () => void;
  retryAfterMs?: number | null;
  names?: { user?: string; assistant?: string };
}

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

export function ChatMessage({ message: m, client, showPrivacy = true, verifyBase, receiptHref: href, onRegenerate, retryAfterMs, names }: ChatMessageProps) {
  const who = m.role === "user" ? names?.user ?? "You" : names?.assistant ?? "Assistant";
  const receiptId = m.receipt?.id;
  const lane = receiptLane(m.receipt) || m.lane || "";
  return (
    <article className="ark-msg" data-role={m.role} data-status={m.status} aria-busy={m.status === "streaming" || undefined} aria-label={`${who} said`}>
      <div className="ark-who" aria-hidden="true">
        {who}
      </div>
      {m.attachments?.length ? (
        <div className="ark-thumbs">
          {m.attachments.map((a, i) => (a.url && /^image\//.test(a.type) ? <img key={i} src={a.url} alt={a.name} /> : <span key={i}>{a.name}</span>))}
        </div>
      ) : null}
      {m.text || m.role === "user" ? (
        <div className="ark-bubble">{m.role === "assistant" ? <Markdown text={m.text} /> : m.text}</div>
      ) : m.status === "streaming" ? (
        <div className="ark-bubble ark-thinking">Thinking</div>
      ) : null}
      {m.role === "assistant" ? (
        <div className="ark-meta">
          {m.status === "error" ? (
            <span className="ark-error" role="alert">
              {m.error || "The reply failed."}
              {retryAfterMs ? ` Try again in ${seconds(retryAfterMs)} s.` : ""}
            </span>
          ) : null}
          {m.status === "stopped" ? <span>Stopped</span> : null}
          {m.note ? <span className="ark-note">{m.note}</span> : null}
          {m.servedModel || m.model ? <span>{m.servedModel || m.model}</span> : null}
          {receiptId ? <ReceiptLink receiptId={receiptId} verifyBase={verifyBase} href={href} /> : null}
          {onRegenerate && m.status !== "streaming" ? (
            <button type="button" className="ark-link" onClick={onRegenerate}>
              {m.status === "error" ? "Retry" : "Regenerate"}
            </button>
          ) : null}
        </div>
      ) : null}
      {m.role === "assistant" && showPrivacy && receiptId && m.status !== "streaming" ? <PrivacyLabel receiptId={receiptId} client={client} lane={lane} /> : null}
    </article>
  );
}
