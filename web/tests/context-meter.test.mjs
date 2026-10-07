import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as harness from '../lib/harness.js';
import * as context from '../lib/context-meter.js';
import { formatUsd, receiptHref } from '../lib/arena.js';
const model = harness.normalizeModel({ id: 'sample/model', context_length: 128000, architecture: { output_modalities: ['text'] }, supported_parameters: ['max_tokens', 'stream'] });
const user = text => ({ role: 'user', text });
const reply = (input, output, extra = {}) => ({ role: 'assistant', text: 'answer', model: model.id, contextSystem: '', usage: { prompt_tokens: input, completion_tokens: output }, ...extra });
const meter = options => context.contextMeter({ model, ...options });

function loadComponent(bindings = {}) {
  const source = readFileSync(new URL('../components/harness/ContextMeter.jsx', import.meta.url), 'utf8');
  const output = execFileSync('bun', ['-e', 'process.stdout.write(new Bun.Transpiler({loader:"jsx",target:"node",tsconfig:{compilerOptions:{jsx:"react",jsxFactory:"React.createElement",jsxFragmentFactory:"React.Fragment"}}}).transformSync(await Bun.stdin.text()));'], { input: source, encoding: 'utf8' });
  const scope = { React, useState: React.useState, useRef: React.useRef, useEffect: React.useEffect, ...harness, ...context, formatUsd, receiptHref, ReplyApproval: () => null, s: new Proxy({}, { get: (_, key) => key }), ...bindings };
  return new Function(...Object.keys(scope), output.replace(/^import .*;\n/gm, '').replace(/export default function /g, 'function ').replace(/export function /g, 'function ') + '\nreturn { ContextMeter, useContextMeter };')(...Object.values(scope));
}

test('counts system, history, file text and draft with rounded-up estimates', () => {
  assert.equal(context.textTokens('12345'), 2);
  assert.equal(meter({ system: '12345', messages: [user('12345')], draft: '12345', attachments: [{ kind: 'file', text: '12345' }] }).tokens, 26);
  assert.equal(context.attachmentTokens({ kind: 'file', url: 'data:text/plain;base64,' + btoa('12345') }).tokens, 2);
  assert.equal(context.attachmentTokens({ kind: 'file', url: 'data:application/json,%7B%7D' }).tokens, 1);
  assert.equal(context.attachmentTokens({ kind: 'file', size: 100, url: 'data:application/pdf;base64,AA==' }).tokens, 25);
  assert.equal(context.attachmentTokens({ kind: 'image' }).uncertain, true);
  assert.equal(meter({}).about, true);
});

test('uses cumulative prompt counts once and returned output counts including receipt fallback', () => {
  assert.equal(meter({ messages: [user('hi'), reply(100, 20), user('next'), reply(200, 30)] }).tokens, 236);
  assert.equal(meter({ messages: [user('hi'), reply(100, 20), user('next')], draft: 'draft' }).tokens, 141);
  assert.equal(meter({ messages: [reply(100, 20, { usage: null, receipt: { payload: { tokens: { prompt: 100, completion: 20 } } } })] }).tokens, 126);
  // A changed system prompt or model cannot reuse that prompt baseline.
  assert.equal(meter({ system: 'new', messages: [reply(1000, 20)] }).tokens, 33);
  assert.equal(meter({ model: { ...model, id: 'sample/other' }, messages: [reply(1000, 20)] }).tokens, 26);
});

test('thresholds and model switches recompute from the same conversation', () => {
  const messages = [user('x'.repeat(314))]; // 85 tokens including message overhead.
  assert.equal(meter({ model: { ...model, context: 200 }, messages }).state, 'ready');
  assert.equal(meter({ model: { ...model, context: 100 }, messages }).state, 'warning');
  assert.equal(meter({ model: { ...model, context: 85 }, messages }).blocked, true);
  assert.equal(meter({ model: { ...model, context: 86 }, messages }).percent, 98);
  assert.equal(meter({ messages: [user('x'.repeat(511968))] }).percent, 99);
  assert.equal(meter({ model: { ...model, context: 0 }, messages }).state, 'unknown');
});

test('all lanes and edited-turn truncation share the send guard', () => {
  const lanes = [{ modelId: 'small', messages: [user('x'.repeat(400))] }, { modelId: 'large', messages: [] }];
  const find = id => ({ ...model, context: id === 'small' ? 100 : 128000 });
  assert.equal(context.contextSendBlock(lanes, find, '', 'hello'), context.CONTEXT_FULL);
  assert.equal(context.contextSendBlock(lanes, find, '', 'hello', [], 0), '');
});

test('summary uses same model, reserves output, retains attachments and seeds a fresh user message', () => {
  const messages = [user('hello'), reply(10, 4)];
  const request = context.summaryRequest(model, messages, 'Be concise');
  assert.equal(request.body.model, model.id);
  assert.equal(request.body.max_tokens, 2048);
  assert.equal(request.body.messages[0].content, 'Be concise');
  assert.equal(request.body.messages.at(-1).content, context.SUMMARY_PROMPT);
  assert.equal(request.omitted, 0);
  assert.equal(request.body.tools, undefined);
  const seed = context.summarySeed('  goals and decisions  ', model.id, 'sample-id');
  assert.equal(seed.modelId, model.id);
  assert.equal(seed.messages.length, 1);
  assert.equal(seed.messages[0].role, 'user');
  assert.match(seed.messages[0].text, /goals and decisions$/);
  assert.throws(() => context.summarySeed('', model.id, 'sample-id'), /no summary/);
});

