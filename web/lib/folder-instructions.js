// G157: metadata in the existing folder document, with no separate storage.
export const MAX_FOLDER_INSTRUCTIONS = 4000;

export function instructionFields(folder) {
  const value = folder.instructions;
  if (value === undefined) return {};
  if (typeof value !== 'string' || value.length > MAX_FOLDER_INSTRUCTIONS) throw new Error('Use folder instructions of up to 4,000 characters.');
  return value.trim() ? { instructions: value } : {};
}

export function setFolderInstructions(state, id, instructions) {
  const fields = instructionFields({ instructions });
  if (!state.folders.some(folder => folder.id === id)) throw new Error('That folder is no longer available.');
  return { ...state, folders: state.folders.map(folder => {
    if (folder.id !== id) return folder;
    const { instructions: previous, ...rest } = folder;
    return { ...rest, ...fields };
  }) };
}

export function chatFolder(chats, folders, chatId) {
  const id = chats.find(chat => chat.id === chatId)?.folderId;
  return folders.find(folder => folder.id === id) || null;
}

// Keep the old string path exactly as it was when no instructions apply.
export function folderSystems(system = '', instructions = '') {
  if (!instructions.trim()) return system;
  return [instructions.trim(), ...(system.trim() ? [system.trim()] : [])];
}
export const systemMessages = system => (Array.isArray(system) ? system : [system]).filter(text => text.trim()).map(text => ({ role: 'system', content: text.trim() }));
export const systemIdentity = system => Array.isArray(system) ? JSON.stringify(system) : system;
export const systemText = system => Array.isArray(system) ? system.join('\n') : system;

export function activeFolder(scope) {
  if (!scope?.history?.unlocked) return null;
  const chat = scope.history.get(scope.chatId);
  return chat ? chatFolder([chat], scope.history.listFolders(), scope.chatId) : null;
}
