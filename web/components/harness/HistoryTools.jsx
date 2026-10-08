"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { savedAnswerOnScreen } from "../../lib/saved-answers.js"; // D140
import { MAX_BYTES } from "../../lib/private-history";
import { downloadChats, highlightParts, historyShortcut } from "../../lib/harness-history";
import { Button, Modal } from "../UI";
import ChatFolders, { ChatFolderMove, FOLDER_DRAG_TYPE } from "./ChatFolders"; // D143
import { parseFolderImport, searchFolder } from "../../lib/chat-folders.js"; // D143
import ChatCost from "./ChatCost"; // C128
import s from "./HistoryTools.module.css";

export function useHistoryKeys(onSearch, onExport) {
  const callbacks = useRef({ onSearch, onExport });
  callbacks.current = { onSearch, onExport };
  useEffect(() => {
    const key = (e) => {
      const action = historyShortcut(e);
      if (!action) return;
      // Let a passphrase or another modal finish first. Search in the history dialog already has focus.
      if (document.querySelector("dialog[open]") && !document.querySelector("[data-history-tools]")) return;
      e.preventDefault();
      if (action === "search") {
        const field = document.querySelector("[data-history-search]");
        if (field) { field.focus(); field.select(); } else callbacks.current.onSearch();
      } else callbacks.current.onExport();
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
}

function Highlight({ text, query }) {
  return highlightParts(text, query).map((p, i) => p.match ? <mark key={i}>{p.text}</mark> : p.text);
}

function ExportButtons({ onExport, disabled = false }) {
  return <div className={s.exportButtons}>
    <button type="button" className="text-button" disabled={disabled} onClick={() => onExport("md")}>Markdown</button>
    <button type="button" className="text-button" disabled={disabled} onClick={() => onExport("json")}>JSON</button>
  </div>;
}

export function ExportCurrent({ chat, savedAnswers = [], folders = [], onClose }) {
  const [error, setError] = useState("");
  return <Modal title="Export current chat" onClose={onClose}>
    <div className={s.body}>
      <p>Downloads contain readable message text. Keep them somewhere you trust. Nothing is uploaded.</p>
      <p>Includes saved text, model details, receipt IDs and attachment names. Attachment contents, reasoning and tool traffic are left out.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {chat ? <ExportButtons onExport={(format) => {
        try { downloadChats([chat], format, globalThis, { savedAnswers, folders: folders.filter(folder => folder.id === chat.folderId) }); onClose(); } catch (e) { setError(e.message); }
      }} /> : <p>Finish a message before exporting this conversation.</p>}
    </div>
  </Modal>;
}

export function HistoryAccess({ onEnable, onClose }) {
  return <Modal title="History on this device" onClose={onClose}>
    <div className={s.body}>
      <p>Saved conversations are available in Private mode. Enable it, then create or unlock the encrypted history with your passphrase.</p>
      <p>Search, pins, titles and imported chats stay in this browser. The router still reads ordinary requests in memory to route them.</p>
      <Button type="button" onClick={onEnable}>Enable Private mode</Button>
    </div>
  </Modal>;
}

export default function HistoryTools({ history, chats, current, busy, onChange, onOpen, onDelete, onLock, onClose }) {
  const [selected, setSelected] = useState(null), [searchAll, setSearchAll] = useState(false); // D143
  const [query, setQuery] = useState("");
  const [rename, setRename] = useState(null);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const field = useRef(null), file = useRef(null), live = useRef(true);
  useEffect(() => {
    live.current = true;
    const timer = setTimeout(() => field.current?.focus(), 0);
    return () => { live.current = false; clearTimeout(timer); };
  }, []);
  const all = useMemo(() => chats.map((c) => history.get(c.id)).filter(Boolean), [chats, history]);
  const folders = history.listFolders(); // D143
  const scope = selected && folders.some(folder => folder.id === selected) ? selected : null;
  const results = useMemo(() => searchFolder(all, query, searchAll && query.trim() ? null : scope), [all, query, scope, searchAll]);
  const groups = [
    ["Pinned", results.filter(({ chat }) => chat.pinned)],
    [scope && !(searchAll && query.trim()) ? folders.find(folder => folder.id === scope).name : "All chats", results.filter(({ chat }) => !chat.pinned)],
  ];
  const run = async (fn) => {
    setPending(true); setError(""); setNote("");
    try { await fn(); return true; } catch (e) { if (live.current) setError(e?.message || "History could not be updated."); return false; }
    finally { if (live.current) setPending(false); }
  };
  const exporting = (list, format) => {
    try {
      downloadChats(list, format, globalThis, {
        savedAnswers: history.listSavedAnswers().filter((a) => list === all || list.some((c) => c.id === a.chatId || savedAnswerOnScreen(a, c.lanes))),
        folders: list === all ? folders : folders.filter(folder => list.some(chat => chat.folderId === folder.id)),
      });
      setNote("Download ready. The file contains readable text."); setError("");
    } catch (e) { setError(e.message); }
  };
  const importFile = async (chosen) => {
    if (!chosen) return;
    await run(async () => {
      if (chosen.size > MAX_BYTES * 2) throw new Error("Choose a history JSON file smaller than 4 MB.");
      const incoming = parseFolderImport(await chosen.text());
      if (!live.current || !history.unlocked) return;
      const { count, skipped } = await history.importFolderHistory(incoming); // One encrypted write for chats, folders and saved answers.
      if (live.current && history.unlocked) {
        onChange();
        setNote(`Imported ${count} ${count === 1 ? "chat" : "chats"}. Skipped ${skipped} ${skipped === 1 ? "duplicate" : "duplicates"}.`);
      }
    });
  };
  return <Modal title="History on this device" onClose={onClose}>
    <div className={s.body} data-history-tools>
      <p>Encrypted in this browser. Search runs here while history is unlocked. Nothing is uploaded.</p>
      <label className={s.search}>
        <span className="sr-only">Search chat titles and messages</span>
        <input type="search" ref={field} data-history-search value={query} placeholder="Search titles and messages" autoComplete="off" spellCheck={false} aria-keyshortcuts="Meta+K Control+K" onChange={(e) => setQuery(e.target.value)} />
        <kbd>⌘ / Ctrl K</kbd>
      </label>
      {scope && <label className={s.scope}><input type="checkbox" checked={searchAll} onChange={event => setSearchAll(event.target.checked)} />Search all chats</label>}
      <div className={s.toolbar}>
        <span aria-live="polite">{results.length} {results.length === 1 ? "chat" : "chats"}{query.trim() ? " found" : " kept"}</span>
        <button type="button" className="text-button" disabled={pending} onClick={() => file.current?.click()}>Import JSON</button>
        <input ref={file} type="file" className="sr-only" tabIndex={-1} aria-label="Import history JSON" accept="application/json,.json" onChange={(e) => { const chosen = e.target.files?.[0]; e.target.value = ""; void importFile(chosen); }} />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className={s.note} role="status">{note}</p>}
      <div className={s.folderLayout}> {/* D143 */}
        <ChatFolders chats={all} folders={folders} selected={scope} onSelect={setSelected} disabled={pending || busy}
          onCreate={name => run(async () => { await history.createFolder(name); if (live.current && history.unlocked) onChange(); })}
          onRename={(id, name) => run(async () => { await history.renameFolder(id, name); if (live.current && history.unlocked) onChange(); })}
          onDelete={id => run(async () => { await history.deleteFolder(id); if (live.current && history.unlocked) { setSelected(null); onChange(); setNote("Folder deleted. Every chat is kept in All chats."); } })}
          onMove={(id, folderId) => void run(async () => { await history.moveChat(id, folderId); if (live.current && history.unlocked) { onChange(); setNote("Chat moved."); } })} />
      <div className={s.results}>
        {!results.length && <p className={s.note}>{query.trim() ? "No conversations match. Try another word." : scope ? "This folder is empty. Move a chat here from All chats." : "Nothing kept yet. A conversation is saved once its reply has finished."}</p>}
        {groups.map(([label, rows], group) => rows.length > 0 && <section key={group} aria-label={label}>
          <h3>{label}</h3>
          <ul>{rows.map(({ chat, snippet }) => <li key={chat.id} draggable={!pending && !busy && rename !== chat.id} onDragStart={event => { event.dataTransfer.setData(FOLDER_DRAG_TYPE, chat.id); event.dataTransfer.effectAllowed = "move"; }}>
            {rename === chat.id ? <form className={s.rename} onSubmit={(e) => { e.preventDefault(); void run(async () => { await history.edit(chat.id, { title }); if (live.current && history.unlocked) { onChange(); setRename(null); } }); }}>
              <label className="sr-only" htmlFor="chat-title">Chat title</label>
              <input id="chat-title" autoFocus value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setRename(null); } }} />
              <button type="submit" className="text-button" disabled={pending || !title.trim()}>Save</button>
              <button type="button" className="text-button" onClick={() => setRename(null)}>Cancel</button>
            </form> : <button type="button" className={s.open} disabled={busy || pending} onClick={() => onOpen(chat.id)}>
              <b><Highlight text={chat.title} query={query} /></b>
              <ChatCost chat={chat} /> {/* C128 */}
              <span>{new Date(chat.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {chat.lanes.reduce((n, l) => Math.max(n, l.messages.filter((m) => m.role === "user").length), 0)} turns</span>
              {snippet && <p><Highlight text={snippet} query={query} /></p>}
            </button>}
            <div className={s.actions} role="group" aria-label={`Actions for ${chat.title}`}>
              <button type="button" className="text-button" aria-pressed={chat.pinned === true} disabled={pending} onClick={() => void run(async () => { await history.edit(chat.id, { pinned: !chat.pinned }); if (live.current && history.unlocked) onChange(); })}>{chat.pinned ? "Unpin" : "Pin"}</button>
              <button type="button" className="text-button" disabled={pending} onClick={() => { setRename(chat.id); setTitle(chat.title); }}>Rename</button>
              <ChatFolderMove chat={chat} folders={folders} disabled={pending || busy} onMove={folderId => void run(async () => { await history.moveChat(chat.id, folderId); if (live.current && history.unlocked) { onChange(); setNote("Chat moved."); } })} /> {/* D143 */}
              <span className={s.exportLabel}>Export</span><ExportButtons onExport={(format) => exporting([chat], format)} />
              <button type="button" className={`text-button ${s.delete}`} aria-label={`Delete ${chat.title}`} disabled={pending || busy} onClick={() => void run(() => onDelete(chat.id))}>Delete</button>
            </div>
          </li>)}</ul>
        </section>)}
      </div>
      </div>
      <div className={s.exports}>
        {current && <div><span>Export current</span><ExportButtons disabled={busy} onExport={(format) => exporting([current], format)} /></div>}
        <div><span>Export all {all.length} saved chats</span><ExportButtons disabled={!all.length && !history.listSavedAnswers().length && !folders.length} onExport={(format) => exporting(all, format)} /></div>
        <p>Saved answers are included, even when their chats have been deleted.</p> {/* D140 */}
        <p>Downloads contain readable text, model details, receipt IDs and attachment names. Keep them somewhere you trust. Attachment contents, reasoning and tool traffic are left out.</p>
      </div>
      <Button type="button" secondary onClick={onLock}>Lock history</Button>
    </div>
  </Modal>;
}
