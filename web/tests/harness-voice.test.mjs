import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTranscript, createTalkGesture, createVoiceSession, preferredVoice, recognitionConstructor, recognitionNote, speechError, transcriptOf, VOICE_DEFAULTS } from '../lib/harness-voice.js';

const localVoice = { name: 'Device voice', lang: 'en-US', localService: true };
const remoteVoice = { name: 'Service voice', lang: 'en-US', localService: false, default: true };
const results = (...parts) => parts.map(([text, final]) => Object.assign([{ transcript: text }], { isFinal: final }));
function fixture({ local = 'available', legacy = false, voices = [remoteVoice, localVoice], availableError = false } = {}) {
  const instances = [], spoken = [], sent = [];
  let draft = '', state, canceled = 0;
  class Recognition {
    constructor() { if (!legacy) this.processLocally = false; instances.push(this); }
    static async available() { if (availableError) throw new Error('policy'); return local; }
    static async install() { local = 'available'; return true; }
    start() { this.started = true; this.onstart?.(); }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
    result(...parts) { this.onresult?.({ results: results(...parts) }); }
    end() { this.onend?.(); }
    error(code) { this.onerror?.({ error: code }); }
  }
  const env = { isSecureContext: true, navigator: { language: 'en-US' }, SpeechRecognition: Recognition,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: { getVoices: () => voices, speak: (utterance) => spoken.push(utterance), cancel: () => { canceled++; } } };
  const session = createVoiceSession(env, { getDraft: () => draft, setDraft: (text) => { draft = text; }, send: (text) => sent.push(text), onChange: (value) => { state = value; } });
  let context = { canSend: true, canConverse: true, busy: false, reply: null, scope: 'one-model', blocked: false };
  session.update(context);
  return { session, env, instances, spoken, sent, get draft() { return draft; }, set draft(value) { draft = value; }, get state() { return state; }, get canceled() { return canceled; }, update(patch) { context = { ...context, ...patch }; session.update(context); }, get recognition() { return instances.at(-1); } };
}

test('voice starts off with no remote-service consent and no storage', async () => {
  const f = fixture(); await f.session.init();
  assert.deepEqual(VOICE_DEFAULTS, { autoSend: false, conversation: false, allowRemoteRecognition: false, allowRemoteVoice: false });
  assert.equal(f.state.phase, 'idle'); assert.equal(f.instances.some((r) => r.started), false);
  assert.equal(recognitionConstructor({ webkitSpeechRecognition: f.env.SpeechRecognition }), f.env.SpeechRecognition);
  assert.equal(recognitionConstructor({}), null);
});

test('unsupported and insecure contexts fail closed without a microphone', async () => {
  for (const env of [{}, { isSecureContext: false, SpeechRecognition: class {} }]) {
    let state;
    const session = createVoiceSession(env, { getDraft: () => '', setDraft() {}, send() { assert.fail(); }, onChange: (s) => { state = s; } });
    await session.init(); assert.equal(session.start(), false); assert.equal(state.supported, false); assert.match(recognitionNote(state), /unavailable/);
  }
});

test('local recognition is enforced and interim text is replaced, never duplicated', async () => {
  const f = fixture(); await f.session.init(); f.draft = 'Existing draft';
  f.session.start(); const r = f.recognition; assert.equal(r.processLocally, true);
  assert.equal(r.interimResults, true); assert.equal(r.continuous, true);
  r.result(['hello', false]); assert.equal(f.draft, 'Existing draft hello');
  r.result(['hello world', true], ['next', false]); assert.equal(f.draft, 'Existing draft hello world next');
  r.result(['hello world', true], ['next phrase', true]); r.end();
  assert.equal(f.draft, 'Existing draft hello world next phrase'); assert.deepEqual(f.sent, []);
  assert.equal(appendTranscript('Line\n', 'Words'), 'Line\nWords');
  assert.equal(transcriptOf(results(['one', true], ['two', false]), true), 'one');
});

test('legacy recognition requires explicit consent and never implies local processing', async () => {
  const f = fixture({ legacy: true }); await f.session.init();
  assert.equal(f.session.start(), false); assert.match(recognitionNote(f.state), /may send microphone audio/);
  f.session.configure({ allowRemoteRecognition: true }); assert.equal(f.session.start(), true);
  assert.equal('processLocally' in f.recognition, false);
});

