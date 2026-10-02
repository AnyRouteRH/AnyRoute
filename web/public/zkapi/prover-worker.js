// AnyRoute's wrapper around the MIT OR Apache-2.0 Rust browser crate.
// Secret witnesses stay in this worker/browser; only proofs leave the browser.
import init, * as wasm from './zkapi_browser.js';
const ready = init({ module_or_path: new URL('./zkapi_browser_bg.wasm', import.meta.url) });
const keys = new Map();
async function key(artifact) {
  const cached = keys.get(artifact.sha256);
  if (cached) return cached;
  const url = new URL(artifact.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid proving-key URL.');
  const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Proving-key download failed (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 32_000_000) throw new Error('Proving key is too large.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  if (hash !== artifact.sha256) throw new Error('Proving-key hash mismatch.');
  keys.set(hash, bytes);
  return bytes;
}
const encode = JSON.stringify;
self.onmessage = async ({ data: { id, operation, args } }) => {
  try {
    await ready;
    if (wasm.browser_circuit_id() !== 'zkapi-v2-note-bound-v1') throw new Error('WASM circuit mismatch.');
    let result;
    switch (operation) {
      case 'generate': result = wasm.browser_generate_deposit(); break;
      case 'confirm': result = wasm.browser_confirm_deposit(encode(args.config), encode(args.deposit)); break;
      case 'path': result = wasm.browser_tree_path(encode(args.snapshot), args.noteId, args.existing); break;
      case 'request': result = wasm.browser_prepare_request(encode(args.config), encode(args.state), encode(args.request), await key(args.artifact)); break;
      case 'complete': result = wasm.browser_complete_response(encode(args.config), encode(args.transition)); break;
      case 'nullifier': result = wasm.browser_withdrawal_nullifier(encode(args.state)); break;
      case 'withdraw': result = wasm.browser_prepare_withdrawal(encode(args.config), encode(args.state), encode(args.withdrawal), await key(args.artifact)); break;
      default: throw new Error('Unknown wallet operation.');
    }
    self.postMessage({ id, result: JSON.parse(result) });
  } catch { self.postMessage({ id, error: 'The wallet operation could not be verified. Your recovery state was preserved.' }); }
};
