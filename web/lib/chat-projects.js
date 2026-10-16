// J183: reuse the router's project header and the existing encrypted history document.
export function projectFields(value = {}) {
  if (value.project === undefined) return {};
  if (value.project === null) return { project: null };
  if (typeof value.project !== 'string' || !/^[a-zA-Z0-9._-]{1,48}$/.test(value.project)) throw new Error('Project must be 1–48 characters using only letters, numbers, dots, underscores or hyphens.');
  return { project: value.project.toLowerCase() };
}
export function effectiveProject(chat = {}, folder = null) {
  return projectFields(chat).project || projectFields(folder || {}).project || null;
}
export function projectHeaders(project) {
  return project ? { 'X-Anyroute-Project': projectFields({ project }).project } : {};
}
export function projectFolder(scope) {
  if (!scope?.history?.unlocked) return null;
  const chat = scope.history.get(scope.chatId);
  return scope.history.listFolders().find(folder => folder.id === chat?.folderId) || null;
}
export function setFolderProject(state, id, project) {
  const fields = projectFields({ project });
  if (!state.folders.some(folder => folder.id === id)) throw new Error('That folder is no longer available.');
  return { ...state, folders: state.folders.map(folder => folder.id === id ? { ...folder, ...fields } : folder) };
}
// Snapshot before entering the existing limits/approval controller. Retries keep this header.
export const projectStream = (stream, current) => options => {
  const project = current();
  return stream(project ? { ...options, headers: { ...options.headers, ...projectHeaders(project) } } : options);
};
export function restoreChatProject(chat, lanes) {
  return lanes.map(lane => ({ ...lane, ...projectFields(chat) }));
}
// A project budget refusal is already human-readable. It must not become an Add funds error.
export const projectBudgetRefusal = error => error?.type === 'project_budget_exceeded';
