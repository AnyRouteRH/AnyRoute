'use client';
// G161: uses the current rulebook editor and its existing save/replay paths.
import { LimitField, LimitGroup } from '../../components/limits/SpendingLimits';
import { defaultWorkHours, WORK_DAYS } from '../../lib/work-hours';
import s from './agents.module.css';
export default function WorkHours({ value, onChange, disabled }) {
  const set = (key, next) => onChange({ ...value, [key]: next });
  return <LimitGroup title="Work hours" disabled={disabled}>
    <span id="account-checkup-work-hours" hidden/> {/* J177 */}
    <label className="check-label"><input type="checkbox" checked={value != null} onChange={e => onChange(e.target.checked ? defaultWorkHours() : undefined)}/>Choose when this agent works</label>
    <p className="help-text">Times follow your chosen time zone, including daylight saving changes. Other rules still apply.</p>
    {value && <>
      <div className={s.checks} role="group" aria-label="Work days">{WORK_DAYS.map((day, index) => <label className="check-label" key={day}><input type="checkbox" checked={value.days.includes(index)} onChange={e => set('days', e.target.checked ? [...value.days, index].sort((a,b) => a-b) : value.days.filter(d => d !== index))}/>{day}</label>)}</div>
      <div className="two-fields">{[['start', 'Start time'], ['end', 'End time']].map(([key, label]) => <LimitField key={key} id={`work-hours-${key}`} label={label}><input id={`work-hours-${key}`} type="time" step="60" required value={value[key]} onChange={e => set(key, e.target.value)}/></LimitField>)}</div>
      <LimitField id="work-hours-zone" label="Time zone" help="For example, America/New_York or Europe/London."><input id="work-hours-zone" type="text" maxLength={100} required value={value.time_zone} onChange={e => set('time_zone', e.target.value.trim())}/></LimitField>
      <LimitField id="work-hours-outside" label="Outside those hours"><select id="work-hours-outside" value={value.outside} onChange={e => set('outside', e.target.value)}><option value="refuse">Refuse that request</option><option value="ask_first">Ask first</option></select></LimitField>
      <p className="help-text">Start is included; end is excluded. If end is earlier than start, work continues into the following day. Ask first needs a fresh approval for each request. Existing UTC windows also apply.</p>
    </>}
  </LimitGroup>;
}
