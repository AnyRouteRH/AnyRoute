import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPortal } from 'react-dom';
import * as composer from '../lib/harness-composer.js';
import * as speech from '../lib/harness-voice.js';
import { attachmentKind } from '../lib/harness.js';
import { IMAGE_ACCEPT } from '../lib/harness-images.js';

// Use the existing Bun JSX compiler, as other rendered web checks do.
function components(file, names, bindings = {}) {
  const input = readFileSync(new URL(`../components/harness/${file}.jsx`, import.meta.url), 'utf8');
  const output = execFileSync('bun', ['-e', 'process.stdout.write(new Bun.Transpiler({loader:"jsx",target:"node",tsconfig:{compilerOptions:{jsx:"react",jsxFactory:"React.createElement",jsxFragmentFactory:"React.Fragment"}}}).transformSync(await Bun.stdin.text()));'], { input, encoding: 'utf8' });
  const scope = { React, useEffect: React.useEffect, useLayoutEffect: React.useLayoutEffect, useMemo: React.useMemo, useRef: React.useRef, useState: React.useState, useId: React.useId, s: new Proxy({}, { get: (_target, key) => key }), v: {}, ...bindings };
  return new Function(...Object.keys(scope), output.replace(/^import .*;\n/gm, '').replace(/export default function /g, 'function ').replace(/export function /g, 'function ') + `\nreturn {${names.join(',')}};`)(...Object.values(scope));
}
const { ImageAttach, ImageNotice } = components('ImageAttachments', ['ImageAttach', 'ImageNotice'], { ...composer, IMAGE_ACCEPT });
const { VoiceSettings } = components('VoiceSettings', ['VoiceSettings'], speech);
const { VoiceMic } = components('VoiceMode', ['VoiceMic'], speech);
const { ComposerVoice, VoiceFeedback } = components('ComposerVoice', ['ComposerVoice', 'VoiceFeedback'], { ...composer, VoiceMic, VoiceSettings, createPortal });
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const image = { kind: 'image' }, document = { kind: 'file' };
const voice = { ...speech.VOICE_DEFAULTS, phase: 'idle', supported: true, synthesis: true, canListen: false, local: 'unavailable', lang: 'en-US', error: '', configure() {}, stop() {} };

test('image notes are absent for an empty or document-only composer, even with text-only models', () => {
  for (const enabled of [false, true]) for (const files of [[], [document]]) {
    assert.equal(render(ImageNotice, { files, enabled, available: false, error: 'Switch to a vision model' }), '');
  }
  const attach = render(ImageAttach, { enabled: false, attached: false });
  assert.match(attach, /aria-label="Attach images"/);
  assert.ok(attach.includes(`aria-description="${composer.IMAGE_PRIVACY_NOTE}"`));
  assert.doesNotMatch(attach, /must accept image input|Switch to a vision model/);
});

test('attached and preparing images show the device note; incompatibility requires an attached image', () => {
  const ready = render(ImageNotice, { files: [image], enabled: true });
  assert.ok(ready.includes(composer.IMAGE_PRIVACY_NOTE));
  assert.doesNotMatch(ready, /vision model|must accept image/);
  const preparing = render(ImageNotice, { files: [], preparing: true, enabled: false, available: false });
  assert.match(preparing, /Preparing images/);
  assert.ok(preparing.includes(composer.IMAGE_PRIVACY_NOTE));
  assert.doesNotMatch(preparing, /vision model|must accept image/);
  const incompatible = render(ImageNotice, { files: [image], enabled: false, available: true });
  assert.match(incompatible, /Every selected model must accept image input/);
  assert.match(incompatible, /<button[^>]*>Switch to a vision model/);
  const unavailable = render(ImageNotice, { files: [image], enabled: false, available: false });
  assert.match(unavailable, /No vision model is available in this catalogue/);
  assert.match(render(ImageNotice, { files: [image], enabled: false, error: 'This model does not accept image input.' }), /This model does not accept image input/);
});

test('preparation visibility excludes documents and remains visible until overlapping image selections finish', () => {
  const states = [];
  const track = composer.createImagePreparationTracker((file) => attachmentKind(file.type, file.name) === 'image', (value) => states.push(value));
  const doneDoc = track([{ type: 'application/pdf', name: 'map.pdf' }]);
  assert.deepEqual(states, []);
  const doneFirst = track([{ type: 'image/png', name: 'map.png' }]);
  const doneSecond = track([{ type: 'image/jpeg', name: 'map.jpg' }]);
  doneDoc(); doneFirst();
  assert.deepEqual(states, [true, true]);
  doneSecond();
  assert.deepEqual(states, [true, true, false]);
});

