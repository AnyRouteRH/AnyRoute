import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { folderInstructionCases } from './folder-instructions-cases.mjs';
for (const [name, run] of folderInstructionCases) test(`G157: ${name}`, run);

test('G157: editor, chip, request refs and docs use the existing folder flow', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const component = read('../components/harness/FolderInstructions.jsx');
  assert.match(component, /Folder instructions on/);
  assert.match(component, /maxLength={MAX_FOLDER_INSTRUCTIONS}/);
  assert.match(component, /aria-expanded={open}/);
  assert.match(component, /htmlFor={`\$\{id\}-text`}/);
  assert.match(component, /event.key === 'Escape'/);
  assert.match(read('../components/Harness.jsx'), /systemRef.current = folderSystems\(system, folderInstructions\)/);
  assert.match(read('../components/harness/PrivateMode.jsx'), /FolderInstructionsBridge.*chatId={chatId.current}/);
  assert.match(read('../components/harness/ChatFolders.jsx'), /FolderInstructionsEditor.*folder={active}/);
  assert.match(read('../components/FolderInstructionsDocs.jsx'), /id="folder-instructions"/);
});
