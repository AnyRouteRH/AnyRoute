"use client";
// D143: controls shared by the existing history list and its chat actions.
import { useId, useState } from 'react';
import { folderCounts } from '../../lib/chat-folders.js';
import s from './ChatFolders.module.css';

export const FOLDER_DRAG_TYPE = 'application/x-anyroute-chat-id';
export function ChatFolderMove({ chat, folders, disabled, onMove }) {
  return <details className={s.move}>
    <summary aria-label={`Move ${chat.title} to a folder`}>Move to…</summary>
    <div role="group" aria-label="Choose a folder">
      <button type="button" disabled={disabled || !chat.folderId} onClick={() => onMove(null)}>All chats</button>
      {folders.map(folder => <button type="button" key={folder.id} disabled={disabled || folder.id === chat.folderId} onClick={() => onMove(folder.id)}>{folder.name}{folder.id === chat.folderId ? ' · Current folder' : ''}</button>)}
      {!folders.length && <span>Create a folder to group this chat.</span>}
    </div>
  </details>;
}

export default function ChatFolders({ chats, folders, selected, onSelect, disabled, onCreate, onRename, onDelete, onMove }) {
  const id = useId();
  const [editing, setEditing] = useState(null), [name, setName] = useState('');
  const counts = folderCounts(chats, folders);
  const active = folders.find(folder => folder.id === selected);
  const begin = mode => { setEditing(mode); setName(mode === 'rename' ? active.name : ''); };
  const drop = (event, folderId) => {
    const chatId = event.dataTransfer.getData(FOLDER_DRAG_TYPE);
    if (!disabled && chats.some(chat => chat.id === chatId)) { event.preventDefault(); onMove(chatId, folderId); }
  };
  const target = folderId => ({
    onDragOver: event => { if (!disabled && [...event.dataTransfer.types].includes(FOLDER_DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } },
    onDrop: event => drop(event, folderId),
  });
  return <aside className={s.sidebar} aria-label="Chat folders">
    <label className={s.mobile} htmlFor={id}>Folder
      <select id={id} value={selected || ''} disabled={disabled} onChange={event => { onSelect(event.target.value || null); setEditing(null); }}>
        <option value="">All chats ({chats.length})</option>
        {counts.map(folder => <option key={folder.id} value={folder.id}>{folder.name} ({folder.count})</option>)}
      </select>
    </label>
    <nav className={s.desktop} aria-label="Choose a chat folder">
      <button type="button" aria-current={!selected ? 'true' : undefined} disabled={disabled} onClick={() => { onSelect(null); setEditing(null); }} {...target(null)}>All chats <span>{chats.length}</span></button>
      {counts.map(folder => <button type="button" key={folder.id} aria-current={selected === folder.id ? 'true' : undefined} disabled={disabled} onClick={() => { onSelect(folder.id); setEditing(null); }} {...target(folder.id)}>{folder.name} <span>{folder.count}</span></button>)}
    </nav>
    <div className={s.controls}>
      <button type="button" className="text-button" disabled={disabled} onClick={() => begin('create')}>New folder</button>
      {active && <>
        <button type="button" className="text-button" disabled={disabled} onClick={() => begin('rename')}>Rename folder</button>
        <button type="button" className="text-button" disabled={disabled} onClick={() => begin('delete')}>Delete folder</button>
      </>}
    </div>
    {editing && editing !== 'delete' && <form className={s.editor} onSubmit={async event => {
      event.preventDefault();
      const success = await (editing === 'create' ? onCreate(name) : onRename(selected, name));
      if (success) setEditing(null);
    }}>
      <label htmlFor={`${id}-name`}>{editing === 'create' ? 'New folder name' : 'Folder name'}</label>
      <input id={`${id}-name`} autoFocus value={name} maxLength={80} disabled={disabled} onChange={event => setName(event.target.value)} />
      <button type="submit" className="text-button" disabled={disabled || !name.trim()}>Save folder</button>
      <button type="button" className="text-button" disabled={disabled} onClick={() => setEditing(null)}>Cancel</button>
    </form>}
    {editing === 'delete' && active && <div className={s.editor}>
      <p>Delete “{active.name}”? Its chats return to All chats. Every chat is kept.</p>
      <button type="button" className="text-button" disabled={disabled} onClick={async () => { if (await onDelete(selected)) setEditing(null); }}>Delete folder and keep chats</button>
      <button type="button" className="text-button" disabled={disabled} onClick={() => setEditing(null)}>Cancel</button>
    </div>}
  </aside>;
}