test('full summary inputs trim oldest complete turns and disclose omissions; unusable windows fail', () => {
  const small = { ...model, context: 1000 };
  const request = context.summaryRequest(small, [user('x'.repeat(8000)), reply(2000, 20), user('keep this'), reply(2200, 4)]);
  assert.equal(request.omitted, 2);
  assert.equal(request.body.messages[0].content, 'keep this');
  assert.ok(meter({ model: small, messages: request.body.messages.map(m => ({ ...m, text: m.content })) }).tokens + request.body.max_tokens < 1000);
  assert.throws(() => context.summaryRequest({ ...model, context: 0 }, [user('hi')]), /known context/);
  assert.throws(() => context.summaryRequest({ ...model, context: 10 }, [user('hi')]), /not enough room/);
});

test('composer rendering exposes accessible warnings, action and uncertainty', () => {
  const { ContextMeter } = loadComponent();
  const render = state => renderToStaticMarkup(React.createElement(ContextMeter, { busy: false, context: { meters: [{ ...meter({ model: { ...model, context: 100 }, messages: [user('x'.repeat(320))] }), lane: { id: 'lane', messages: [user('hello')] }, model, ...state }], summarize() {} } }));
  assert.match(render(), /Context: about 86% of 100/);
  assert.match(render(), /Getting full: older messages may be cut/);
  assert.match(render(), /<meter[^>]*aria-label=/);
  assert.match(render({ state: 'full' }), /Context is full/);
  assert.match(render({ uncertain: true }), /document usage is approximate/);
});

test('summary uses existing authenticated transport, billing controls, receipt and privacy headers', async () => {
  const states = [], lanes = [{ id: 'lane', modelId: model.id, messages: [user('hello')] }];
  const { useContextMeter } = loadComponent({ useState: init => [init, value => states.push(value)], useRef: init => ({ current: init }), useEffect() {} });
  let calls = 0, signins = 0, latest;
  const options = { lanes, find: () => model, system: '', draft: '', files: [], busy: false, auth: { key: 'sample-key' }, priv: { on: true, headers: () => ({ 'x-anyroute-lane': 'attested' }) }, controllers: { current: new Map() }, setInflight() {}, refreshBalance() {}, setLanes: next => { latest = next; }, setFocus() {}, setEditing() {}, voice: { stop() {} }, input: { current: null }, needKey: () => false, limits: { streamChat: async request => { calls++; assert.equal(request.key, 'sample-key'); assert.equal(request.headers['x-anyroute-lane'], 'attested'); assert.equal(request.body.model, model.id); request.onEvent({ choices: [{ delta: { content: 'summary' } }], usage: { prompt_tokens: 10, completion_tokens: 2 }, receipt: { id: 'sample-receipt' } }); } } };
  await useContextMeter(options).summarize(lanes[0]);
  assert.equal(calls, 1);
  assert.equal(latest[0].messages.length, 0); // Existing history shell resets before seeding.
  assert.ok(states.some(value => value?.old && value.next[0].messages[0].text.includes('summary')));
  await useContextMeter({ ...options, needKey: () => { signins++; return true; } }).summarize(lanes[0]);
  assert.equal(signins, 1); assert.equal(calls, 1);
  await useContextMeter({ ...options, busy: true }).summarize(lanes[0]);
  assert.equal(calls, 1);
});

test('summary failure preserves the old chat and the ordinary send path has capacity guards', async () => {
  let changed = false;
  const { useContextMeter } = loadComponent({ useState: init => [init, () => {}], useRef: init => ({ current: init }), useEffect() {} });
  const lane = { id: 'lane', modelId: model.id, messages: [user('hello')] };
  await useContextMeter({ lanes: [lane], find: () => model, system: '', draft: '', files: [], busy: false, auth: { key: 'sample-key' }, priv: { on: false, headers: () => ({}) }, controllers: { current: new Map() }, setInflight() {}, refreshBalance() {}, setLanes: () => { changed = true; }, voice: { stop() {} }, needKey: () => false, limits: { streamChat: async () => { throw new Error('Not enough credits'); } } }).summarize(lane);
  assert.equal(changed, false);
  const source = readFileSync(new URL('../components/Harness.jsx', import.meta.url), 'utf8');
  assert.match(source, /contextSendBlock\(lanesRef.current/);
  assert.match(source, /contextMeter\({ model, messages: history/);
  const component = readFileSync(new URL('../components/harness/ContextMeter.jsx', import.meta.url), 'utf8');
  assert.match(component, /<ReplyApproval limits={context.limits} messageId={context.pending}/);
  assert.match(source, /fieldset disabled={!busy && !!context.block}/);
});
