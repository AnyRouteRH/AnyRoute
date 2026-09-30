import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { generateViewingKey, HistoryError, type EncryptedHistory, type ViewingSecret } from "./history";

export interface HistoryPanelProps {
  history: EncryptedHistory;
  /** Open a kept conversation. */
  onOpen: (chatId: string) => void;
  /** Start a new conversation. */
  onNew?: () => void;
  /** The conversation on screen, marked as current in the list. */
  currentId?: string;
  /** File name for exports. */
  exportName?: string;
}

const message = (e: unknown) => (e instanceof HistoryError ? e.message : (e as Error)?.message || "That did not work.");

/**
 * Unlock, create, list, export and import an encrypted history. The passphrase or viewing key never leaves this
 * component except into WebCrypto; nothing is sent anywhere.
 */
export function HistoryPanel({ history, onOpen, onNew, currentId, exportName = "chat-history.json" }: HistoryPanelProps) {
  const version = useSyncExternalStore(
    (fn) => history.subscribe(fn),
    () => `${history.unlocked}:${history.list().map((c) => c.id + c.at).join()}`,
    () => "",
  );
  const [exists, setExists] = useState<boolean | null>(null);
  const [secret, setSecret] = useState("");
  const [useKey, setUseKey] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const inputId = useId();
  useEffect(() => {
    history.exists().then(setExists, () => setExists(false));
  }, [history, version]);

  const act = async (fn: () => Promise<void>, done = "") => {
    setBusy(true);
    setNote("");
    try {
      await fn();
      setNote(done);
    } catch (e) {
      setNote(message(e));
    } finally {
      setBusy(false);
    }
  };
  const asSecret = (): ViewingSecret => (useKey ? { key: secret } : { passphrase: secret });

  if (!history.unlocked) {
    const creating = exists === false;
    return (
      <section className="ark-vault" aria-label="Encrypted history">
        <p>{creating ? "Keep conversations in this browser, encrypted under a passphrase or a viewing key only you hold." : "Your history here is encrypted. Unlock it to see it."}</p>
        <form
          className="ark-vault-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!secret) return;
            act(async () => {
              await (creating ? history.create(asSecret()) : history.unlock(asSecret()));
              setSecret("");
            });
          }}
        >
          <label className="ark-sr" htmlFor={inputId}>
            {useKey ? "Viewing key" : "Passphrase"}
          </label>
          <input id={inputId} type="password" autoComplete={creating ? "new-password" : "current-password"} placeholder={useKey ? "Viewing key" : "Passphrase"} value={secret} onChange={(e) => setSecret(e.target.value)} disabled={busy} />
          <button type="submit" className="ark-btn ark-btn-primary" disabled={busy || !secret}>
            {creating ? "Create" : "Unlock"}
          </button>
          <button type="button" className="ark-link" onClick={() => setUseKey((v) => !v)}>
            {useKey ? "Use a passphrase" : "Use a viewing key"}
          </button>
          {creating && useKey ? (
            <button
              type="button"
              className="ark-link"
              onClick={() => {
                const k = generateViewingKey();
                setNewKey(k);
                setSecret(k);
              }}
            >
              Generate a key
            </button>
          ) : null}
        </form>
        {newKey ? (
          <p>
            Save this key now. It is the only way to open this history: <span className="ark-key">{newKey}</span>
          </p>
        ) : null}
        <ImportRow history={history} secretOf={asSecret} disabled={busy || !secret} onDone={setNote} />
        <p role="status" aria-live="polite">
          {note}
        </p>
      </section>
    );
  }

  const chats = history.list();
  return (
    <section className="ark-vault" aria-label="Encrypted history">
      <div className="ark-vault-row">
        {onNew ? (
          <button type="button" className="ark-btn" onClick={onNew}>
            New chat
          </button>
        ) : null}
        <button
          type="button"
          className="ark-btn"
          onClick={() =>
            act(async () => {
              const blob = await history.exportBlob();
              const url = URL.createObjectURL(new Blob([blob], { type: "application/json" }));
              const a = document.createElement("a");
              a.href = url;
              a.download = exportName;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 0);
            }, "Exported. The file is still encrypted.")
          }
        >
          Export
        </button>
        <button type="button" className="ark-btn" onClick={() => history.lock()}>
          Lock
        </button>
        <button type="button" className="ark-btn" onClick={() => act(() => history.forget(), "History deleted from this browser.")}>
          Delete history
        </button>
      </div>
      {chats.length ? (
        <ul aria-label="Kept conversations">
          {chats.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onOpen(c.id)} aria-current={c.id === currentId || undefined}>
                {c.title}
              </button>
              <button type="button" className="ark-link" onClick={() => act(() => history.remove(c.id))} aria-label={`Remove ${c.title}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>No conversations kept yet.</p>
      )}
      {!history.persistent ? <p>This browser keeps the history in memory only; it is gone when the page closes.</p> : null}
      <p role="status" aria-live="polite">
        {note}
      </p>
    </section>
  );
}

function ImportRow({ history, secretOf, disabled, onDone }: { history: EncryptedHistory; secretOf: () => ViewingSecret; disabled: boolean; onDone: (note: string) => void }) {
  const id = useId();
  return (
    <div className="ark-vault-row">
      <label htmlFor={id}>Import an exported history (uses the passphrase or key above)</label>
      <input
        id={id}
        type="file"
        accept="application/json,.json"
        disabled={disabled}
        onChange={async (e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (!file) return;
          try {
            await history.importBlob(await file.text(), secretOf());
            onDone("Imported.");
          } catch (err) {
            onDone(message(err));
          }
        }}
      />
    </div>
  );
}