test('voice starts with a collapsed accessible chevron and no settings or browser warnings', () => {
  for (const state of [voice, { ...voice, supported: false }, { ...voice, local: 'checking' }, { ...voice, local: 'available', canListen: true }]) {
    const html = render(ComposerVoice, { voice: state });
    assert.match(html, /aria-label="Voice settings"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"/);
    assert.doesNotMatch(html, /Conversation|On-device speech|microphone audio may|role="dialog"|harness-voice-note/);
    assert.equal(render(VoiceFeedback, { voice: state }), '');
  }
});

test('mic activation opens settings when recognition needs consent, and preserves ready mic gestures', () => {
  const { VoiceMic: InteractiveMic } = components('VoiceMode', ['VoiceMic'], { ...speech, useMemo: (fn) => fn(), useEffect() {} });
  let opened = 0, toggled = 0;
  for (const supported of [true, false]) {
    const mic = InteractiveMic({ voice: { ...voice, supported }, onRequestSettings: () => { opened++; } });
    assert.equal(mic.props.disabled, false);
    mic.props.onPointerDown({ button: 0, currentTarget: { setPointerCapture() { assert.fail('unavailable speech must not capture or start'); } } });
    mic.props.onClick();
  }
  assert.equal(opened, 2);
  const ready = InteractiveMic({ voice: { ...voice, canListen: true, toggle: () => { toggled++; } }, onRequestSettings: () => { opened++; } });
  ready.props.onClick();
  assert.equal(toggled, 1);
  assert.equal(opened, 2);
  assert.equal(InteractiveMic({ voice: { ...voice, busy: true } }).props.disabled, true);
});

test('opened voice settings retain consent, conversation, read-aloud and accurate browser-specific notes', () => {
  const html = render(VoiceSettings, { voice });
  for (const text of ['Conversation', 'On-device speech is not ready', 'microphone audio may leave this device', 'answer text may leave this device', 'router reads requests in memory except on the encrypted-chat path', 'Voice choices last for this visit']) assert.ok(html.includes(text), text);
  const local = render(VoiceSettings, { voice: { ...voice, local: 'available', canListen: true } });
  assert.match(local, /On-device recognition is available/);
  assert.doesNotMatch(local, /On-device speech is not ready|Allow browser speech service/);
  const unsupported = render(VoiceSettings, { voice: { ...voice, supported: false } });
  assert.match(unsupported, /Speech recognition is unavailable in this browser/);
  assert.doesNotMatch(unsupported, /Allow browser speech service|On-device speech is not ready/);
  const consented = render(VoiceSettings, { voice: { ...voice, allowRemoteRecognition: true } });
  assert.doesNotMatch(consented, /On-device speech is not ready/);
  assert.match(consented, /may send microphone audio/);
  assert.match(render(VoiceSettings, { voice: { ...voice, local: 'downloadable' } }), /Download on-device language pack/);
});

test('active voice status and errors remain available under the composer', () => {
  for (const phase of ['starting', 'listening', 'finishing', 'waiting', 'speaking']) {
    const html = render(VoiceFeedback, { voice: { ...voice, phase } });
    assert.match(html, /role="status"/);
    assert.match(html, /Stop voice/);
    assert.ok(html.includes(composer.voiceStatus(phase)));
  }
  assert.match(render(VoiceFeedback, { voice: { ...voice, error: 'Microphone permission was denied.' } }), /role="alert"[^>]*>Microphone permission was denied/);
});

test('Escape restores focus through the close callback; outside clicks and tabbing away dismiss without moving focus', () => {
  const listeners = new Map(), closes = [];
  const doc = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name, fn) => { assert.equal(listeners.get(name), fn); listeners.delete(name); } };
  const panel = { contains: (target) => target === 'setting' };
  const trigger = { contains: (target) => target === 'chevron' };
  const unbind = composer.bindVoiceMenuDismissal(doc, panel, trigger, (restore) => closes.push(restore));
  listeners.get('pointerdown')({ target: 'setting' });
  listeners.get('focusin')({ target: 'chevron' });
  assert.deepEqual(closes, []);
  listeners.get('pointerdown')({ target: 'outside' });
  listeners.get('focusin')({ target: 'next-control' });
  let prevented = false;
  listeners.get('keydown')({ key: 'Enter' });
  listeners.get('keydown')({ key: 'Escape', preventDefault: () => { prevented = true; } });
  assert.deepEqual(closes, [false, false, true]);
  assert.equal(prevented, true);
  unbind(); assert.equal(listeners.size, 0);
});

test('voice popover stays inside desktop and mobile widths and scrolls above the composer', () => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 667 }, { width: 375, height: 360 }]) {
    const rect = { right: viewport.width - 100, top: viewport.height - 90 };
    const position = composer.voiceMenuPosition(rect, viewport);
    assert.ok(position.left >= 12);
    assert.ok(position.left + position.width <= viewport.width - 12);
    assert.ok(viewport.height - position.bottom - position.maxHeight >= 12);
    assert.equal(viewport.height - position.bottom, rect.top - 8);
  }
});

test('Harness uses only the contextual image notice and voice menu insertion points', () => {
  const source = readFileSync(new URL('../components/Harness.jsx', import.meta.url), 'utf8');
  assert.match(source, /<ImageNotice files={files} enabled={acceptsImages} preparing={preparingImages}/);
  assert.match(source, /<ComposerVoice voice={voice} \/>/);
  assert.match(source, /<VoiceFeedback voice={voice} \/>/);
  assert.doesNotMatch(source, /<VoiceControls/);
});
