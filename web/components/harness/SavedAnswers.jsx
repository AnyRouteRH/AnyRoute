"use client";
// D140: UI over the existing history vault; the bridge reuses its access and open-chat flows.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { answerFromReply, savedAnswerOnScreen, searchSavedAnswers } from "../../lib/saved-answers.js";
import { formatUsd, receiptHref } from "../../lib/arena";
import { Button, Modal } from "../UI";
import s from "./SavedAnswers.module.css";

const Saved = createContext(null);
export function SavedAnswersProvider({ history, lanes, busy, children }) {
  const access = useRef(null);
  const [revision, refresh] = useState(0);
  const [open, setOpen] = useState(false);
  const [selected, select] = useState(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const unlocked = !!history?.unlocked;
  const answers = unlocked ? history.listSavedAnswers() : [];
  const answer = answers.find((a) => a.id === selected);
  const onScreen = answer && savedAnswerOnScreen(answer, lanes);
  const close = () => { setOpen(false); select(null); setQuery(""); setError(""); };
  const run = async (fn) => {
    setPending(true); setError("");
    try { await fn(); refresh((n) => n + 1); }
    catch (e) { setError(e?.message || "Saved answers could not be updated."); setOpen(true); }
    finally { setPending(false); }
  };
  const value = { access, history: unlocked ? history : null, lanes, answers, pending, revision,
    open: () => { setOpen(true); select(null); }, run };
  return <Saved.Provider value={value}>
    {children}
    {open && <Modal title={answer ? "Saved answer" : "Saved"} onClose={close}>
      <div className={s.body}>
        {!unlocked ? <>
          <p>Saved answers are kept with your encrypted history in this browser. Create or unlock history, then return to a reply and choose Save. Your current chat stays on screen.</p>
          <Button type="button" onClick={() => { close(); access.current?.onAccess(); }}>Open history</Button>
        </> : answer ? <>
          <button type="button" className="text-button" onClick={() => select(null)}>Back to saved answers</button>
          <h3 className={s.question}>{answer.question || "Question not recorded"}</h3>
          <p className={s.meta}>{answer.model || "Model not recorded"} · {answer.cost === null ? "Cost not reported" : formatUsd(answer.cost)} · {new Date(answer.at).toLocaleString()}</p>
          <div className={s.answer}>{answer.answer || "No reply text"}</div>
          <div className={s.actions}>
            {answer.receiptId && <a href={receiptHref(answer.receiptId)} target="_blank" rel="noopener noreferrer">Receipt ↗</a>}
            {(history.get(answer.chatId) || onScreen) && <button type="button" className="text-button" disabled={busy || pending} onClick={() => { if (!onScreen) access.current?.onOpen(answer.chatId); close(); }}>Open chat</button>}
            <button type="button" className="text-button" disabled={pending} onClick={() => void run(async () => { await history.unsaveAnswer(answer.id); select(null); })}>Unsave</button>
          </div>
        </> : <>
          <p>Saved answers stay here when you delete a chat. Search reads only this unlocked history.</p>
          <label className={s.search}>Search questions and answers
            <input autoFocus type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
          </label>
          <ul className={s.list}>
            {searchSavedAnswers(answers, query).map((a) => <li key={a.id}>
              <button type="button" className={s.open} onClick={() => select(a.id)}>
                <b>{a.question || "Question not recorded"}</b>
                <span>{a.answer.slice(0, 160)}</span>
                <small>{a.model || "Model not recorded"} · {new Date(a.at).toLocaleString()}</small>
              </button>
            </li>)}
          </ul>
          {!searchSavedAnswers(answers, query).length && <p>{query.trim() ? "No saved answers match." : "Choose Save beside a reply to keep it here."}</p>}
          <p>Export and import saved answers with your history. Downloads contain readable text.</p>
          <button type="button" className="text-button" onClick={() => { close(); access.current?.onAccess(); }}>Open history exports</button>
        </>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </Modal>}
  </Saved.Provider>;
}

export function SavedHistoryBridge({ currentId, onOpen, onAccess }) {
  const saved = useContext(Saved);
  useEffect(() => { if (saved) saved.access.current = { currentId, onOpen, onAccess }; });
  return null;
}

export function SavedAnswersButton() {
  const saved = useContext(Saved);
  return <button type="button" className="text-button" onClick={saved?.open}>Saved</button>;
}

export function SaveAnswer({ msg }) {
  const saved = useContext(Saved);
  const lane = saved?.lanes.find((l) => l.messages.includes(msg));
  if (!lane) return null;
  const chatId = saved.access.current?.currentId() || "";
  const existing = saved.answers.find((a) => (!chatId || a.chatId === chatId) && a.messageId === msg.id && a.model === (msg.model || lane.modelId || ""));
  return <button type="button" className="text-button" aria-pressed={!!existing} disabled={saved.pending || !msg.text} title={!msg.text ? "This reply has no text to save" : undefined} onClick={() => {
    if (!saved.history) return saved.open();
    void saved.run(() => existing ? saved.history.unsaveAnswer(existing.id) : saved.history.saveAnswer(answerFromReply(lane, msg, saved.access.current?.currentId() || "")));
  }}>{existing ? "Unsave" : "Save"}</button>;
}
