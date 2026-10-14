// H175: selections stay in page memory until inserted into the existing draft.
export const QUOTE_LIMIT = 1500;
export const ASK_SHORTCUT = 'Alt+Shift+Q';

export function quoteSelection(text) {
  const chars = Array.from(String(text).replace(/\r\n?/g, '\n').trim());
  if (!chars.length) return '';
  const clipped = chars.length > QUOTE_LIMIT ? chars.slice(0, QUOTE_LIMIT - 1).join('') + '…' : chars.join('');
  return clipped.split('\n').map(line => `> ${line}`).join('\n');
}

export function insertQuote(draft, text, cursor = draft.length) {
  const quote = quoteSelection(text);
  if (!quote) return { text: draft, cursor };
  const point = Math.max(0, Math.min(draft.length, cursor));
  const line = (point === 0 ? -1 : draft.lastIndexOf('\n', point - 1)) + 1;
  const addition = quote + '\n\n';
  return { text: draft.slice(0, line) + addition + draft.slice(line), cursor: point + addition.length };
}

const element = node => node?.nodeType === 1 ? node : node?.parentElement;
const reply = node => element(node)?.closest('[data-ask-about-reply]');
const editable = node => element(node)?.closest('input, textarea, select, button, dialog, [contenteditable="true"], [role="dialog"]');

export function selectedReply(selection, root) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !root) return null;
  const start = reply(selection.anchorNode), end = reply(selection.focusNode);
  if (!start || start !== end || !root.contains(start) || editable(selection.anchorNode) || editable(selection.focusNode)) return null;
  const range = selection.getRangeAt(0);
  if (!start.contains(range.startContainer) || !start.contains(range.endContainer)) return null;
  const text = selection.toString(); // Native selection text, including rendered code, without Markdown markup.
  if (!text.trim()) return null;
  const rects = Array.from(range.getClientRects());
  const rect = rects.findLast(rect => rect.width > 0 && rect.height > 0);
  return rect ? { text, rect } : null;
}

export function quotePosition(rect, viewport) {
  const left = viewport.offsetLeft || 0, top = viewport.offsetTop || 0;
  if (rect.bottom < top || rect.top > top + viewport.height || rect.right < left || rect.left > left + viewport.width) return null;
  return {
    left: Math.max(left + 8, Math.min(rect.left, left + viewport.width - 168)),
    top: Math.max(top + 8, Math.min(rect.bottom + 12, top + viewport.height - 56)),
  };
}

// The current focused lane already uses this shared composer; never create another draft or change lanes.
export function bindAskAboutThis({ document, window, root, input, setDraft, onChange }) {
  let current = null, dismissed = false, frame = null;
  const update = () => {
    current = dismissed ? null : selectedReply(window.getSelection(), root);
    const viewport = window.visualViewport || { width: window.innerWidth, height: window.innerHeight };
    onChange(current ? quotePosition(current.rect, viewport) : null);
  };
  const selectionChanged = () => { dismissed = false; update(); };
  const ask = () => {
    // Revalidate at activation, rather than quoting a stale selection after a chat change.
    const selected = selectedReply(window.getSelection(), root);
    if (!selected || dismissed || !input.isConnected) return false;
    const position = input.selectionStart;
    const next = insertQuote(input.value, selected.text, position);
    setDraft(next.text);
    frame = window.requestAnimationFrame(() => {
      input.focus({ preventScroll: true });
      input.setSelectionRange(next.cursor, next.cursor);
    });
    dismissed = true;
    current = null;
    onChange(null);
    window.getSelection()?.removeAllRanges();
    return true;
  };
  const keydown = event => {
    if (event.key === 'Escape') { dismissed = true; current = null; onChange(null); }
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyQ' && !event.isComposing && !editable(event.target)) {
      if (ask()) event.preventDefault();
    }
  };
  document.addEventListener('selectionchange', selectionChanged);
  document.addEventListener('keydown', keydown);
  document.addEventListener('pointerup', update);
  window.addEventListener('scroll', update, true);
  window.addEventListener('resize', update);
  window.visualViewport?.addEventListener('resize', update);
  window.visualViewport?.addEventListener('scroll', update);
  update();
  return { ask, dispose() {
    document.removeEventListener('selectionchange', selectionChanged);
    document.removeEventListener('keydown', keydown);
    document.removeEventListener('pointerup', update);
    window.removeEventListener('scroll', update, true);
    window.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('scroll', update);
    if (frame !== null) window.cancelAnimationFrame(frame);
  } };
}
