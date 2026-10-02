'use client';
import { useEffect, useRef, useState } from 'react';
import { GROUPS, TASKS, menuTasks } from '../../lib/site-map';
import './nav.css';

function activeGroup(path, hash) {
  const matches = path === '/' ? [] : TASKS.filter(task => task.href.split('#')[0] === path); // home anchors (roadmap, about) don't mark a group
  return (matches.find(task => hash && task.href.endsWith(hash)) || matches.find(task => !task.href.includes('#')) || matches[0])?.group;
}

export function DesktopGroups({ path }) {
  const [open, setOpen] = useState(null);
  const [hash, setHash] = useState('');
  const root = useRef(null);
  const buttons = useRef({});
  useEffect(() => {
    const update = () => { setHash(location.hash); setOpen(null); };
    update(); window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(null); };
    const escape = event => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(null); buttons.current[open]?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const current = activeGroup(path, hash);
  return <div className="desktop-links task-menus" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(null); }}>
    {GROUPS.map(group => <div className="task-disclosure" key={group.id}>
      <button type="button" ref={node => { buttons.current[group.id] = node; }} aria-expanded={open === group.id} aria-controls={`nav-${group.id}`} aria-current={current === group.id ? 'true' : undefined} onClick={() => setOpen(open === group.id ? null : group.id)}>{group.title}<span aria-hidden="true">⌄</span></button>
      <div className="task-panel" id={`nav-${group.id}`} hidden={open !== group.id} aria-label={`${group.title} tasks`}>
        {menuTasks(group.id).map(task => <a key={task.id} href={task.href} onClick={() => setOpen(null)}><strong>{task.title}</strong><span>{task.description}</span></a>)}
      </div>
    </div>)}
  </div>;
}

export function MobileGroups({ onNavigate }) {
  return <div className="mobile-task-groups"><a className="mobile-home" href="/" onClick={onNavigate}>Home</a>{GROUPS.map(group => <section key={group.id} aria-labelledby={`mobile-${group.id}`}><h2 id={`mobile-${group.id}`}>{group.title}</h2><ul>{menuTasks(group.id).map(task => <li key={task.id}><a href={task.href} onClick={onNavigate}>{task.title}<span>{task.description}</span></a></li>)}</ul></section>)}</div>;
}
