'use client';
import { useEffect, useState } from 'react';
import { api, loadKey, saveKey } from '../../../lib/api';
import { PROFILE_CATEGORIES, profilePayload } from '../../../lib/agent-profiles';
const blank = { name: '', description: '', homepage: '', endpoint: '', tags: '', show: [], claims: '' };
export default function PublishProfile() {
  const [draft, setDraft] = useState(''), [key, setKey] = useState(''), [keys, setKeys] = useState([]), [hash, setHash] = useState('');
  const [form, setForm] = useState(blank), [id, setId] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [choices, setChoices] = useState(null);
  useEffect(() => { setDraft(loadKey()); }, []);
  useEffect(() => {
    setLoaded(false); setForm(blank); setId(''); if (!hash || !key) return;
    const ac = new AbortController();
    api('/api/v1/agents/' + hash + '/profile', { key, signal: ac.signal }).then(({ data }) => {
      if (data) { setForm({ name: data.name, description: data.description, homepage: data.homepage || '', endpoint: data.endpoint || '', tags: data.capabilities.join(', '), show: data.show, claims: data.certificate_claims.join(', ') }); setId(data.id); }
      setLoaded(true); setError('');
    }).catch(e => { if (!ac.signal.aborted) setError(e.status === 404 ? 'Public profiles are not switched on.' : e.message); });
    setChoices(null);
    api('/api/v1/agents/' + hash + '/identity', { key, signal: ac.signal }).then(({ data }) => setChoices(data)).catch(() => setChoices(null));
    return () => ac.abort();
  }, [key, hash]);
  const choose = async change => {
    setBusy(true); setError('');
    try { setChoices((await api('/api/v1/agents/' + hash + '/identity', { key, method: 'PUT', body: change })).data); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const connect = async e => {
    e.preventDefault(); setBusy(true); setError(''); setLoaded(false);
    try { const secret = draft.trim(); const result = await api('/api/v1/keys', { key: secret }); saveKey(secret); setKeys(result.data); setKey(secret); setHash(result.data[0]?.hash || ''); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const mutate = async remove => {
    setBusy(true); setError('');
    try { const result = await api('/api/v1/agents/' + hash + '/profile', { key, method: remove ? 'DELETE' : 'PUT', ...(remove ? {} : { body: profilePayload(form) }) }); setId(remove ? '' : result.data.id); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return <section className="control-panel"><h2>Publish your agent</h2><p>Publication is opt-in. Names, descriptions, homepages and tags are public. Only selected rulebook categories and certificate claims are shown; exact caps and thresholds stay private. Public readers may retain copies after unpublish.</p>
    <form onSubmit={connect}><label>Owner API key <input type="password" autoComplete="off" value={draft} onChange={e => setDraft(e.target.value)}/></label> <button disabled={busy}>Read my keys</button></form>
    {error && <p role="alert">{error}</p>}
    {!!keys.length && <label>Agent key <select value={hash} disabled={busy} onChange={e => setHash(e.target.value)}>{keys.map(k => <option key={k.hash} value={k.hash}>{k.name || k.hash}</option>)}</select></label>}
    {loaded && <form onSubmit={e => { e.preventDefault(); mutate(false); }}>
      {['name', 'description', 'homepage', 'endpoint', 'tags', 'claims'].map(field => <p key={field}><label>{({ name: 'Display name', description: 'Short description', homepage: 'Homepage (optional)', endpoint: 'Agent endpoint, https (optional, checked daily for liveness)', tags: 'Capability tags (comma separated)', claims: 'Certificate claims (comma separated, optional)' })[field]} <input required={field === 'name'} type={field === 'homepage' || field === 'endpoint' ? 'url' : 'text'} maxLength={field === 'name' ? 80 : field === 'description' ? 280 : field === 'homepage' || field === 'endpoint' ? 500 : 1000} value={form[field]} disabled={busy} onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}/></label></p>)}
      <fieldset disabled={busy}><legend>Public rulebook categories</legend>{Object.entries(PROFILE_CATEGORIES).map(([value, label]) => <label key={value} style={{ display: 'block' }}><input type="checkbox" checked={form.show.includes(value)} onChange={e => setForm(f => ({ ...f, show: e.target.checked ? [...f.show, value] : f.show.filter(v => v !== value) }))}/>{label}</label>)}</fieldset>
      <p>Certificates require enabled rulebooks and the signing key log. Claims such as requests_at_least:1 are checked against this key’s retained activity. Publishing or updating replaces the selected certificate; empty claims remove it.</p>
      <button disabled={busy}>{busy ? 'Updating…' : 'Publish selected fields'}</button> <button type="button" disabled={busy} onClick={() => mutate(true)}>Unpublish</button>
    </form>}
    {loaded && choices && <fieldset disabled={busy}><legend>Paid reputation and identity</legend>
      <label style={{ display: 'block' }}><input type="checkbox" checked={choices.reputation_opt_in} onChange={e => choose({ reputation_opt_in: e.target.checked })}/>Accept paid feedback: only reviewers who paid this agent through Anyroute can rate it</label>
      <label style={{ display: 'block' }}><input type="checkbox" checked={choices.identity_opt_out} onChange={e => choose({ identity_opt_out: e.target.checked })}/>Keep this key out of ERC-8004 identity and identity links{choices.unlinkable_only_rulebook ? ' (default for a rulebook that allows only the unlinkable lane)' : ''}</label>
      <p>ERC-8004 identity: {choices.registration.agent_id ? `agent ${choices.registration.agent_id}` : choices.registration.status}. An identity sent to the chain is public and permanent.</p>
    </fieldset>}
    {id && <p role="status"><a href={'/agents/profile/?id=' + encodeURIComponent(id)}>Open public profile</a></p>}
  </section>;
}
