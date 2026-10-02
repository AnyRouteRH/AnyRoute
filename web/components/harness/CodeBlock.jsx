"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "../Markdown";
import { CopyButton, highlight } from "../UI";
import { codeLanguage, downloadCode, previewDocument, previewType } from "../../lib/harness-previews";
import s from "./CodeBlock.module.css";

export function PreviewFrame({ lang, text, runScripts = false }) {
  const [markdown, setMarkdown] = useState(null);
  useEffect(() => {
    if (previewType(lang) === "markdown") setMarkdown({ text, markup: renderToStaticMarkup(<Markdown text={text} />) });
  }, [lang, text]);
  const frame = useMemo(() => previewDocument(lang, text, runScripts,
    markdown?.text === text ? markdown.markup : ""), [lang, text, runScripts, markdown]);
  return <iframe className={s.frame} title={`${previewType(lang)} preview`} sandbox={frame.sandbox} srcDoc={frame.srcDoc} referrerPolicy="no-referrer" />;
}

export function PreviewDialog({ children, onClose }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={s.dialog} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className={s.dialogHead}><h2 id={titleId}>Preview</h2><button type="button" className="text-button" autoFocus onClick={onClose}>Close preview</button></div>
    {children}
  </dialog>;
}

export default function CodeBlock({ lang, text }) {
  const [preview, setPreview] = useState(false);
  const [runScripts, setRunScripts] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const id = useId();
  const type = previewType(lang);
  // A changed/streaming reply never inherits permission to execute new scripts.
  const [approvedText, setApprovedText] = useState(null);
  const scripts = runScripts && approvedText === text;
  const toggleScripts = () => { setRunScripts(!scripts); setApprovedText(!scripts ? text : null); };
  const controls = (inDialog = false) => <div className={s.previewBar}>
    {type === "html" && <button type="button" className="text-button" aria-pressed={scripts} onClick={toggleScripts}>Run scripts</button>}
    <span>{scripts ? "Inline scripts on" : "Scripts off"} · External resources blocked</span>
    {!inDialog && <button type="button" className="text-button" onClick={() => setFullScreen(true)}>Open full screen</button>}
  </div>;
  return <div className={s.code}>
    <div className={s.header}>
      <span className={s.language}>{lang || "text"}</span>
      <div className={s.actions}>
        <CopyButton text={text} />
        <button type="button" className="text-button" onClick={() => downloadCode(text, lang)}>Download</button>
        {type && <button type="button" className="text-button" aria-expanded={preview} aria-controls={id} onClick={() => { setPreview(!preview); setRunScripts(false); setApprovedText(null); }}>Preview</button>}
      </div>
    </div>
    <pre tabIndex={0}><code>{/^(js|jsx|ts|tsx|javascript|typescript|json|mjs|cjs)$/.test(codeLanguage(lang)) ? highlight(text) : text}</code></pre>
    {preview && <div id={id} className={s.preview}>
      {controls()}
      {!fullScreen && <><div className={s.resize}><PreviewFrame key={String(scripts)} lang={lang} text={text} runScripts={scripts} /></div><label className={s.height}>Preview height <input type="range" min="160" max="560" defaultValue="320" aria-label="Preview height" onChange={(event) => { event.currentTarget.parentElement.previousElementSibling.style.height = `${event.target.value}px`; }} /></label></>}
    </div>}
    {fullScreen && <PreviewDialog onClose={() => { setFullScreen(false); setRunScripts(false); setApprovedText(null); }}>{controls(true)}<div className={s.fullFrame}><PreviewFrame key={String(scripts)} lang={lang} text={text} runScripts={scripts} /></div></PreviewDialog>}
  </div>;
}
