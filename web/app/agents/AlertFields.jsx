export default function AlertFields({ value, onChange, disabled }) {
  const patch = fields => onChange({ ...value, ...fields });
  return <fieldset disabled={disabled}><legend>Owner alerts</legend>
    <label className="check-label"><input type="checkbox" checked={value !== undefined} onChange={e => onChange(e.target.checked ? {} : undefined)}/>Enable alerts for this rulebook</label>
    {value !== undefined && <>
      <div className="field"><label htmlFor="alert-percent">Cap percentages (comma separated)</label><input id="alert-percent" value={(value.at_percent ?? [80,100]).join(',')} onChange={e => patch({ at_percent:e.target.value.trim() === '' ? [] : e.target.value.split(',').map(Number) })}/></div>
      <div className="field"><label htmlFor="alert-denials">Denials in 10 minutes</label><input id="alert-denials" type="number" min="1" max="10000" step="1" value={value.denials_in_10min ?? 5} onChange={e => patch({denials_in_10min:Number(e.target.value)})}/></div>
      {['webhook','telegram','email'].map(channel => <label className="check-label" key={channel}><input type="checkbox" checked={(value.channels ?? ['webhook','telegram']).includes(channel)} onChange={e => patch({channels:e.target.checked ? [...(value.channels ?? ['webhook','telegram']),channel] : (value.channels ?? ['webhook','telegram']).filter(c => c !== channel)})}/>{channel === 'telegram' ? 'Telegram' : channel}</label>)}
      <p className="help-text">Reuses linked Spend Watch webhooks and principal Telegram links. Email has no account destination. With no selected linked channel, entries stay in this feed only. No prompt text is included.</p>
    </>}
  </fieldset>;
}
