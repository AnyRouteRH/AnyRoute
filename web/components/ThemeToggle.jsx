'use client';
import { useEffect, useId, useState } from 'react';
import { THEME_KEY, applyTheme, saveTheme, themeChoice } from '../lib/theme.js';
import s from './ThemeToggle.module.css';
export default function ThemeToggle() {
  const id = useId();
  const [choice, setChoice] = useState('device');
  useEffect(() => {
    const sync = () => setChoice(themeChoice(document.documentElement.getAttribute('data-theme')));
    // The head script restores storage once. Later controls preserve an in-memory choice when storage is denied.
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const storage = event => {
      if (event.key === THEME_KEY || event.key === null) {
        applyTheme(document.documentElement, themeChoice(event.newValue));
      }
    };
    window.addEventListener('storage', storage);
    return () => { observer.disconnect(); window.removeEventListener('storage', storage); };
  }, []);
  return <label className={s.control} htmlFor={id}><span>Appearance</span><select id={id} value={choice} onChange={event => {
    const next = event.target.value;
    applyTheme(document.documentElement, next);
    try { saveTheme(document.documentElement, window.localStorage, next); } catch {}
    setChoice(next);
  }}><option value="light">Light</option><option value="dark">Dark</option><option value="device">Match device</option></select></label>;
}
