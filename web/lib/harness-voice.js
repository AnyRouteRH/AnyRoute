// Browser speech only. Audio is never captured or uploaded by this module; the browser's
// chosen recognition/synthesis service can be remote. Consent and transcripts stay in memory.
export const VOICE_DEFAULTS = Object.freeze({ autoSend: false, conversation: false, allowRemoteRecognition: false, allowRemoteVoice: false });

export function recognitionConstructor(env) {
  return env.SpeechRecognition || env.webkitSpeechRecognition || null;
}

export function transcriptOf(results, finalOnly = false) {
  return Array.from(results || []).filter((r) => !finalOnly || r.isFinal).map((r) => r[0]?.transcript?.trim() || "").filter(Boolean).join(" ");
}

export function appendTranscript(base, transcript) {
  return transcript ? `${base}${base && !/\s$/.test(base) ? " " : ""}${transcript}` : base;
}

export function preferredVoice(voices, lang, allowRemote = false) {
  const candidates = Array.from(voices || []).filter((v) => v.localService === true || allowRemote);
  const locale = lang.toLowerCase();
  const rank = (v) => (v.localService === true ? 100 : 0) + (v.lang?.toLowerCase() === locale ? 20 : v.lang?.split("-")[0].toLowerCase() === locale.split("-")[0] ? 10 : 0) + (v.default ? 1 : 0);
  return candidates.sort((a, b) => rank(b) - rank(a))[0] || null;
}

export function recognitionNote(state) {
  if (!state.supported) return "Speech recognition is unavailable in this browser. You can still type.";
  if (state.local === "available") return "On-device recognition is available. The browser is required to process microphone audio on this device.";
  if (state.local === "enforced") return "This browser supports requiring on-device recognition. Starting may fail if its language pack is unavailable; audio will not fall back to a remote service.";
  if (state.local === "checking") return "Checking on-device recognition for this language…";
  if (state.local === "downloadable" || state.local === "downloading") return "On-device recognition needs a browser language pack. Download it below, or explicitly allow the browser speech service.";
  return "This browser cannot confirm on-device recognition for this language. Its speech service may send microphone audio to the browser vendor or another service.";
}

export function speechError(code) {
  return ({
    "not-allowed": "Microphone permission was denied. Allow it in this site's browser permissions, then try again.",
    "service-not-allowed": "The browser blocked its speech service. Check browser permissions or use another browser.",
    "audio-capture": "No microphone is available. Connect one and check browser permissions.",
    "no-speech": "No speech was heard. Tap the microphone to try again.",
    network: "The browser speech service could not connect. Try on-device recognition if available.",
    "language-not-supported": "The selected speech language is unavailable. Choose another language or download its on-device pack.",
    aborted: "Listening was interrupted. Tap the microphone to try again.",
  })[code] || "Speech recognition could not start or continue. Check browser permissions and try again.";
}

