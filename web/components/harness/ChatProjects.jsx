"use client";
// J183: current chat and folder controls share the existing history bridge.
import { createContext, useContext, useEffect, useId, useState } from 'react';
import { api } from '../../lib/api.js';
import { effectiveProject, projectFields, projectFolder } from '../../lib/chat-projects.js';
import { Modal } from '../UI';
import s from './ChatProjects.module.css';

const Projects = createContext(null);
export function ChatProjectsProvider({ value, children }) { return <Projects.Provider value={value}>{children}</Projects.Provider>; }
export function useChatProject() {
  const value = useContext(Projects);
  return value ? effectiveProject(value.lanes[0], projectFolder(value.scope)) : null;
}
export function ChatProjectCost({ children }) {
  const project = useChatProject();
  return <span className={s.cost}>{children}{project && <span role="status">Project: {project}</span>}</span>;
}
export function ChatProjectPicker() {
  const value = useContext(Projects), project = useChatProject();
  const [open, setOpen] = useState(false);
  if (!value) return null;
  const folder = projectFolder(value.scope);
  return <div className={s.root}>
    <button type="button" className="text-button" disabled={value.busy} aria-haspopup="dialog" onClick={() => setOpen(true)}>Project: {project || 'Key default'}</button>
    <ProjectBudget key={`${value.apiKey}:${project}`} project={project} apiKey={value.apiKey} busy={value.busy} />
    {open && <ProjectEditor title="Chat project" project={value.lanes[0]?.project} apiKey={value.apiKey} inherited={folder?.project} onClose={() => setOpen(false)} onSave={async project => {
      value.setLanes(lanes => lanes.map(lane => ({ ...lane, project })));
    }} />}
  </div>;
}
export function FolderProjectEditor({ folder, disabled, onSave }) {
  const value = useContext(Projects);
  const [open, setOpen] = useState(false);
  return <div className={s.root}>
    <button type="button" className="text-button" disabled={disabled} aria-haspopup="dialog" onClick={() => setOpen(true)}>Project{folder.project ? `: ${folder.project}` : ''}</button>
    {open && <ProjectEditor title={`Project for ${folder.name}`} project={folder.project} apiKey={value?.apiKey} folder onClose={() => setOpen(false)} onSave={onSave} />}
  </div>;
}
function ProjectEditor({ title, project, inherited, apiKey, folder, onSave, onClose }) {
  const id = useId();
  const [text, setText] = useState(project || ''), [names, setNames] = useState([]);
  const [error, setError] = useState(''), [note, setNote] = useState(''), [pending, setPending] = useState(false);
  const load = async () => {
    if (!apiKey) return;
    try { const result = await api('/api/v1/projects', { key: apiKey }); setNames(result.data || []); }
    catch { setNote('Saved projects are unavailable for this key. You can still enter a project name.'); }
  };
  return <Modal title={title} onClose={pending ? () => {} : onClose}>
    <form className={s.editor} onSubmit={async event => {
      event.preventDefault(); setError('');
      try { const next = text.trim() ? projectFields({ project: text.trim() }).project : null; setPending(true); await onSave(next); onClose(); }
      catch (error) { setError(error.message || 'The project could not be saved.'); }
      finally { setPending(false); }
    }}>
      <p>{folder ? 'Chats in this folder use this project unless they choose their own.' : 'Tag future requests from this chat, across every model. Earlier charges keep their original project.'}</p>
      <label htmlFor={id}>Project name</label>
      <input id={id} autoFocus list={`${id}-names`} value={text} maxLength={48} disabled={pending} onFocus={load} onChange={event => setText(event.target.value)} aria-describedby={`${id}-help`} />
      <datalist id={`${id}-names`}>{names.map(row => <option key={row.name} value={row.name} />)}</datalist>
      <p id={`${id}-help`}>Use letters, numbers, dots, underscores or hyphens. Leave empty to use {inherited ? `the folder project (${inherited})` : 'the key’s default project'}. Choose non-sensitive names: Anyroute can read project labels.</p>
      <p>Project budgets apply across all tagged calls in the account. <a href="/dashboard/#insights">Manage project budgets in Insights</a>. {folder ? 'Folder defaults need unlocked history.' : 'Enable history to keep this choice after closing Chat.'}</p>
      {note && <p role="status">{note}</p>}{error && <p role="alert">{error}</p>}
      <div className={s.actions}><button type="submit" className="text-button" disabled={pending}>{pending ? 'Saving…' : 'Save project'}</button><button type="button" className="text-button" disabled={pending} onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>;
}

function ProjectBudget({ project, apiKey, busy }) {
  const [budget, setBudget] = useState(null);
  useEffect(() => {
    if (!project || !apiKey || busy) return;
    let live = true;
    api(`/api/v1/projects/${encodeURIComponent(project)}/budget`, { key: apiKey }).then(result => { if (live) setBudget(result.data); }).catch(() => {});
    return () => { live = false; };
  }, [project, apiKey, busy]);
  if (!budget || budget.budget_usd === null) return null;
  return <p className={s.budget}>Project this month: ${budget.spent_usd} of ${budget.budget_usd}{Number(budget.held_usd) > 0 ? ` · $${budget.held_usd} reserved` : ''} · <a href="/dashboard/#insights">Manage budget</a></p>;
}
