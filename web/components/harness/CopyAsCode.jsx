"use client";
import { useId, useRef, useState } from "react";
import { API_BASE } from "../../lib/api.js";
import { COPY_CODE_LANGUAGES, copyAsCode } from "../../lib/copy-as-code.js";
import { CopyButton, Modal } from "../UI";
import s from "./CopyAsCode.module.css";

const labels = { curl: "curl", typescript: "TypeScript", python: "Python" };

export default function CopyAsCode({ model, settings, system, messages, headers, apiKey, busy }) {
  const [samples, setSamples] = useState(null);
  const [language, setLanguage] = useState("curl");
  const menu = useRef(null), trigger = useRef(null), tabs = useRef([]);
  const id = useId();
  const close = () => { setSamples(null); trigger.current?.focus(); };
  const open = () => {
    menu.current.open = false;
    setLanguage("curl");
    try { setSamples(copyAsCode({ model, settings, system, messages, headers, apiKey, baseUrl: API_BASE || "https://anyroute.tech" })); }
    catch { setSamples({ error: "The request could not be prepared. Check your settings and try again." }); }
  };
  return <>
    <details ref={menu} className={s.menu} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }} onKeyDown={(event) => { if (event.key === "Escape") { menu.current.open = false; trigger.current?.focus(); } }}>
      <summary ref={trigger} aria-label="Chat menu">More</summary>
      <div className={s.actions}><button type="button" disabled={!model || busy || !messages?.length} onClick={open}>Copy as code</button></div>
    </details>
    {samples && <Modal title="Copy as code" onClose={close}>
      <div className={s.body}>
        <p>Copy the selected conversation and its settings. Set your key outside Chat before running it.</p>
        <p>This includes readable conversation text. The router reads request text in memory when you send it.</p>
        {samples.error ? <p role="alert" className="error">{samples.error}</p> : <>
          {samples.notes.map((note, index) => <p key={index}>{note}</p>)}
          <div className={s.tabs} role="tablist" aria-label="Request language" onKeyDown={(event) => {
            const current = COPY_CODE_LANGUAGES.indexOf(language);
            const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : event.key === "ArrowRight" ? (current + 1) % 3 : event.key === "ArrowLeft" ? (current + 2) % 3 : null;
            if (next === null) return;
            event.preventDefault(); setLanguage(COPY_CODE_LANGUAGES[next]); tabs.current[next]?.focus();
          }}>
            {COPY_CODE_LANGUAGES.map((name, index) => <button ref={(element) => { tabs.current[index] = element; }} key={name} id={`${id}-${name}`} type="button" role="tab" aria-selected={language === name} aria-controls={`${id}-panel`} tabIndex={language === name ? 0 : -1} onClick={() => setLanguage(name)}>{labels[name]}</button>)}
          </div>
          <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${language}`} tabIndex={0} className={s.panel}>
            <CopyButton key={language} text={samples[language]} label="Copy request" />
            <pre tabIndex={0}><code>{samples[language]}</code></pre>
          </div>
          <p>Replies arrive as a stream. These scripts print it when the reply finishes. Uses the key you set outside Chat; temporary Chat limits and one-time approvals are not copied.</p>
        </>}
      </div>
    </Modal>}
  </>;
}