test('missing language packs and rejected capability queries never silently choose remote', async () => {
  for (const options of [{ local: 'downloadable' }, { local: 'unavailable' }, { availableError: true }]) {
    const f = fixture(options); await f.session.init(); assert.equal(f.session.start(), false);
    f.session.configure({ allowRemoteRecognition: true }); assert.equal(f.session.start(), true); assert.equal(f.recognition.processLocally, false);
  }
  const f = fixture({ local: 'downloadable' }); await f.session.init(); await f.session.install();
  assert.equal(f.state.local, 'available'); assert.equal(f.session.start(), true); assert.equal(f.recognition.processLocally, true);
});

test('local-only support without a capability query still enforces processLocally', async () => {
  const f = fixture(); f.env.SpeechRecognition.available = undefined; await f.session.init();
  assert.equal(f.state.local, 'enforced'); assert.match(recognitionNote(f.state), /will not fall back/);
  assert.equal(f.session.start(), true); assert.equal(f.recognition.processLocally, true);
});

test('stop removes unfinished words and disables the loop without sending', async () => {
  const f = fixture(); await f.session.init(); f.session.configure({ autoSend: true }); f.session.start();
  const r = f.recognition; r.result(['final words', true], ['unfinished', false]); f.session.stop(); r.end();
  assert.equal(r.aborted, true); assert.equal(f.draft, 'final words'); assert.deepEqual(f.sent, []); assert.equal(f.state.conversation, false);
});

