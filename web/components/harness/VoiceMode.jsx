"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { createTalkGesture, createVoiceSession, recognitionNote, VOICE_DEFAULTS } from "../../lib/harness-voice";
import s from "./VoiceMode.module.css";

export function useHarnessVoice(props) {
  const latest = useRef(props);
  latest.current = props;
  const session = useRef(null);
  const [state, setState] = useState({ ...VOICE_DEFAULTS, supported: false, synthesis: false, local: "checking", lang: "en-US", phase: "idle", speakingId: null, error: "", canListen: false });
  useEffect(() => {
    const controller = createVoiceSession(window, {
      getDraft: () => latest.current.draft,
      setDraft: (text) => { latest.current = { ...latest.current, draft: text }; latest.current.setDraft(text); },
      send: (text) => latest.current.onSend(text),
      onChange: setState,
    });
    session.current = controller;
    controller.update(latest.current);
    controller.init();
    const hide = () => { if (document.hidden) controller.stop(); };
    const leave = () => controller.stop();
    const escape = (event) => { if (event.key === "Escape") controller.stop(); };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", leave);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("keydown", escape);
      controller.dispose();
      session.current = null;
    };
  }, []);
  useEffect(() => { session.current?.update(props); }, [props.busy, props.canSend, props.canConverse, props.reply, props.scope, props.blocked]);
  const actions = useMemo(() => ({
    start: () => session.current?.start(),
    finish: () => session.current?.finishListening(),
    toggle: () => session.current?.toggle(),
    stop: () => session.current?.stop(),
    toggleConversation: () => session.current?.conversation(),
    configure: (patch) => session.current?.configure(patch),
    install: () => session.current?.install(),
    read: (id, text) => session.current?.read(id, text),
    editDraft: (text) => { session.current?.stop(); latest.current.setDraft(text); },
  }), []);
  return { ...state, ...actions, busy: props.busy, canConverse: props.canConverse, blocked: props.blocked };
}

function MicIcon() {
  return <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="7" y="2" width="6" height="10" rx="3" /><path d="M4 9v1a6 6 0 0 0 12 0V9M10 16v3M7 19h6" /></svg>;
}

function SpeakerIcon() {
  return <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 7h4l4-4v14l-4-4H3zM14 7a5 5 0 0 1 0 6M16 4a9 9 0 0 1 0 12" /></svg>;
}

export function VoiceMic({ voice }) {
  const gesture = useMemo(() => createTalkGesture(voice), [voice.start, voice.finish, voice.toggle]);
  useEffect(() => () => gesture.dispose(), [gesture]);
  const listening = ["starting", "listening", "finishing"].includes(voice.phase);
  const disabled = !voice.supported || voice.busy || voice.blocked || voice.phase === "finishing" || voice.phase === "waiting";
  const label = listening ? "Stop listening" : "Microphone: tap to toggle or hold to talk";
  return <button type="button" className={s.mic} disabled={disabled} aria-label={label} aria-pressed={listening} aria-describedby="harness-voice-note" title={label}
    onPointerDown={(event) => { if (event.button !== 0 || listening) return; event.currentTarget.setPointerCapture(event.pointerId); gesture.down(); }}
    onPointerUp={() => gesture.up()} onPointerCancel={() => gesture.cancel()} onLostPointerCapture={() => gesture.up()} onContextMenu={(event) => event.preventDefault()}
    onKeyDown={(event) => { if (event.key === " " && !event.repeat && !listening) gesture.down(); }}
    onKeyUp={(event) => { if (event.key === " ") gesture.up(); }} onBlur={() => gesture.cancel()} onClick={() => gesture.click()}>
    <MicIcon />
  </button>;
}

export function VoiceControls({ voice }) {
  const active = voice.phase !== "idle";
  const local = ["available", "enforced"].includes(voice.local);
  return <div className={s.controls}>
    <div className={s.row}>
      <button type="button" className={s.conversation} aria-pressed={voice.conversation} disabled={!voice.conversation && (!voice.canListen || !voice.synthesis || !voice.canConverse || voice.busy || voice.blocked)} onClick={voice.toggleConversation}>
        <span className={s.switch} aria-hidden="true" /> Conversation
      </button>
      {active && <button type="button" className={s.stop} onClick={voice.stop}>Stop voice</button>}
      <span className={s.status} role="status">{({ starting: "Waiting for microphone permission…", listening: "Listening…", finishing: "Finishing transcript…", waiting: "Waiting for answer…", speaking: "Reading aloud…" })[voice.phase] || ""}</span>
    </div>
    <details className={s.settings}>
      <summary>Voice settings</summary>
      <div className={s.panel}>
        <p>Tap the microphone to start or stop. Hold it, or hold Space while it is focused, for push-to-talk. Your browser may ask for microphone permission. Escape stops voice.</p>
        <p id="harness-voice-note">{voice.local === "checking" ? "Checking browser speech support…" : recognitionNote(voice)}</p>
        <label className={s.language}>Speech language <input key={voice.lang} type="text" defaultValue={voice.lang} disabled={active || voice.local === "checking"} aria-label="Speech language tag" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} onBlur={(event) => { if (event.target.value !== voice.lang) voice.configure({ lang: event.target.value.trim() || "en-US" }); }} /></label>
        {!local && voice.supported && <label className={s.choice}><input type="checkbox" checked={voice.allowRemoteRecognition} disabled={voice.local === "checking"} onChange={(event) => voice.configure({ allowRemoteRecognition: event.target.checked })} /> Allow browser speech service; microphone audio may leave this device</label>}
        {["downloadable", "downloading"].includes(voice.local) && <button type="button" className="text-button" onClick={voice.install}>Download on-device language pack</button>}
        <label className={s.choice}><input type="checkbox" checked={voice.autoSend} onChange={(event) => voice.configure({ autoSend: event.target.checked })} /> Send automatically when an utterance ends</label>
        <label className={s.choice}><input type="checkbox" checked={voice.allowRemoteVoice} onChange={(event) => voice.configure({ allowRemoteVoice: event.target.checked })} /> Allow remote read-aloud voices; answer text may leave this device</label>
        <p>{voice.voiceNote || "Read-aloud prefers voices the browser reports as local. Remote voices require your choice above."}</p>
        <p>Conversation mode sends each completed utterance, reads the answer, then listens again. It needs sign-in and one model. Sending uses your current chat settings and balance. Stop voice ends the loop; Stop in the composer also stops an answer.</p>
        <p>AnyRoute receives the transcript when you send it, through the current chat path. The router reads requests in memory except on the encrypted-chat path. Voice choices last for this visit. Transcripts follow your existing chat history settings.</p>
      </div>
    </details>
    {!local && voice.local !== "checking" && <p className={s.note}>{voice.supported ? "On-device speech is not ready. Review Voice settings before using the microphone." : "Speech recognition is unavailable in this browser."}</p>}
    {voice.error && <p className={s.error} role="alert">{voice.error}</p>}
  </div>;
}

export function ReadAloud({ msg, voice }) {
  if (!msg.text || ["waiting", "streaming"].includes(msg.status)) return null;
  const reading = voice.speakingId === msg.id;
  return <button type="button" className={s.speaker} disabled={!voice.synthesis} aria-pressed={reading} title={!voice.synthesis ? "Read-aloud is unavailable in this browser" : undefined} aria-label={reading ? "Stop reading answer" : "Read answer aloud"} onClick={(event) => { event.stopPropagation(); voice.read(msg.id, msg.text); }}><SpeakerIcon />{reading ? "Stop" : "Read aloud"}</button>;
}
