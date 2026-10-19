"use client";
// H175
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ASK_SHORTCUT, bindAskAboutThis } from "../../lib/ask-about-this.js";
import s from "./AskAboutThis.module.css";
import { useShortcutLabel } from '../shortcuts/ShortcutKeys'; // K193

export function AskAboutReply({ children }) {
  return <div data-ask-about-reply>{children}</div>;
}

export function AskAboutButton({ position, onAsk }) {
  const keys = useShortcutLabel('chat-ask'); // K193
  if (!position) return null;
  return <button type="button" className={s.action} style={position} aria-label="Ask about selected text" aria-keyshortcuts={ASK_SHORTCUT} title={`Ask about this (${keys})`} onPointerDown={event => event.preventDefault()} onClick={onAsk}>Ask about this</button>;
}

export default function AskAboutThis({ input, setDraft, scope, blocked }) {
  const [position, setPosition] = useState(null);
  const control = useRef(null);
  useEffect(() => {
    setPosition(null);
    const composer = input.current;
    if (blocked || !composer) return;
    control.current = bindAskAboutThis({ document, window, root: composer.closest('[data-harness-app]'), input: composer, setDraft, onChange: setPosition });
    return () => { control.current?.dispose(); control.current = null; };
  }, [input, setDraft, scope, blocked]);
  return position && createPortal(<AskAboutButton position={position} onAsk={() => control.current?.ask()} />, document.body);
}
