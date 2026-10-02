"use client";
import { proofBadges } from "../../lib/proof-badge.js";
import ProofBadge from "../ProofBadge";
// Private mode for the Harness: one switch under the header bar, a privacy label under each reply, and history that
// stays in this browser, encrypted. The logic lives in lib/private-mode.js and lib/private-history.js; this file is
// the interface. The Harness itself only reads `usePrivateMode()` and mounts <PrivateMode /> and <ReplyPrivacy />.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../lib/api";
import { receiptHref } from "../../lib/arena";
import { PROXY_HREF, TOKENS_HREF, createPrivateStore, fetchPrivacyLabel, receiptLane } from "../../lib/private-mode";
import { HistoryError, MIN_PASSPHRASE, browserStorage, createHistory, memoryStorage, titleOf } from "../../lib/private-history";
import { restoreLanes, snapshotLanes } from "../../lib/harness-image-history";
import { Button, Modal } from "../UI";
import HistoryTools, { ExportCurrent, HistoryAccess, useHistoryKeys } from "./HistoryTools";
import { currentChat } from "../../lib/harness-history";
import s from "./PrivateMode.module.css";

// ---------------------------------------------------------------- the switch, shared by the whole page

const store = createPrivateStore({
  request: (path) => api(path),
  storage: { getItem: (k) => localStorage.getItem(k), setItem: (k, v) => localStorage.setItem(k, v), removeItem: (k) => localStorage.removeItem(k) },
  host: () => location.host,
});
const useStoreState = () => useSyncExternalStore(store.subscribe, store.get, store.get);

/**
 * { on, models, error, tor, setOn, retry, headers }. `models` is the raw GET /api/v1/models?lane=attested list while
 * the switch is on (null while it loads), and `headers()` is what every chat request adds: the attested lane, or nothing.
 */
export function usePrivateMode() {
  const state = useStoreState();
  useEffect(() => {
    store.init();
  }, []);
  return useMemo(() => ({ ...state, setOn: store.setOn, retry: store.retry, headers: store.headers }), [state]);
}

// ---------------------------------------------------------------- privacy label under a reply

const labels = new Map(); // receipt id -> { label, reason }, for the life of the page
let endpointAbsent = false; // once the router answers "no such endpoint", stop asking

function useLabel(id) {
  const [result, setResult] = useState(() => labels.get(id) || null);
  useEffect(() => {
    if (labels.has(id)) return setResult(labels.get(id));
    if (endpointAbsent) return setResult({ label: null, reason: "absent" });
    let live = true;
    fetchPrivacyLabel(id, (path) => api(path)).then((r) => {
      if (r.label) labels.set(id, r);
      else if (r.reason === "absent") endpointAbsent = true;
      if (live) setResult(r);
    });
    return () => {
      live = false;
    };
  }, [id]);
  return result;
}

/** Shown under a finished reply while private mode is on. `open` starts it expanded (the latest reply). */
export function ReplyPrivacy({ msg, open }) {
  const { on } = useStoreState();
  const id = msg.receipt?.id;
  if (!on || !id || msg.status === "waiting" || msg.status === "streaming") return null;
  return <Label id={id} receipt={msg.receipt} open={open} />;
}

function LabelRows({ rows }) {
  return (
    <dl className={s.labelRows}>
      {rows.map((r) => (
        <div key={r.key}>
          <dt>{r.title}</dt>
          <dd>{r.text}</dd>
        </div>
      ))}
    </dl>
  );
}

