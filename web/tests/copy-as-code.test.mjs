import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { COPY_CODE_LANGUAGES, codeSamples, copyAsCode } from '../lib/copy-as-code.js';
import { defaultSettings, normalizeModel } from '../lib/harness.js';
import { TASKS } from '../lib/site-map.js';
import { conversation, model } from './copy-as-code-fixture.mjs';

for (const language of COPY_CODE_LANGUAGES) test(`${language} request snapshot`, () => {
  assert.equal(copyAsCode(conversation)[language] + '\n', readFileSync(new URL(`./snapshots/copy-as-code.${language}.txt`, import.meta.url), 'utf8'));
});

test('browser credentials never appear in output, even in headers or conversation text', () => {
  const apiKey = ['browser', 'credential', 'do-not-export'].join('-');
  const output = copyAsCode({ ...conversation, apiKey, headers: { ...conversation.headers, Authorization: `Bearer ${apiKey}`, 'X-API-Key': apiKey, Cookie: apiKey, 'x-agent-approval': 'one-time-approval', 'x-title': apiKey }, messages: [{ role: 'user', text: `Keep ${apiKey} private` }] });
  for (const language of COPY_CODE_LANGUAGES) {
    assert.ok(!output[language].includes(apiKey));
    assert.ok(!output[language].includes('one-time-approval'));
    assert.ok(!output[language].includes('X-API-Key'));
    assert.ok(!output[language].includes('Cookie'));
    assert.ok(output[language].includes('ANYROUTE_API_KEY'));
  }
  assert.match(output.curl, /Bearer \$ANYROUTE_API_KEY/);
  assert.match(output.typescript, /process.env.ANYROUTE_API_KEY/);
  assert.match(output.python, /os.environ\["ANYROUTE_API_KEY"\]/);
});