test('permission and service failures preserve completed words without auto-send or retry', async () => {
  for (const code of ['not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'no-speech', 'language-not-supported', 'aborted', 'unknown']) {
    const f = fixture(); await f.session.init(); f.session.configure({ autoSend: true }); f.session.start();
    const r = f.recognition; r.result(['keep these', true], ['unfinished', false]); r.error(code); r.end();
    assert.equal(f.draft, 'keep these'); assert.deepEqual(f.sent, []); assert.equal(f.state.error, speechError(code)); assert.equal(f.state.phase, 'idle');
  }
});

test('auto-send uses completed text once, and waits for the answer', async () => {
  const f = fixture(); await f.session.init(); f.draft = 'Question:'; f.session.configure({ autoSend: true }); f.session.start();
  const r = f.recognition; assert.equal(r.continuous, false); r.result(['how does it work?', true], ['unfinished', false]);
  f.session.finishListening(); assert.equal(r.stopped, true); r.end(); r.end();
  assert.deepEqual(f.sent, ['Question: how does it work?']); assert.equal(f.state.phase, 'waiting');
  f.update({ reply: { id: 'reply-1', status: 'done', text: 'Answer' } }); assert.equal(f.state.phase, 'idle'); assert.equal(f.spoken.length, 0);
});

test('auto-send keeps the draft if sign-in or model selection is needed', async () => {
  const f = fixture(); await f.session.init(); f.update({ canSend: false, canConverse: false }); f.session.configure({ autoSend: true }); f.session.start();
  f.recognition.result(['Review me', true]); f.recognition.end(); assert.equal(f.draft, 'Review me'); assert.deepEqual(f.sent, []); assert.match(f.state.error, /Sign in/);
});

test('conversation listens, sends, awaits completion, reads locally, then listens again', async () => {
  const f = fixture(); await f.session.init(); f.session.conversation(); const first = f.recognition;
  first.result(['Question', true]); first.end(); assert.deepEqual(f.sent, ['Question']); f.draft = '';
  f.update({ busy: true, reply: { id: 'answer', status: 'streaming', text: 'Partial' } }); assert.equal(f.spoken.length, 0);
  f.update({ busy: false, reply: { id: 'answer', status: 'done', text: 'Full answer' } });
  assert.equal(f.state.phase, 'speaking'); assert.equal(f.spoken[0].voice, localVoice); assert.equal(f.spoken[0].text, 'Full answer');
  f.spoken[0].onend(); assert.equal(f.state.phase, 'listening'); assert.notEqual(f.recognition, first);
  f.session.stop(); assert.equal(f.recognition.aborted, true);
});

test('conversation pauses for failed, stopped, empty and tool answers', async () => {
  for (const reply of [{ status: 'error', error: 'Failed' }, { status: 'stopped', text: 'Partial' }, { status: 'done', text: '' }, { status: 'done', text: 'Tools', toolCalls: [{}] }]) {
    const f = fixture(); await f.session.init(); f.session.conversation(); f.recognition.result(['Question', true]); f.recognition.end();
    f.update({ reply: { id: 'answer', ...reply } }); assert.equal(f.state.conversation, false); assert.equal(f.spoken.length, 0); assert.match(f.state.error, /paused/);
  }
});

test('model, lane, dialog and manual request changes cancel listening without sending', async () => {
  for (const patch of [{ scope: 'another-model' }, { blocked: true }, { busy: true }]) {
    const f = fixture(); await f.session.init(); f.session.start(); const r = f.recognition; r.result(['Question', true]);
    f.update(patch); r.end(); assert.equal(r.aborted, true); assert.deepEqual(f.sent, []); assert.equal(f.state.phase, 'idle');
  }
});

test('manual draft edits survive a late recognition end', async () => {
  const f = fixture(); await f.session.init(); f.session.start(); f.recognition.result(['spoken', true]); f.draft = 'Typed instead'; f.recognition.end();
  assert.equal(f.draft, 'Typed instead'); assert.deepEqual(f.sent, []);
});

test('delayed hold cannot restart behind a dialog, during a request or while awaiting its answer', async () => {
  for (const patch of [{ blocked: true }, { busy: true }]) {
    const f = fixture(); await f.session.init(); f.update(patch);
    assert.equal(f.session.start(), false); assert.equal(f.instances.some((r) => r.started), false);
  }
  const hidden = fixture(); await hidden.session.init(); hidden.env.document = { hidden: true };
  assert.equal(hidden.session.start(), false); assert.equal(hidden.instances.some((r) => r.started), false);
  const f = fixture(); await f.session.init(); f.session.configure({ autoSend: true }); f.session.start();
  f.recognition.result(['Question', true]); f.recognition.end();
  assert.equal(f.session.start(), false); assert.deepEqual(f.sent, ['Question']);
});

test('read-aloud prefers local voices across languages and requires consent for remote or unknown voices', async () => {
  assert.equal(preferredVoice([remoteVoice, { ...localVoice, lang: 'fr-FR' }], 'en-US').localService, true);
  assert.equal(preferredVoice([remoteVoice, { name: 'Unknown', lang: 'en-US' }], 'en-US'), null);
  const f = fixture({ voices: [remoteVoice] }); await f.session.init(); f.session.read('reply', 'Answer'); assert.equal(f.spoken.length, 0); assert.match(f.state.error, /No local voice/);
  f.session.configure({ allowRemoteVoice: true }); f.session.read('reply', 'Answer'); assert.equal(f.spoken.length, 1); assert.match(f.state.voiceNote, /remote voice/);
  f.session.read('reply', 'Answer'); assert.equal(f.state.speakingId, null); assert.equal(f.canceled, 1);
});

test('switching speakers, synthesis failure and disposal stop playback and prevent a loop', async () => {
  const f = fixture(); await f.session.init(); f.session.read('one', 'First'); const first = f.spoken[0]; f.session.read('two', 'Second');
  assert.equal(first.onend, null); assert.equal(f.state.speakingId, 'two'); f.spoken[1].onerror(); assert.equal(f.state.phase, 'idle'); assert.equal(f.state.conversation, false);
  f.session.conversation(); const r = f.recognition; f.session.dispose(); r.result(['late', true]); r.end(); assert.deepEqual(f.sent, []);
});

test('push-to-talk distinguishes taps, holds, keyboard clicks and cancellation', () => {
  const calls = []; let scheduled;
  const gesture = createTalkGesture({ start: () => calls.push('start'), finish: () => calls.push('finish'), toggle: () => calls.push('toggle'), stop: () => calls.push('stop'), schedule: (fn) => { scheduled = fn; return 1; }, cancel: () => { scheduled = null; } });
  gesture.down(); gesture.up(); gesture.click(); assert.deepEqual(calls, ['toggle']);
  gesture.down(); scheduled(); gesture.up(); gesture.up(); gesture.click(); assert.deepEqual(calls, ['toggle', 'start', 'finish']);
  gesture.cancel(); gesture.click(); assert.equal(calls.at(-1), 'toggle');
  gesture.down(); scheduled(); gesture.cancel(); gesture.click(); assert.equal(calls.at(-1), 'stop');
  gesture.down(); gesture.dispose(); assert.equal(scheduled, null);
});
