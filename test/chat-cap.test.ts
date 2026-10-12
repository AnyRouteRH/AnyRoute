import { expect, test } from 'bun:test';
import { capDecision, capSendRequests, createCapGuard, parseCap, restoreChatCap } from '../web/lib/chat-cap.js';
import { defaultSettings, normalizeModel } from '../web/lib/harness.js';

const model = normalizeModel({ id: 'sample-model', pricing: { prompt: '0.001', completion: '0.001' } });
const lanes = [{ modelId: model.id, messages: [{ id: 'a', role: 'assistant', text: 'Answer', status: 'done', usage: { cost: 1.5 } }] }];
const requests = capSendRequests(lanes, () => model, '', defaultSettings(), 'Question', [], null);
test('G162 includes the pre-call estimate in a browser cap', () => {
  expect(capDecision(lanes, parseCap('2'), requests).held).toBe(true);
  expect(capDecision(lanes, parseCap('5'), requests).held).toBe(false);
});
test('G162 unset caps preserve sending and older history stays unset', () => {
  expect(capDecision(lanes, null, requests)).toEqual({ held: false });
  expect(restoreChatCap({}, lanes)[0].spendingCap).toBeNull();
});
test('G162 held actions run only after a one-send override and are held again next time', () => {
  const guard = createCapGuard(); let sent = 0, held: any;
  const send = () => { if (guard.check(lanes, parseCap('2'), requests, send, (value: any) => { held = value; })) sent++; };
  send(); expect(sent).toBe(0);
  guard.sendAnyway(held.resume); expect(sent).toBe(1);
  send(); expect(sent).toBe(1);
});
