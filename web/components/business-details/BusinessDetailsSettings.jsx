'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Button } from '../UI';
import { BUSINESS_FIELDS, emptyBusinessDetails } from '../../lib/business-details.js';
import s from './BusinessDetails.module.css';
const path = '/api/v1/account/business-details';
export default function BusinessDetailsSettings({ apiKey }) {
  const [details, setDetails] = useState(emptyBusinessDetails), [editable, setEditable] = useState(false);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [message, setMessage] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setEditable(false); setDetails(emptyBusinessDetails()); setError(''); setMessage('');
    api(path, { key: apiKey, signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { setDetails(result.data || emptyBusinessDetails()); setEditable(result.editable); }
    }).catch(e => { if (!controller.signal.aborted) setError(e.status === 404 ? 'Business details are available when monthly statements are switched on.' : e.status === 403 ? 'This key cannot open statement settings. Read-only keys can see business details on a statement.' : e.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [apiKey]);
  async function save(value, deleted = false) {
    setBusy(true); setError(''); setMessage('');
    try { const result = await api(path, { key: apiKey, method: 'PUT', body: value }); setDetails(result.data || emptyBusinessDetails()); setMessage(deleted ? 'Business details deleted.' : 'Business details saved. Read a statement again to use these details.'); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <section className={`control-panel ${s.form}`} id="business-details-settings"><h3>Statements</h3><h4>Business details</h4>
    <p>All fields are optional. These details appear under Billed to on statements and their CSV and print/PDF exports.</p>
    <p className="help-text" id="business-details-help">User-entered details are kept until deleted and are outside the signed statement. Anyroute does not verify them. Current details also appear on earlier months. Only an account management key can edit them.</p>
    <form onSubmit={event => { event.preventDefault(); save(details); }} aria-describedby="business-details-help" aria-busy={busy}>
      <fieldset disabled={busy || !editable}><legend className="help-text">Billed to · user-entered</legend>
        {BUSINESS_FIELDS.map(([field, label, max]) => <div className="field" key={field}><label htmlFor={`business-${field}`}>{label}</label>
          {field === 'address' ? <textarea id={`business-${field}`} rows={4} maxLength={max} value={details[field]} onChange={e => setDetails({ ...details, [field]: e.target.value })}/> : <input id={`business-${field}`} type="text" maxLength={max} value={details[field]} onChange={e => setDetails({ ...details, [field]: e.target.value })} aria-describedby={field === 'reference' ? 'business-reference-help' : undefined}/>}
          <p className="help-text">Up to {max} characters.</p>
        </div>)}
        <p className="help-text" id="business-reference-help">Use a purchase order or billing reference. Leave out email addresses.</p>
        <div className="button-row"><Button type="submit">{busy ? 'Saving…' : 'Save business details'}</Button><Button type="button" secondary onClick={() => save({}, true)}>Delete business details</Button></div>
      </fieldset>
    </form>
    {!busy && !editable && !error && <p className="help-text">You can read these details with this key. Connect an account management key to change them.</p>}
    {error && <p role="alert" className="error">{error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}
