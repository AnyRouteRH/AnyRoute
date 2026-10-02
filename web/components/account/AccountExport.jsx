'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../UI';
import { api } from '../../lib/api.js';
import { exportAccount, EXPORT_EXCLUSIONS, EXPORT_PARTS } from '../../lib/account-export.js';
import { downloadJson } from '../../lib/statements.js';
export default function AccountExport({ apiKey }) {
  const [progress, setProgress] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [manifest, setManifest] = useState(null);
  const controller = useRef(null);
  useEffect(() => { setProgress(null); setManifest(null); setError(''); setBusy(false); return () => controller.current?.abort(); }, [apiKey]);
  async function run() {
    const ac = new AbortController(); controller.current = ac; setBusy(true); setError(''); setManifest(null);
    try {
      const bundle = await exportAccount((path, options) => api(path, { ...options, key: apiKey }), { signal: ac.signal, onProgress: p => { if (!ac.signal.aborted) setProgress(p); } });
      if (!ac.signal.aborted) { downloadJson(bundle, 'anyroute-account-export.json'); setManifest(bundle.manifest); }
    } catch (e) { if (!ac.signal.aborted) setError(e.message); }
    finally { if (!ac.signal.aborted) setBusy(false); }
  }
  return <section className="control-panel"><h2 tabIndex={-1}>Export your data</h2><p>Download one JSON bundle of account records this key can read. The browser pages existing APIs and includes a manifest of access and retention limits. No key secrets are included.</p><p>This export contains {EXPORT_PARTS.map(name => name.replaceAll('_',' ')).join(', ')} where those records are accessible. Statements require the router’s monthly statement feature to be switched on.</p><p>The router keeps more than this export contains. Read <a href="/keep/">What we keep</a> for storage, retention and where request text or addresses are read. Chat history lives in your browser; export it from <a href="/harness/">the Harness</a>.</p>
    <div className="button-row"><Button disabled={busy || !apiKey} onClick={run}>Export my data</Button>{busy && <Button secondary onClick={() => { controller.current?.abort(); setBusy(false); setProgress(null); setError('Export cancelled. No bundle was downloaded.'); }}>Cancel export</Button>}</div>
    {progress && <div role="status" aria-live="polite"><p>{busy ? 'Reading' : 'Read'} {progress.part.replaceAll('_',' ')} · {progress.completed} / {progress.total} sections{progress.records ? ` · ${progress.records} records` : ''}</p><progress aria-label="Export progress" value={progress.completed} max={progress.total}/></div>}{error && <p role="alert">{error}</p>}
    {manifest && <div role="status"><h3>Bundle downloaded</h3><ul>{Object.entries(manifest.parts).map(([name, p]) => <li key={name}>{name.replaceAll('_',' ')}: {p.status}{p.reason ? ` — ${p.reason}` : ''}{p.limit ? ` — ${p.limit}` : ''}</li>)}</ul></div>}
    <h3>Outside this export</h3><ul>{EXPORT_EXCLUSIONS.map(item => <li key={item.name}><strong>{item.name}.</strong> {item.reason}</li>)}</ul>
  </section>;
}
