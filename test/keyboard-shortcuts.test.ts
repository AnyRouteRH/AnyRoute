import { test } from 'bun:test';
import { keyboardShortcutCases } from '../web/tests/keyboard-shortcuts-cases.mjs';
for (const [name, run] of keyboardShortcutCases) test('K193: ' + name, run);
