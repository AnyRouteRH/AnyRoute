'use client';
import { openKeyboardShortcuts, shortcutAria } from '../../lib/keyboard-shortcuts';

export default function KeyboardShortcutsButton() {
  return <button type="button" className="text-button" aria-haspopup="dialog" aria-keyshortcuts={shortcutAria('shortcuts')} onClick={openKeyboardShortcuts}>Keyboard shortcuts</button>;
}