test('attachments become count comments without bytes, while conversation and settings remain', () => {
  const output = copyAsCode(conversation);
  for (const language of COPY_CODE_LANGUAGES) {
    assert.match(output[language], /2 images omitted/);
    assert.match(output[language], /1 file omitted/);
    assert.doesNotMatch(output[language], /base64|IMAGE_BYTES|FILE_BYTES/);
    assert.match(output[language], /tool_call_id/);
    assert.match(output[language], /temperature.*0/);
    assert.match(output[language], /max_tokens.*64/);
    assert.match(output[language], /x-anyroute-lane.*attested/);
    assert.match(output[language], /X-Anyroute-Decision-Tag.*sha256:decision-hash/);
  }
  const wire = codeSamples({ body: { model: model.id, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BYTES' } }, { type: 'text', text: 'Hello' }] }] } });
  assert.match(wire.curl, /1 image omitted/);
  assert.doesNotMatch(wire.curl, /BYTES/);
});

test('default settings have no optional values or lane headers; invalid settings cannot export', () => {
  const output = copyAsCode({ model, messages: [{ role: 'user', text: 'Hello' }] });
  assert.deepEqual(output.notes, []);
  assert.doesNotMatch(output.curl, /temperature|max_tokens|x-anyroute-lane/);
  assert.match(output.curl, /https:\/\/anyroute.tech\/api\/v1\/chat\/completions/);
  assert.equal(copyAsCode({ model, settings: { ...defaultSettings(), tools: true, toolsText: '{' } }).curl, undefined);
  const limited = normalizeModel({ id: 'sample/text', supported_parameters: [], architecture: { input_modalities: ['text'], output_modalities: ['text'] } });
  assert.doesNotMatch(copyAsCode({ ...conversation, model: limited }).typescript, /temperature|max_tokens|response_format/);
});

test('provider preferences and custom public API base survive; credential URLs are refused', () => {
  const output = codeSamples({ body: { model: '@route/fast', messages: [], provider: { order: ['sample-provider'], allow_fallbacks: false, lane: 'attested' }, private: true }, baseUrl: 'https://api.example.invalid/' });
  assert.match(output.python, /"allow_fallbacks": False/);
  assert.match(output.typescript, /"private": true/);
  assert.match(output.curl, /https:\/\/api.example.invalid\/api\/v1\/chat\/completions/);
  for (const baseUrl of ['https://sample-user:credential@example.invalid', 'https://example.invalid?key=credential', 'file:///tmp/router']) assert.throws(() => codeSamples({ body: {}, baseUrl }));
});

test('curl quoting preserves apostrophes, newlines and shell expressions without evaluating them', () => {
  const text = 'It\'s "$HOME" and `printf BAD` and $(printf BAD).\n🌍';
  const { curl } = copyAsCode({ model, messages: [{ role: 'user', text }], headers: { 'x-anyroute-note': "Chat's note" } });
  const result = spawnSync('sh', ['-c', 'curl() { for arg do printf "%s\\0" "$arg"; done; };\n' + curl], { encoding: 'utf8', env: { ANYROUTE_API_KEY: 'environment-key' } });
  assert.equal(result.status, 0, result.stderr);
  const args = result.stdout.split('\0');
  assert.equal(JSON.parse(args[args.indexOf('--data-raw') + 1]).messages[0].content, text);
  assert.ok(args.includes('Authorization: Bearer environment-key'));
  assert.ok(args.includes("x-anyroute-note: Chat's note"));
});

test('TypeScript fetch sends the conversation with the environment key and streaming enabled', async () => {
  const source = copyAsCode(conversation).typescript;
  let sent;
  const run = vm.compileFunction(`return (async () => { ${source} })();`, ['fetch', 'process', 'console']);
  await run(async (url, options) => { sent = { url, ...options }; return { ok: true, text: async () => 'data: [DONE]' }; }, { env: { ANYROUTE_API_KEY: 'environment-key' } }, { log() {} });
  assert.equal(sent.method, 'POST');
  assert.equal(sent.headers.Authorization, 'Bearer environment-key');
  assert.equal(sent.headers['x-anyroute-lane'], 'attested');
  const body = JSON.parse(sent.body);
  assert.equal(body.stream, true);
  assert.equal(body.messages.length, 6);
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 64);
  await assert.rejects(run(() => { throw new Error('Must not send'); }, { env: {} }, { log() {} }), /Set ANYROUTE_API_KEY/);
});

test('Python requests snippet executes with native booleans and the environment key', () => {
  const source = copyAsCode(conversation).python;
  const stub = `import sys, types\nmodule = types.ModuleType("requests")\ndef post(url, **options):\n    assert url == "https://anyroute.tech/api/v1/chat/completions"\n    assert options["headers"]["Authorization"] == "Bearer environment-key"\n    assert options["json"]["stream"] is True\n    assert options["json"]["temperature"] == 0\n    assert options["json"]["messages"][0]["content"] == "Be brief."\n    return types.SimpleNamespace(raise_for_status=lambda: None, text="data: [DONE]")\nmodule.post = post\nsys.modules["requests"] = module\n`;
  const result = spawnSync('python3', ['-c', stub + source], { encoding: 'utf8', env: { ...process.env, ANYROUTE_API_KEY: 'environment-key' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'data: [DONE]');
});

test('Chat integration uses the selected lane and current headers, with accessible tabs and docs search', () => {
  const harness = readFileSync(new URL('../components/Harness.jsx', import.meta.url), 'utf8');
  const component = readFileSync(new URL('../components/harness/CopyAsCode.jsx', import.meta.url), 'utf8');
  assert.match(harness, /<CopyAsCode model=\{focusModel\}.*messages=\{focusLane\?\.messages\}.*priv.headers\(\)/);
  assert.match(component, /disabled=\{!model \|\| busy \|\| !messages\?\.length\}/);
  assert.match(component, /role="tablist"/);
  assert.match(component, /role="tabpanel"/);
  assert.match(component, /ArrowRight/);
  assert.match(component, /API_BASE \|\| "https:\/\/anyroute.tech"/);
  assert.equal(TASKS.find((item) => item.id === 'copy-as-code').href, '/harness/');
  assert.equal(TASKS.find((item) => item.id === 'copy-as-code').menu, false);
  assert.match(readFileSync(new URL('../app/docs/page.jsx', import.meta.url), 'utf8'), /<CopyAsCodeDocs \/> \{\/\* C130 \*\/\}/);
});
