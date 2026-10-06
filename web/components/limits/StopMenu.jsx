'use client';
// B117: shared by every existing Stop control. Tab reaches all choices; Escape closes and returns focus.
import { useRef, useState } from 'react';
import { Button } from '../UI';
import { STOP_PRESETS, stopUntil } from '../../lib/stop-until';
import s from './StopMenu.module.css';
export default function StopMenu({ disabled, onStop, className }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  const close = () => { setOpen(false); trigger.current?.querySelector('button')?.focus(); };
  return <div className={s.wrap} onKeyDown={e => { if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); close(); } }}>
    <span ref={trigger}><Button type="button" secondary className={className} disabled={disabled} aria-expanded={open} onClick={() => setOpen(value => !value)}>Stop</Button></span>
    {open && <div className={s.choices} role="group" aria-label="Stop duration">{STOP_PRESETS.map(([preset, label]) => <button key={preset} type="button" disabled={disabled} onClick={() => { const until = stopUntil(preset); close(); onStop(until); }}>{label}</button>)}</div>}
  </div>;
}
