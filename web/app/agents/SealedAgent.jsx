'use client';
import ProofBadge from '../../components/ProofBadge';
import { useEffect, useState } from 'react';
import { sealedLabel } from '../../lib/agent-sealed';
export function SealedBadge({ sealed, linked = true }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(timer); }, []);
  return sealed ? <><ProofBadge evidence={{ source: "sealed", data: sealed }} now={now} linked={linked} /><span className="help-text" style={{overflowWrap:'anywhere'}}>Image {sealed.agent_image_digest || 'not recorded'}</span></> : null;
}
export default function SealedAgent({ agent, request }) {
  const [url, setUrl] = useState(''), [image, setImage] = useState(''), [compose, setCompose] = useState('');
  const [state, setState] = useState(agent.sealed), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { setState(agent.sealed); }, [agent.sealed]);
  if (agent.sealed === undefined) return null;
  const submit = async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { const json = await request('/api/v1/agents/'+encodeURIComponent(agent.key_hash)+'/sealed', { method:'POST', body:{attestation_url:url,agent_image_digest:image,compose_hash:compose} }); setState(json.data); }
    catch (e) { setState({attested:false,agent_image_digest:image,compose_hash:compose}); setError(e.message || 'Attestation could not be verified.'); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError('');
    try { await request('/api/v1/agents/'+encodeURIComponent(agent.key_hash)+'/sealed', {method:'DELETE'}); setState(null); }
    catch (e) { setError(e.message || 'Registration could not be removed.'); } finally { setBusy(false); }
  };
  return <section className="control-panel"><h2>Sealed hosting</h2><SealedBadge sealed={state}/><p>Register the exact measured deployment you approved. Measured code is not audited code. <a href="/docs/#sealed-agents">Trust and privacy limits</a></p>
    {state && !sealedLabel(state) && <p>Sealed attestation is unavailable or expired.</p>}
    <form onSubmit={submit}><fieldset disabled={busy}><legend>Owner-approved deployment</legend>
      <label>HTTPS attestation URL<input type="url" required value={url} onChange={e => setUrl(e.target.value)}/></label>
      <label>Agent image sha256 digest<input required pattern="sha256:[a-f0-9]{64}" value={image} onChange={e => setImage(e.target.value)}/></label>
      <label>Measured compose sha256 hash<input required pattern="sha256:[a-f0-9]{64}" value={compose} onChange={e => setCompose(e.target.value)}/></label>
      <button type="submit">Register and verify</button>{state && <button type="button" onClick={remove}>Remove registration</button>}
    </fieldset></form>{error && <p role="alert">{error}</p>}
  </section>;
}
