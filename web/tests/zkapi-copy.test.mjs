import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { TASKS } from '../lib/site-map.js';
import { STORE } from '../lib/zkapi/storage.js';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const wallet = read('app/zkapi/wallet.jsx');

test('zkAPI copy describes funding separation and preserves the prompt and lease limits', () => {
  const page = read('app/zkapi/page.jsx');
  assert.match(page, /title: 'Pay with zkAPI — Anyroute'/);
  assert.match(page, /<h1>Pay with zkAPI\.<\/h1>/);
  assert.match(page, /Keep your funding wallet apart from your AI calls\./);
  assert.match(page, /Calls within a lease still link to one key and the operator’s account/);
  assert.match(page, /AnyRoute reads ordinary prompts in memory\. The model provider also receives them/);
  assert.match(page, /An expired active note can be claimed in full by the treasury/);
  assert.match(wallet, /<h2 id="zk-backup">Your note wallet<\/h2>/);
  const entry = TASKS.find(task => task.id === 'zkapi');
  assert.equal(entry.menu, false);
  for (const file of ['app/zkapi/page.jsx', 'app/zkapi/wallet.jsx', 'components/ZkapiDocs.jsx', 'lib/zkapi/storage.js', 'lib/zkapi/client.js']) {
    // The legacy storage and lock identifiers are not page copy.
    const copy = read(file).replace(/^\s*\/\/.*$/gm, '').replace(/anyroute-zkapi-private-wallet(?:-v1)?/g, 'legacy-wallet');
    assert.doesNotMatch(copy, /\bprivate(?:ly)?\b|\banonymous\b|we can[’']t (?:see|read) prompts/i, file);
  }
  assert.doesNotMatch(JSON.stringify(entry), /\bprivate(?:ly)?\b|\banonymous\b/i);
});

test('legacy saved notes and cross-tab locks keep the same identifiers', () => {
  assert.equal(STORE, 'anyroute-zkapi-private-wallet-v1');
  assert.match(read('lib/zkapi/client.js'), /navigator\.locks\.request\('anyroute-zkapi-private-wallet'/);
});

// Execute the actual JSX button handlers and run() error path without a DOM dependency.
function buttons(writeText) {
  const context = {
    Error,
    busy: false, backup: 'saved-note-export', backedUp: false, status: '', error: '',
    navigator: { clipboard: { writeText } },
    store: { current: { read: () => ({}), backup: async () => 'current-note-export' } },
  };
  for (const name of ['Busy', 'Backup', 'BackedUp', 'Status', 'Error', 'Wallet']) {
    context['set' + name] = value => { context[name[0].toLowerCase() + name.slice(1)] = value; };
  }
  const run = wallet.slice(wallet.indexOf('  async function run('), wallet.indexOf('  async function connectWallet('));
  const click = label => {
    const handler = wallet.match(new RegExp(`onClick=\\{(\\(\\) => run\\([^\\n]+?)\\}>${label}<`))?.[1];
    assert.ok(handler, `Missing handler for ${label}`);
    return runInNewContext(`${run}\n(${handler})()`, context);
  };
  return { context, copy: () => click('Copy wallet export'), export: () => click('Export / copy backup') };
}

test('successful copy clears the visible export only after the clipboard accepts it', async () => {
  let finish;
  const { context, copy } = buttons(text => {
    assert.equal(text, 'saved-note-export');
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = copy();
  assert.equal(context.backup, 'saved-note-export');
  assert.equal(context.backedUp, false);
  finish();
  await pending;
  assert.equal(context.backup, '');
  assert.equal(context.backedUp, true);
  assert.equal(context.status, 'Backup copied. Store it somewhere safe.');
  assert.match(wallet, /\{backup && <>[\s\S]*?<textarea id="zk-export" readOnly value=\{backup\}/);
});

test('failed copy keeps the export available and does not mark it saved', async () => {
  const { context, copy } = buttons(async () => { throw new Error('Clipboard unavailable'); });
  await copy();
  assert.equal(context.backup, 'saved-note-export');
  assert.equal(context.backedUp, false);
  assert.equal(context.error, 'Clipboard unavailable');
  assert.equal(context.status, '');
  assert.equal(context.busy, false);
});

test('a copied backup can be exported again from the current wallet', async () => {
  const copied = [];
  const { context, copy, export: exportBackup } = buttons(async text => { copied.push(text); });
  await copy();
  assert.equal(context.backup, '');
  await exportBackup();
  assert.equal(context.backup, 'current-note-export');
  await copy();
  assert.deepEqual(copied, ['saved-note-export', 'current-note-export']);
  assert.equal(context.backup, '');
});
