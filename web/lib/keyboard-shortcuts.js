// K193: one browser-only registry for discovery, control attributes and key matching.
const shortcut = (id, group, label, aria, more = {}) => Object.freeze({ id, group, label, aria, ...more });
export const SHORTCUTS = Object.freeze([
  shortcut('shortcuts', 'Everywhere', 'Keyboard shortcuts', '?'),
  shortcut('site-search', 'Everywhere', 'Find anything', 'Meta+K Control+K'),
  shortcut('focus-search', 'Everywhere', 'Focus search', '/', { note: 'Outside a field, on every page except Chat. Opens Find anything.' }),
  shortcut('go-agents', 'Everywhere', 'Go to Agents', '', { sequence: ['g', 'a'], note: 'Press G, then A.' }),
  shortcut('search-choose', 'Everywhere', 'Choose a search result', 'ArrowUp ArrowDown', { note: 'In Find anything. Also works in Chat model and prompt suggestions.' }),
  shortcut('search-open', 'Everywhere', 'Open the selected result', 'Enter', { note: 'In Find anything or Chat suggestions.' }),
  shortcut('close', 'Everywhere', 'Close a dialog or go back', 'Escape'),
  shortcut('chat-model', 'Chat', 'Change model', 'Meta+Shift+K Control+Shift+K', { page: '/harness', selector: '[data-harness-app] button[aria-label^="Model:"]' }),
  shortcut('chat-prompts', 'Chat', 'Open prompt library', 'Meta+Shift+P Control+Shift+P', { page: '/harness', selector: '#prompt-library' }),
  shortcut('chat-history', 'Chat', 'Search chat history', 'Meta+K Control+K', { page: '/harness', note: 'While the history dialog is open. Otherwise opens Find anything.' }),
  shortcut('chat-export', 'Chat', 'Export current chat', 'Meta+Shift+E Control+Shift+E', { page: '/harness', note: 'Opens the existing history access or export dialog.' }),
  shortcut('chat-ask', 'Chat', 'Ask about this', 'Alt+Shift+Q', { page: '/harness', code: 'KeyQ', note: 'Select part of an answer first, outside a field.' }),
  shortcut('chat-send', 'Chat', 'Send a message', 'Enter', { page: '/harness', selector: '#harness-input', note: 'In the message field. Chooses a prompt when suggestions are open.' }),
  shortcut('chat-newline', 'Chat', 'Start a new line', 'Shift+Enter', { page: '/harness', selector: '#harness-input' }),
  shortcut('chat-inline-prompts', 'Chat', 'Find a saved prompt', '/', { page: '/harness', note: 'Type /name in the message field, then use arrows and Enter.' }),
  shortcut('arena-run', 'Arena', 'Compare answers', 'Meta+Enter Control+Enter', { page: '/arena', note: 'In the prompt field.' }),
]);

export const getShortcut = id => {
  const entry = SHORTCUTS.find(row => row.id === id);
  if (!entry) throw new Error('Unknown shortcut: ' + id);
  return entry;
};
export const shortcutAria = id => getShortcut(id).aria;
export const shortcutsForPage = pathname => SHORTCUTS.filter(row => !row.page || row.page === pathname.replace(/\/$/, ''));
export const isMacPlatform = (platform = '') => /Mac|iPhone|iPad|iPod/i.test(platform);
export const browserPlatform = () => globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '';

export function shortcutLabel(id, platform = '') {
  const row = getShortcut(id);
  if (row.sequence) return row.sequence.map(key => key.toUpperCase()).join(' then ');
  const mac = isMacPlatform(platform);
  const keys = row.aria.split(' ');
  const modified = keys.find(key => key.includes(mac ? 'Meta+' : 'Control+'));
  const chosen = modified ? [modified] : keys;
  const names = mac ? { Meta: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓' }
    : { Meta: 'Meta', Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓' };
  return chosen.map(binding => binding.split('+').map(key => names[key] || (key.length === 1 ? key.toUpperCase() : key)).join(mac ? ' ' : '+')).join(' / ');
}

export function matchesShortcut(event, id) {
  if (event.defaultPrevented || event.isComposing || event.repeat) return false;
  const row = getShortcut(id);
  return row.aria.split(' ').filter(Boolean).some(binding => {
    const parts = binding.split('+'), key = parts.pop();
    // '?' is the produced character; Shift is already reflected in event.key.
    return (row.code ? event.code === row.code : String(event.key).toLowerCase() === key.toLowerCase())
      && !!event.metaKey === parts.includes('Meta') && !!event.ctrlKey === parts.includes('Control')
      && !!event.altKey === parts.includes('Alt') && (key === '?' || !!event.shiftKey === parts.includes('Shift'));
  });
}

export function isTypingTarget(target) {
  const element = target?.nodeType === 3 ? target.parentElement : target;
  return !!element?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"]');
}

// Add registry attributes without rewriting the shared Chat markup. Called after Chat renders.
export function applyChatShortcutAttributes(document) {
  const attributes = new Map();
  for (const row of SHORTCUTS.filter(row => row.selector)) {
    for (const control of document.querySelectorAll(row.selector)) {
      attributes.set(control, [...(attributes.get(control) || []), row.aria]);
    }
  }
  for (const [control, keys] of attributes) control.setAttribute('aria-keyshortcuts', keys.join(' '));
}

export const SHORTCUTS_EVENT = 'anyroute:keyboard-shortcuts';
export const openKeyboardShortcuts = () => globalThis.window?.dispatchEvent(new Event(SHORTCUTS_EVENT));

export function bindKeyboardShortcuts({ document, window, onOpen, navigate, now = () => Date.now() }) {
  let started = null;
  const reset = () => { started = null; };
  const keydown = event => {
    if (event.defaultPrevented || event.isComposing || event.repeat || isTypingTarget(event.target) || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) { reset(); return; }
    if (matchesShortcut(event, 'shortcuts')) { reset(); event.preventDefault(); onOpen(); return; }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) { reset(); return; }
    const [first, second] = getShortcut('go-agents').sequence;
    const key = String(event.key).toLowerCase(), at = now();
    if (started !== null && at - started <= 1000 && key === second) { reset(); event.preventDefault(); navigate('/agents/'); }
    else started = key === first ? at : null;
  };
  document.addEventListener('keydown', keydown);
  document.addEventListener('pointerdown', reset);
  window.addEventListener('blur', reset);
  return () => { document.removeEventListener('keydown', keydown); document.removeEventListener('pointerdown', reset); window.removeEventListener('blur', reset); };
}
