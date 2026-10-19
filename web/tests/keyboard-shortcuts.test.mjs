import test from 'node:test';
import { keyboardShortcutCases } from './keyboard-shortcuts-cases.mjs';
for (const [name, run] of keyboardShortcutCases) test('K193: ' + name, run);