function Label({ id, receipt, open }) {
  const result = useLabel(id);
  const signed = receiptLane(receipt);
  const label = result?.label || null;
  const lane = label?.lane || signed.lane;
  const proven = proofBadges({ source: "receipt", data: receipt }).some(mark => mark.hardware);
  const pending = !result;
  return (
    <details className={s.label} open={open || undefined} data-proven={proven || undefined}>
      <summary>
        Privacy label
        {pending && <small>reading…</small>}
        {!pending && lane && <small>{lane} lane</small>}
      </summary>
      <div className={s.labelBody}>
        <ProofBadge evidence={{ source: "receipt", data: receipt }} dark explain />
        {lane && !proven && <p className={s.bad}>This receipt does not establish hardware proof. Recorded lane: {lane}.</p>}
        {label ? (
          <>
            {label.summary.length > 0 && (
              <ul className={s.labelSummary}>
                {label.summary.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            {label.rows.length > 0 &&
              (label.summary.length > 0 ? (
                <details className={s.fields}>
                  <summary>The label, field by field</summary>
                  <LabelRows rows={label.rows} />
                </details>
              ) : (
                <LabelRows rows={label.rows} />
              ))}
          </>
        ) : (
          !pending && (
            <p className={s.labelNote}>
              {result.reason === "absent" ? "This router has no privacy label for replies." : "The privacy label could not be read just now."}{" "}
              {signed.lane ? `The signed receipt records the ${signed.lane} lane${signed.disclosure ? ` and the ${signed.disclosure} disclosure class` : ""}.` : "The receipt does not name a lane."}
            </p>
          )
        )}
        <p className={s.labelLinks}>
          <a href={receiptHref(id)} target="_blank" rel="noopener noreferrer">
            Receipt ↗
          </a>
          {label?.verifyUrl && (
            <a href={label.verifyUrl} target="_blank" rel="noopener noreferrer">
              Verify ↗
            </a>
          )}
        </p>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------- history dialogs

function PassphraseDialog({ mode, persistent, onSubmit, onClose }) {
  const creating = mode === "create";
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef(null);
  // The dialog takes focus when it opens; put it on the passphrase once it has.
  useEffect(() => {
    const t = setTimeout(() => field.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);
  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (creating && pass.length < MIN_PASSPHRASE) return setError(`Use at least ${MIN_PASSPHRASE} characters.`);
    if (creating && pass !== again) return setError("The two passphrases differ.");
    setBusy(true);
    try {
      await onSubmit(pass);
    } catch (err) {
      setError(err?.message || "The history could not be opened.");
      setPass("");
      setBusy(false);
      field.current?.focus();
    }
  };
  return (
    <Modal title={creating ? "Keep history on this device" : "Unlock history"} onClose={onClose}>
      <div className={s.dialog}>
        <p>
          {creating
            ? "Your conversations are encrypted in this browser with a key made from this passphrase. The passphrase and the history are never sent anywhere, and nobody can recover them for you."
            : "Enter the passphrase you chose for this browser's history. It stays here."}
        </p>
        {creating && !persistent && <p className={s.dialogWarn}>This browser gives pages no lasting storage here, so the history is lost when you close this tab.</p>}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="history-pass">Passphrase</label>
            <input id="history-pass" ref={field} type="password" autoComplete={creating ? "new-password" : "current-password"} value={pass} onChange={(e) => setPass(e.target.value)} />
          </div>
          {creating && (
            <div className="field">
              <label htmlFor="history-again">Repeat it</label>
              <input id="history-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
            </div>
          )}
          <div className="button-row">
            <Button type="submit" disabled={busy || !pass}>
              {busy ? "Working…" : creating ? "Encrypt and keep" : "Unlock"}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

function ForgetDialog({ onForget, onClose }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Forget everything?" onClose={onClose}>
      <div className={s.dialog}>
        <p>This deletes the encrypted history from this browser and clears the conversation on screen. It cannot be undone.</p>
        <div className="button-row">
          <Button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onForget();
            }}
          >
            {busy ? "Forgetting…" : "Forget everything"}
          </Button>
          <Button type="button" secondary onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- the strip under the header bar

const fresh = () => [{ id: "l0", modelId: null, messages: [] }];

export default function PrivateMode({ priv, lanes, setLanes, setFocus, busy, find }) {
  const on = priv.on;
  const historyRef = useRef(null);
  const history = () => (historyRef.current ??= createHistory({ storage: browserStorage() }));
  const [vault, setVault] = useState("none"); // none | checking | locked | open
  const [chats, setChats] = useState([]);
  const [dialog, setDialog] = useState(null); // create | unlock | list | forget
  const [note, setNote] = useState("");
  const [announce, setAnnounce] = useState("");
  const [shown, setShown] = useState(true); // the panel under the switch: open on a fresh chat, folded once one is under way
  const started = lanes.some((l) => l.messages.length > 0);
  useEffect(() => setShown(!started), [started]);
  const chatId = useRef(null);
  const lastSaved = useRef("");
  // H5: the index and downloads use only the unlocked vault or the conversation already on screen.
  const current = currentChat(lanes, historyRef.current?.unlocked ? historyRef.current.get(chatId.current) : null);
  useHistoryKeys(() => { setShown(true); setDialog(!on ? "access" : vault === "open" ? "list" : vault === "locked" ? "unlock" : "create"); }, () => { if (!busy) setDialog("export"); });
  useEffect(() => { if (!started) { chatId.current = null; lastSaved.current = ""; } }, [started]);

  const restart = () => {
    setLanes(fresh());
    setFocus(0);
    chatId.current = null;
    lastSaved.current = "";
  };

  // Turning the switch on or off starts a clean chat: what was said on the other lane is not carried across.
  const flip = () => {
    const next = !on;
    priv.setOn(next);
    restart();
    setNote("");
    setShown(true);
    setAnnounce(next ? "Private mode on. Proven hardware only." : "Private mode off.");
  };

  // Look for a stored history when the switch turns on; drop the key from memory when it turns off.
  useEffect(() => {
    if (!on) {
      historyRef.current?.lock();
      setVault("none");
      setChats([]);
      setDialog(null);
      return;
    }
    let live = true;
    setVault("checking");
    history()
      .exists()
      .then((has) => live && setVault(has ? "locked" : "none"))
      .catch(() => {
        // IndexedDB is refused here: keep the history in memory for this tab and say so.
        historyRef.current = createHistory({ storage: memoryStorage() });
        if (live) {
          setNote("This browser does not allow saving here, so history lasts until this tab closes.");
          setVault("none");
        }
      });
    return () => {
      live = false;
    };
  }, [on]);

  // Keep the conversation in the encrypted history once a reply has finished.
  useEffect(() => {
    if (!on || vault !== "open" || busy) return;
    const snap = snapshotLanes(lanes);
    if (!snap.some((l) => l.messages.length)) return;
    const sig = JSON.stringify(snap);
    if (sig === lastSaved.current) return;
    chatId.current ??= "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    lastSaved.current = sig;
    const h = history();
    h.put({ id: chatId.current, title: titleOf(lanes), lanes: snap })
      .then(() => { if (h.unlocked) setChats(h.list()); })
      .catch((e) => {
        lastSaved.current = "";
        setNote(e?.message || "The history could not be saved.");
      });
  }, [lanes, busy, vault, on]);

  const opened = () => {
    setChats(history().list());
    setVault("open");
    setDialog("list");
    setNote("");
  };

  const openChat = (id) => {
    const chat = history().get(id);
    if (!chat) return;
    const fallback = priv.models?.[0]?.id || null;
    const restored = restoreLanes(chat.lanes).map((l) => ({ ...l, modelId: find(l.modelId) ? l.modelId : fallback }));
    setLanes(restored);
    setFocus(0);
    chatId.current = chat.id;
    lastSaved.current = JSON.stringify(snapshotLanes(restored));
    setDialog(null);
  };

  const forgetAll = async () => {
    try {
      await history().forget();
    } catch (e) {
      setNote(e instanceof HistoryError ? e.message : "The history could not be deleted.");
    }
    restart();
    setVault("none");
    setChats([]);
    setDialog(null);
    setNote("");
    setAnnounce("Everything was forgotten.");
  };

  const tor = priv.tor;
  const empty = priv.models && !priv.error && priv.models.length === 0;

  return (
    <section className={s.strip} data-on={on || undefined} aria-label="Private mode">
      <div className={s.row}>
        <button type="button" role="switch" aria-checked={on} className={s.toggle} onClick={flip} disabled={busy} title={busy ? "Wait for the reply to finish" : undefined}>
          <i className={s.switch} aria-hidden="true" />
          Private mode
        </button>
        {on ? <span className={s.tag}>Proven hardware only</span> : <span className={s.hint}>Proven hardware only, a label on every reply</span>}
        {on && vault === "open" && <span className={s.state}>History kept here</span>}
        {on && vault === "locked" && <span className={s.state}>History locked</span>}
        <button type="button" className="text-button" disabled={busy || vault === "checking"} aria-keyshortcuts="Meta+K Control+K" onClick={() => { setShown(true); setDialog(!on ? "access" : vault === "open" ? "list" : vault === "locked" ? "unlock" : "create"); }}>Search history</button>
        {started && <button type="button" className="text-button" disabled={busy} aria-keyshortcuts="Meta+Shift+E Control+Shift+E" onClick={() => setDialog("export")}>Export chat</button>}
        {on && (
          <button type="button" className={`text-button ${s.fold}`} aria-expanded={shown} aria-controls="private-panel" onClick={() => setShown((v) => !v)}>
            {shown ? "Hide" : "Details"}
          </button>
        )}
      </div>

      {on && shown && (
        <div className={s.panel} id="private-panel">
          <p className={s.lead}>
            Every request runs on attested hardware or fails; none goes to a public provider. History stays on this device.
          </p>
          {priv.error && (
            <p className={s.bad} role="alert">
              {priv.error}{" "}
              <button type="button" className="text-button" onClick={priv.retry}>
                Try again
              </button>
            </p>
          )}
          {empty && <p className={s.bad}>No model can be served on proven hardware right now.</p>}

          <details className={s.more} open={tor?.onOnion || undefined}>
            <summary>What private mode does, and what it does not</summary>
            <ul>
              <li>It lists only models an attested endpoint can serve right now, and sends every request on the attested lane.</li>
              <li>It shows a privacy label under each reply, or the lane its signed receipt records when the router has no label.</li>
              <li>It keeps history only in this browser, encrypted with your passphrase. Nothing is uploaded.</li>
              <li>
                <b>It does not hide the prompt from AnyRoute.</b> The router still reads it in memory to route it.
              </li>
              <li>It does not hide who you are. Your key names your account, and the router sees your network address unless you reach it over Tor.</li>
            </ul>
            {tor?.unlinkableViaOnion && (
              <div className={s.tor}>
                <b>{tor.onOnion ? "You are on the onion address." : "This router also has an onion address."}</b>
                <p>
                  The unlinkable lane keeps your network address from the router (Tor) and pays with a private token instead of a key, so a payment cannot be tied to a request. This page signs in with a key, so it stays on the attested lane. To use the unlinkable lane, <a href={TOKENS_HREF}>get private tokens</a> and send requests through the <a href={PROXY_HREF}>private proxy</a>.
                </p>
                {!tor.onOnion && (
                  <p>
                    <a href={`${tor.url}/harness/`}>Open this page over Tor</a> (needs Tor Browser).
                  </p>
                )}
              </div>
            )}
          </details>

          <div className={s.actions}>
            {vault === "none" && (
              <>
                <span className={s.state}>History is off. Nothing is saved.</span>
                <button type="button" className="text-button" onClick={() => setDialog("create")}>
                  Keep history on this device
                </button>
              </>
            )}
            {vault === "locked" && (
              <>
                <span className={s.state}>History is locked.</span>
                <button type="button" className="text-button" onClick={() => setDialog("unlock")}>
                  Unlock
                </button>
              </>
            )}
            {vault === "open" && (
              <>
                <span className={s.state}>
                  History: {chats.length} {chats.length === 1 ? "conversation" : "conversations"}, encrypted here.
                </span>
                <button type="button" className="text-button" onClick={() => setDialog("list")}>
                  Open history
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    history().lock();
                    setVault("locked");
                    setChats([]);
                  }}
                >
                  Lock
                </button>
              </>
            )}
            <button type="button" className={`text-button ${s.forget}`} onClick={() => setDialog("forget")}>
              Forget everything
            </button>
          </div>
          {note && (
            <p className={s.quiet} role="status">
              {note}
            </p>
          )}
        </div>
      )}

      {dialog === "create" && (
        <PassphraseDialog
          mode="create"
          persistent={history().persistent}
          onClose={() => setDialog(null)}
          onSubmit={async (pass) => {
            await history().create(pass);
            opened();
          }}
        />
      )}
      {dialog === "unlock" && (
        <PassphraseDialog
          mode="unlock"
          onClose={() => setDialog(null)}
          onSubmit={async (pass) => {
            await history().unlock(pass);
            opened();
          }}
        />
      )}
      {dialog === "list" && (
        <HistoryTools
          history={history()}
          chats={chats}
          current={current}
          busy={busy}
          onChange={() => setChats(history().list())}
          onClose={() => setDialog(null)}
          onOpen={openChat}
          onDelete={async (id) => {
            try {
              await history().remove(id);
              if (chatId.current === id) chatId.current = null;
              setChats(history().list());
            } catch (e) {
              throw e;
            }
          }}
          onLock={() => {
            history().lock();
            setVault("locked");
            setChats([]);
            setDialog(null);
          }}
        />
      )}
      {dialog === "access" && <HistoryAccess onClose={() => setDialog(null)} onEnable={() => { if (!busy) { flip(); setDialog(null); } }} />}
      {dialog === "export" && <ExportCurrent chat={current} onClose={() => setDialog(null)} />}
      {dialog === "forget" && <ForgetDialog onForget={forgetAll} onClose={() => setDialog(null)} />}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </section>
  );
}
