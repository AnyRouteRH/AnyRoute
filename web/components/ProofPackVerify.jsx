'use client';
// B122: a file picker and drop zone for the existing proof-pack format.
import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../lib/api.js';
import { KEYS_PATH } from '../lib/verify.js';
import { proofPackFailureText, proofPackResultLines } from '../lib/proof-pack-verify.js';
import styles from './Verify.module.css';
import packStyles from './ProofPackVerify.module.css';

export default function ProofPackVerify() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [output, setOutput] = useState(null), [progress, setProgress] = useState('');
  const job = useRef(null);
  useEffect(() => () => { job.current?.reader?.abort(); job.current?.abort.abort(); job.current?.worker?.terminate(); }, []);
  async function check(file) {
    if (!file || job.current) return;
    setBusy(true); setError(''); setOutput(null); setProgress('Reading your file…');
    const current = { abort: new AbortController(), reader: new FileReader(), worker: null };
    job.current = current;
    const finish = () => { current.worker?.terminate(); if (job.current === current) { job.current = null; setBusy(false); } };
    try {
      // FileReader reads on the device. Only the public key list is fetched; no file, name or contents are sent.
      const text = await new Promise((resolve, reject) => {
        current.reader.onload = () => resolve(current.reader.result);
        current.reader.onerror = () => reject(new Error('The file could not be read. Choose it again.'));
        current.reader.onabort = () => reject(new Error('Reading stopped.'));
        current.reader.readAsText(file);
      });
      setProgress('Reading Anyroute’s published receipt keys…');
      const response = await fetch(API_BASE + KEYS_PATH, { method: 'GET', credentials: 'omit', signal: current.abort.signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('Anyroute’s published receipt keys could not be loaded. Try again when you are connected, or use the offline script.');
      const keys = await response.json();
      setProgress('Checking signatures and totals…');
      current.worker = new Worker(new URL('../lib/proof-pack-worker.js', import.meta.url), { type: 'module' });
      current.worker.onmessage = ({ data }) => {
        if (data.checked !== undefined) { setProgress(`${data.checked} items checked…`); return; }
        if (data.error) setError(data.error); else setOutput(data);
        finish();
      };
      current.worker.onerror = () => { setError('This browser could not complete the check. Use the offline script to check the file.'); finish(); };
      current.worker.postMessage({ text, keys });
    } catch (e) {
      if (!current.abort.signal.aborted) { setError(e.message === 'Failed to fetch' ? 'Anyroute’s published receipt keys could not be reached. Try again when you are connected, or use the offline script.' : e.message); finish(); }
    }
  }
  const result = output?.result;
  return <section id="v-proof-pack" className={styles.section} aria-labelledby="proof-pack-title">
    <h2 id="proof-pack-title">Check a proof pack</h2>
    <p>Choose the proof pack you downloaded from Statements. Your file is read in this browser and never uploaded. The browser makes a GET request for Anyroute’s published receipt keys to check who signed it.</p>
    <div className={packStyles.dropZone} aria-busy={busy} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busy) check(e.dataTransfer.files[0]); }}>
      <label htmlFor="proof-pack-file">Drop a proof pack here, or choose a file</label>
      <input id="proof-pack-file" type="file" accept=".json,application/json" disabled={busy} onChange={e => { check(e.target.files[0]); e.target.value = ''; }}/>
    </div>
    {busy && <p role="status">{progress}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {result && <div className={packStyles.result} role="status">
      <h3>{result.ok && result.signedByAnyroute ? 'Signed by Anyroute ✓' : 'Proof pack did not pass'}</h3>
      <ul>{proofPackResultLines(result).map(line => <li key={line}>{line}</li>)}</ul>
      {result.failures.length > 0 && <><h4>What failed</h4><ul>{result.failures.slice(0, 50).map((line, i) => <li key={i}>{proofPackFailureText(line)}</li>)}</ul>{result.failures.length > 50 && <p>{result.failures.length - 50} more checks failed.</p>}</>}
      {output.moreParts && <p>This file is one part of the range. Download and check the remaining parts separately.</p>}
      {output.unavailableStatements > 0 && <p>{output.unavailableStatements} months have no statement in this file.</p>}
      <p>This checks the signed records in this file. The lane report describes where the router says calls ran; it does not repeat the hardware check. A valid signature does not show that an answer was correct or what a provider did with a prompt. Merkle paths show inclusion under a root; this page does not check publication of roots.</p>
    </div>}
    <p><a href="/docs/#proof-pack">Proof pack checks and offline instructions</a></p>
  </section>;
}
