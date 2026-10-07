// C126: only the appearance preference is saved; no account or request data.
export const THEME_KEY = 'anyroute-theme-v1';
export const THEMES = ['light', 'dark', 'device'];
export const themeChoice = value => THEMES.includes(value) ? value : 'device';
export function readTheme(storage) {
  try { return themeChoice(storage.getItem(THEME_KEY)); } catch { return 'device'; }
}
export function applyTheme(root, choice) {
  const theme = themeChoice(choice);
  if (theme === 'device') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  return theme;
}
export function saveTheme(root, storage, choice) {
  const theme = applyTheme(root, choice);
  try { if (theme === 'device') storage.removeItem(THEME_KEY); else storage.setItem(THEME_KEY, theme); } catch {}
  return theme;
}
// Runs in <head>, before body parsing. Device mode stays CSS-driven, including device changes.
export const THEME_SCRIPT = `(function(){var t;try{t=localStorage.getItem('${THEME_KEY}')}catch(e){}if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)})();`;
