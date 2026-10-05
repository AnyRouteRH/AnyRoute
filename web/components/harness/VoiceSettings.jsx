"use client";
import { recognitionNote } from "../../lib/harness-voice";
import s from "./VoiceMode.module.css";

export default function VoiceSettings({ voice }) {
  const active = voice.phase !== "idle";
  const local = ["available", "enforced"].includes(voice.local);
  return <>
    <button type="button" className={s.conversation} aria-pressed={voice.conversation} disabled={!voice.conversation && (!voice.canListen || !voice.synthesis || !voice.canConverse || voice.busy || voice.blocked)} onClick={voice.toggleConversation}>
      <span className={s.switch} aria-hidden="true" /> Conversation
    </button>
    <div className={s.panel}>
      <p>Tap the microphone to start or stop. Hold it, or hold Space while it is focused, for push-to-talk. Your browser may ask for microphone permission. Escape stops voice.</p>
      {!local && voice.supported && voice.local !== "checking" && !voice.allowRemoteRecognition && <p>On-device speech is not ready. Review Voice settings before using the microphone.</p>}
      <p id="harness-voice-note">{voice.local === "checking" ? "Checking browser speech support…" : recognitionNote(voice)}</p>
      <label className={s.language}>Speech language <input key={voice.lang} type="text" defaultValue={voice.lang} disabled={active || voice.local === "checking"} aria-label="Speech language tag" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} onBlur={(event) => { if (event.target.value !== voice.lang) voice.configure({ lang: event.target.value.trim() || "en-US" }); }} /></label>
      {!local && voice.supported && <label className={s.choice}><input type="checkbox" checked={voice.allowRemoteRecognition} disabled={voice.local === "checking"} onChange={(event) => voice.configure({ allowRemoteRecognition: event.target.checked })} /> Allow browser speech service; microphone audio may leave this device</label>}
      {["downloadable", "downloading"].includes(voice.local) && <button type="button" className="text-button" onClick={voice.install}>Download on-device language pack</button>}
      <label className={s.choice}><input type="checkbox" checked={voice.autoSend} onChange={(event) => voice.configure({ autoSend: event.target.checked })} /> Send automatically when an utterance ends</label>
      <label className={s.choice}><input type="checkbox" checked={voice.allowRemoteVoice} onChange={(event) => voice.configure({ allowRemoteVoice: event.target.checked })} /> Allow remote read-aloud voices; answer text may leave this device</label>
      <p>{voice.voiceNote || "Read-aloud prefers voices the browser reports as local. Remote voices require your choice above."}</p>
      <p>Conversation mode sends each completed utterance, reads the answer, then listens again. It needs sign-in and one model. Sending uses your current chat settings and balance. Stop voice ends the loop; Stop in the composer also stops an answer.</p>
      <p>Anyroute receives the transcript when you send it, through the current chat path. The router reads requests in memory except on the encrypted-chat path. Voice choices last for this visit. Transcripts follow your existing chat history settings.</p>
    </div>
  </>;
}
