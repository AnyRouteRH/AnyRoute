'use client';
import { useState } from 'react';
import { Button } from './UI';
import { API_BASE } from '../lib/api.js';
import { KEYS_PATH } from '../lib/verify.js';
import { parseStatement, verifyStatement } from '../lib/statements.js';
import styles from './Verify.module.css';
export default function StatementVerify() {
  const [text, setText] = useState(''), [error, setError] = useState(''), [result, setResult] = useState(null), [busy, setBusy] = useState(false);
  async function file(input) {
    setResult(null); setError('');
    if (!input) return;
    if (input.size > 8 * 1024 * 1024) { setError('Choose a JSON file under 8 MB.'); return; }
    try { setText(await input.text()); } catch { setError('The file could not be read.'); }
  }
  async function check(e) {
    e.preventDefault(); setError(''); setResult(null); setBusy(true);
    try { const statement = parseStatement(text); const r = await fetch(API_BASE + KEYS_PATH); if (!r.ok) throw new Error('The published receipt keys could not be loaded.'); setResult(await verifyStatement(statement, { keys: await r.json() })); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <section className={styles.section} aria-labelledby="v-statement"><h2 id="v-statement">Verify a monthly statement</h2><p>Paste or drop signed JSON. The browser checks the canonical JSON signature with the router’s published receipt keys and reconciles its amounts. The JSON stays on your device.</p>
    <form onSubmit={check} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); file(e.dataTransfer.files[0]); }}><div className="field"><label htmlFor="statement-file">Choose statement JSON (or drop it here)</label><input type="file" id="statement-file" accept=".json,application/json" onChange={e => file(e.target.files[0])}/></div><div className="field"><label htmlFor="statement-json">Signed statement JSON</label><textarea id="statement-json" value={text} onChange={e => { setText(e.target.value); setResult(null); }} spellCheck={false}/></div><Button type="submit" disabled={busy}>{busy ? 'Checking…' : 'Verify statement'}</Button></form>
    {error && <p role="alert" className="error">{error}</p>}{result && <div role="status"><h3>{result.valid ? 'Signature valid · amounts reconcile' : 'Statement did not verify'}</h3><ul>{result.checks.map(c => <li key={c.id}>{c.status === 'pass' ? 'Passed' : c.status === 'not_checked' ? 'Not checked' : 'Failed'}: {c.detail}</li>)}</ul>{result.notChecked.map(line => <p key={line}>{line}</p>)}</div>}
  </section>;
}
