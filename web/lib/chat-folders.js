import { mergeSavedAnswers, savedAnswersFromExport } from "./saved-answers.js";
// D143: folders are metadata inside the existing encrypted history, never a separate browser store.
import { buildSearchIndex, mergeImport, parseImport, searchChats } from './harness-history.js';

export const MAX_FOLDERS = 40;
const folderError = () => { throw new Error('Choose a history export with valid folders.'); };
const validId = value => typeof value === 'string' && !!value.trim() && value.length <= 200;
const nameOf = value => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new Error('Give the folder a name of up to 80 characters.');
  return value.trim();
};
const key = name => name.toLowerCase();
export function validateFolders(folders = []) {
  if (!Array.isArray(folders) || folders.length > MAX_FOLDERS) folderError();
  const ids = new Set(), names = new Set();
  return folders.map(folder => {
    if (!folder || !validId(folder.id)) folderError();
    const name = nameOf(folder.name);
    if (ids.has(folder.id) || names.has(key(name))) folderError();
    ids.add(folder.id); names.add(key(name));
    return { id: folder.id, name };
  });
}
export function folderFields(chat) {
  if (chat.folderId === undefined || chat.folderId === null) return {};
  if (!validId(chat.folderId)) folderError();
  return { folderId: chat.folderId };
}
export function folderDocument(chats, folders) {
  const clean = validateFolders(folders);
  for (const chat of chats) {
    const { folderId } = folderFields(chat);
    if (folderId && !clean.some(folder => folder.id === folderId)) folderError();
  }
  return { chats, folders: clean };
}
export function createFolder(state, name, id) {
  const cleanName = nameOf(name);
  if (!validId(id) || state.folders.some(folder => folder.id === id)) throw new Error('Choose another folder.');
  if (state.folders.length >= MAX_FOLDERS) throw new Error('There is room for up to 40 folders.');
  if (state.folders.some(folder => key(folder.name) === key(cleanName))) throw new Error('A folder already has that name.');
  return { ...state, folders: [...state.folders, { id, name: cleanName }] };
}
export function renameFolder(state, id, name) {
  const cleanName = nameOf(name);
  if (!state.folders.some(folder => folder.id === id)) throw new Error('That folder is no longer available.');
  if (state.folders.some(folder => folder.id !== id && key(folder.name) === key(cleanName))) throw new Error('A folder already has that name.');
  return { ...state, folders: state.folders.map(folder => folder.id === id ? { ...folder, name: cleanName } : folder) };
}
export function moveChat(state, id, folderId = null) {
  if (!state.chats.some(chat => chat.id === id)) throw new Error('That chat is no longer available.');
  if (folderId !== null && !state.folders.some(folder => folder.id === folderId)) throw new Error('That folder is no longer available.');
  return { ...state, chats: state.chats.map(chat => {
    if (chat.id !== id) return chat;
    const { folderId: previous, ...rest } = chat;
    return folderId === null ? rest : { ...rest, folderId };
  }) };
}
export function deleteFolder(state, id) {
  return { ...state, folders: state.folders.filter(folder => folder.id !== id), chats: state.chats.map(chat => {
    if (chat.folderId !== id) return chat;
    const { folderId, ...rest } = chat;
    return rest;
  }) };
}
export function folderCounts(chats, folders) {
  return folders.map(folder => ({ ...folder, count: chats.filter(chat => chat.folderId === folder.id).length }));
}
export function searchFolder(chats, query, folderId = null) {
  return searchChats(buildSearchIndex(folderId === null ? chats : chats.filter(chat => chat.folderId === folderId)), query);
}
export function parseFolderImport(source) {
  const chats = parseImport(source);
  const savedAnswers = savedAnswersFromExport(source);
  return { ...folderDocument(chats, JSON.parse(source).folders), ...(savedAnswers.length ? { savedAnswers } : {}) };
}
// Existing chats always win; imported folder ids are remapped when another folder owns the id.
export function mergeFolderImport(existing, incoming, makeId) {
  const folders = [...existing.folders], mapping = new Map();
  for (const folder of incoming.folders) {
    const sameName = folders.find(held => key(held.name) === key(folder.name));
    if (sameName) { mapping.set(folder.id, sameName.id); continue; }
    let id = folder.id;
    if (folders.some(held => held.id === id)) id = makeId();
    const next = createFolder({ chats: [], folders }, folder.name, id);
    folders.push(next.folders.at(-1)); mapping.set(folder.id, id);
  }
  const remapped = incoming.chats.map(chat => chat.folderId ? { ...chat, folderId: mapping.get(chat.folderId) } : chat);
  const { additions, skipped } = mergeImport(existing.chats, remapped);
  return { chats: [...existing.chats, ...additions].sort((a, b) => b.at - a.at), folders, count: additions.length, skipped };
}
export function folderVaultEdits({ serial, need, seal, maxBytes, makeId }) {
  const state = s => ({ chats: s.chats, folders: s.folders || [], savedAnswers: s.savedAnswers || [] });
  const change = fn => serial(async () => {
    const s = need(), next = fn(state(s));
    folderDocument(next.chats, next.folders);
    if (new TextEncoder().encode(JSON.stringify({ chats: next.chats, folders: next.folders })).length > maxBytes) throw new Error('History is full. Export or delete conversations before importing more.');
    await seal(s, next.chats, s.prompts, next.savedAnswers, next.folders);
    s.chats = next.chats; s.folders = next.folders; s.savedAnswers = next.savedAnswers;
    return next;
  });
  return {
    listFolders: () => structuredClone(need().folders || []),
    createFolder: name => change(state => createFolder(state, name, makeId())),
    renameFolder: (id, name) => change(state => renameFolder(state, id, name)),
    deleteFolder: id => change(state => deleteFolder(state, id)),
    moveChat: (id, folderId) => change(state => moveChat(state, id, folderId)),
    importFolderHistory: incoming => change(state => ({ ...mergeFolderImport(state, incoming, makeId), savedAnswers: mergeSavedAnswers(state.savedAnswers, incoming.savedAnswers || []) })),
  };
}