/** Injectable browser adapter: no fetch, storage, analytics, or router changes. */
export function createVoiceSession(env, { getDraft, setDraft, send, onChange }) {
  const Recognition = recognitionConstructor(env);
  let state = { ...VOICE_DEFAULTS, supported: !!Recognition && env.isSecureContext !== false, synthesis: !!env.speechSynthesis && !!env.SpeechSynthesisUtterance, lang: env.navigator?.language || "en-US", local: "checking", phase: "idle", speakingId: null, error: "", voiceNote: "Local voices are preferred. Remote voices require your choice below.", canListen: false };
  let context = { busy: false, canSend: false, canConverse: false, reply: null, scope: "" };
  let recognition = null, utterance = null, turn = null, disposed = false, probe = 0;
  let base = "", finals = "", expected = "", failed = false;
  const emit = (patch) => {
    state = { ...state, ...patch };
    state.canListen = state.supported && state.local !== "checking" && (["available", "enforced"].includes(state.local) || state.allowRemoteRecognition);
    if (!disposed) onChange({ ...state });
  };
  const cancelRecognition = () => {
    if (!recognition) return;
    const old = recognition;
    recognition = null;
    old.onstart = old.onresult = old.onerror = old.onend = null;
    try { old.abort(); } catch { /* already ended */ }
    // Remove unfinished recognition without overwriting a manually edited draft.
    if (getDraft() === expected) setDraft(appendTranscript(base, finals));
  };
  const cancelSpeech = () => {
    if (utterance) {
      utterance.onend = utterance.onerror = null;
      utterance = null;
      env.speechSynthesis.cancel();
    }
  };
  function stop(error = "") {
    turn = null;
    cancelRecognition();
    cancelSpeech();
    emit({ conversation: false, phase: "idle", speakingId: null, error });
  }
  async function checkLocal() {
    const current = ++probe;
    emit({ local: "checking" });
    let local = "unavailable";
    try {
      if (state.supported && "processLocally" in new Recognition()) {
        local = typeof Recognition.available === "function" ? await Recognition.available({ langs: [state.lang], processLocally: true }) : "enforced";
      }
    } catch { /* policy or unsupported language: no privacy assumption */ }
    if (!disposed && current === probe) emit({ local });
  }
  function start() {
    if (disposed || recognition || context.busy || context.blocked || env.document?.hidden || turn) return false;
    if (!state.canListen) {
      stop(state.supported ? "Download an on-device pack or allow the browser speech service in Voice settings first." : "Speech recognition is unavailable here. Use a supported browser on a secure page.");
      return false;
    }
    cancelSpeech();
    base = getDraft(); finals = ""; expected = base; failed = false;
    try {
      const current = new Recognition();
      recognition = current;
      current.lang = state.lang;
      current.interimResults = true;
      // One utterance gives auto-send and conversation mode a clear end-of-turn.
      current.continuous = !(state.autoSend || state.conversation);
      if ("processLocally" in current) current.processLocally = state.local === "available" || state.local === "enforced";
      current.onstart = () => { if (recognition === current) emit({ phase: "listening" }); };
      current.onresult = (event) => {
        if (recognition !== current) return;
        finals = transcriptOf(event.results, true);
        expected = appendTranscript(base, transcriptOf(event.results));
        setDraft(expected);
      };
      current.onerror = (event) => {
        if (recognition !== current) return;
        failed = true;
        stop(speechError(event.error));
      };
      current.onend = () => {
        if (recognition !== current) return;
        recognition = null;
        const text = appendTranscript(base, finals);
        if (getDraft() !== expected) return stop("The draft changed. Review it before sending.");
        setDraft(text);
        emit({ phase: "idle" });
        if (!failed && finals && (state.autoSend || state.conversation)) {
          if (!context.canSend || context.busy) return stop("Your transcript is ready. Sign in, select a model, and press Send.");
          turn = { previousId: context.reply?.id, scope: context.scope };
          emit({ phase: "waiting" });
          send(text);
        } else if (state.conversation) stop("No completed speech was heard. Tap Conversation to start again.");
      };
      emit({ phase: "starting", speakingId: null, error: "" });
      current.start();
      return true;
    } catch {
      stop(speechError("start"));
      return false;
    }
  }
  function finishListening() {
    if (!recognition) return;
    emit({ phase: "finishing" });
    try { recognition.stop(); } catch { stop(speechError("aborted")); }
  }
  function speak(id, text, resume = false) {
    if (disposed || !text?.trim()) return false;
    cancelRecognition(); cancelSpeech();
    if (!state.synthesis) { stop("Read-aloud is unavailable in this browser."); return false; }
    const voice = preferredVoice(env.speechSynthesis.getVoices(), state.lang, state.allowRemoteVoice);
    if (!voice) { stop("No local voice is ready. Check your device's speech voices, or allow remote voices in Voice settings."); return false; }
    try {
      const current = new env.SpeechSynthesisUtterance(text);
      utterance = current;
      current.voice = voice;
      current.lang = voice.lang || state.lang;
      current.onend = () => {
        if (utterance !== current) return;
        utterance = null;
        emit({ phase: "idle", speakingId: null });
        if (resume && state.conversation && context.canConverse && !context.busy) start();
      };
      current.onerror = () => { if (utterance === current) stop("The browser could not read this answer. Tap the speaker to try again."); };
      emit({ phase: "speaking", speakingId: id, error: "", voiceNote: voice.localService === true ? `Read-aloud uses ${voice.name}, reported by this browser as a local voice.` : `Read-aloud uses ${voice.name}, a remote voice. Answer text may be sent to its speech service.` });
      env.speechSynthesis.speak(current);
      return true;
    } catch { stop("The browser could not read this answer."); return false; }
  }
  function update(next) {
    const previous = context;
    context = next;
    if ((recognition || utterance || turn || state.conversation) && (previous.scope !== next.scope || next.blocked)) return stop();
    if (state.conversation && !next.canConverse && !next.busy) return stop("Conversation paused. Sign in and select one model to continue.");
    if (next.busy && recognition) cancelRecognition();
    if (next.busy && !turn && (state.phase !== "idle" || state.conversation)) return stop();
    if (!turn || next.busy || !next.reply || next.reply.id === turn.previousId) return;
    const reply = next.reply;
    if (reply.status === "waiting" || reply.status === "streaming") return;
    turn = null;
    if (!state.conversation) return emit({ phase: "idle" });
    if (reply.status !== "done" || reply.error || reply.toolCalls?.length || !reply.text?.trim()) return stop("Conversation paused. Review the answer or tool request before continuing.");
    speak(reply.id, reply.text, true);
  }
  return {
    get: () => state,
    init: checkLocal,
    update,
    stop,
    start,
    finishListening,
    toggle: () => recognition ? finishListening() : (stop(), start()),
    read: (id, text) => { const stopping = state.speakingId === id; stop(); if (!stopping) speak(id, text); },
    conversation: () => {
      if (state.conversation) return stop();
      if (!context.canConverse || context.busy) return stop("Conversation mode needs sign-in and one selected model.");
      emit({ conversation: true });
      start();
    },
    configure: (patch) => { stop(); emit(patch); if (patch.lang) checkLocal(); },
    install: async () => {
      stop();
      if (typeof Recognition?.install !== "function") return emit({ error: "This browser cannot download on-device speech packs here." });
      emit({ local: "checking", error: "" });
      try {
        if (!await Recognition.install({ langs: [state.lang], processLocally: true })) throw new Error();
        if (!disposed) await checkLocal();
      } catch { if (!disposed) emit({ local: "unavailable", error: "The browser could not download this language pack. Choose another language or try again." }); }
    },
    dispose: () => { disposed = true; ++probe; stop(); },
  };
}

/** A short tap toggles; holding starts once and release ends the utterance. */
export function createTalkGesture({ start, finish, toggle, stop, schedule = setTimeout, cancel = clearTimeout }) {
  let timer = null, held = false, suppress = false;
  return {
    down() {
      if (timer !== null) return;
      held = false; suppress = false;
      timer = schedule(() => { timer = null; held = true; start(); }, 250);
    },
    up() { if (timer !== null) cancel(timer); timer = null; if (held) { held = false; suppress = true; finish(); } },
    click() { if (suppress) { suppress = false; return; } toggle(); },
    cancel() { const active = timer !== null || held; if (timer !== null) cancel(timer); timer = null; if (held) stop(); held = false; if (active) suppress = true; },
    dispose() { if (timer !== null) cancel(timer); timer = null; },
  };
}
