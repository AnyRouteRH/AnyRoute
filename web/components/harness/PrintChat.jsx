"use client";
import { RecordedChargeLinks } from "../TraceChargeLinks.js"; // J182
// H174: reuse Chat's current metadata, selected lanes and Markdown renderer.
import { useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import Markdown from "../Markdown";
import { formatUsd } from "../../lib/arena.js";
import { openChatPrint, printChatModel } from "../../lib/print-chat.js";
import s from "./PrintChat.module.css";

export function PrintChatView({ model, viewRef }) {
  return <article ref={viewRef} data-chat-print className={s.print} aria-label="Chat print layout">
    <header><h1>{model.title}</h1><p>Anyroute · Chat · <time dateTime={new Date(model.at).toISOString()}>{new Date(model.at).toLocaleString()}</time></p></header>
    {model.lanes.map(lane => <section key={lane.number} className={s.lane}>
      {model.lanes.length > 1 && <h2>Lane {lane.number} · {lane.model}</h2>}
      {lane.messages.map((message, index) => <section className={s.message} key={index}>
        <h3>{message.role === "user" ? "You" : message.model}</h3>
        {message.text && <Markdown text={message.text} renderCode={block => <pre><code>{block.text}</code></pre>} />}
        {message.images.map((url, imageIndex) => <figure key={imageIndex}><img src={url} alt={`${message.role === "assistant" ? "Generated" : "Attached"} image ${imageIndex + 1}`} /></figure>)}
        {message.omittedImages > 0 && <p>Some images are unavailable for printing.</p>}
        {message.files.length > 0 && <p>Attached files: {message.files.join(", ")}</p>}
        {message.role === "assistant" && <footer>
          {message.status && <span>{message.status} · </span>}
          <span>Cost: {message.cost === null ? "pending" : formatUsd(message.cost)}</span>
          <span> · Receipt: {message.receiptId || "unavailable"}</span>
          <RecordedChargeLinks receiptId={message.receiptId} model={message.modelId}/> {/* J182 */}
        </footer>}
      </section>)}
    </section>)}
  </article>;
}

export default function PrintChat({ chat, lanes, find, busy }) {
  const [model, setModel] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const menu = useRef(null), view = useRef(null);
  const available = lanes.some(lane => lane.messages?.length);
  useEffect(() => {
    const finished = () => {
      setModel(null);
      setPending(false);
      menu.current?.querySelector("summary")?.focus();
    };
    // Some browsers return from print() before the dialog closes. Keep its snapshot until afterprint.
    window.addEventListener("afterprint", finished);
    return () => window.removeEventListener("afterprint", finished);
  }, []);
  async function print() {
    menu.current.open = false;
    setError("");
    setPending(true);
    try {
      flushSync(() => setModel(printChatModel({ chat, lanes, find })));
      await openChatPrint(view.current, window);
    } catch {
      setError("Printing could not open. Try again in your browser.");
      setModel(null);
      setPending(false);
      menu.current?.querySelector("summary")?.focus();
    }
  }
  return <>
    <details ref={menu} className={s.menu} onKeyDown={event => { if (event.key === "Escape") { menu.current.open = false; menu.current.querySelector("summary")?.focus(); } }}>
      <summary>Chat menu</summary>
      <div className={s.actions}><button type="button" className="text-button" disabled={!available || busy || pending} onClick={print}>Print / Save as PDF</button></div>
    </details>
    {error && <span role="alert">{error}</span>}
    {model && createPortal(<PrintChatView model={model} viewRef={view} />, document.body)}
  </>;
}
