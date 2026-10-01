"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { bindVoiceMenuDismissal, voiceMenuPosition, voiceStatus } from "../../lib/harness-composer";
import { VoiceMic } from "./VoiceMode";
import VoiceSettings from "./VoiceSettings";
import s from "./ComposerVoice.module.css";
import v from "./VoiceMode.module.css";

export default function ComposerVoice({ voice }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const trigger = useRef(null);
  const panel = useRef(null);
  const id = useId();
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  useEffect(() => { if (voice.blocked) setOpen(false); }, [voice.blocked]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => setPosition(voiceMenuPosition(trigger.current.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }));
    place();
    panel.current.querySelector("button").focus();
    const unbind = bindVoiceMenuDismissal(document, panel.current, trigger.current, close);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      unbind();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [open]);
  return <div className={s.tools}>
    <VoiceMic voice={voice} onRequestSettings={() => setOpen(true)} />
    <button ref={trigger} type="button" className={s.chevron} aria-label="Voice settings" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={voice.blocked} onClick={() => open ? close(true) : setOpen(true)}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-label="Voice settings" className={s.menu} style={{ ...position, visibility: position ? "visible" : "hidden" }}>
      <div className={s.heading}><span>Voice settings</span><button type="button" aria-label="Close voice settings" onClick={() => close(true)}>×</button></div>
      <VoiceSettings voice={voice} />
    </div>, document.body)}
  </div>;
}

export function VoiceFeedback({ voice }) {
  const status = voiceStatus(voice.phase);
  if (!status && !voice.error) return null;
  return <div className={v.controls}>
    {status && <div className={v.row}>
      <button type="button" className={v.stop} onClick={voice.stop}>Stop voice</button>
      <span className={v.status} role="status">{status}</span>
    </div>}
    {voice.error && <p className={v.error} role="alert">{voice.error}</p>}
  </div>;
}
