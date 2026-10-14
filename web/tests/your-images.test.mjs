import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { yourImagesCases } from './your-images-cases.mjs';
import { collectYourImages, filterYourImages, yourImagesAccess } from '../lib/your-images.js';
import { imageFile, safeImageUrl } from '../lib/harness-images.js';

for (const [name, run] of yourImagesCases) test(`H167: ${name}`, run);
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const compile = source => execFileSync('bun', ['-e', 'process.stdout.write(new Bun.Transpiler({loader:"jsx",target:"node",tsconfig:{compilerOptions:{jsx:"react",jsxFactory:"React.createElement",jsxFragmentFactory:"React.Fragment"}}}).transformSync(await Bun.stdin.text()));'], { input: source, encoding: 'utf8' }).replace(/^import .*;\n/gm, '').replace(/^export default /gm, '').replace(/^export /gm, '');

test('H167: gallery renders labelled filters, existing image actions and locked access without reading history', () => {
  const GeneratedImages = new Function('React', 'useState', 'imageFile', 'safeImageUrl', 's', compile(read('../components/harness/GeneratedImages.jsx')) + '\nreturn GeneratedImages;')(React, React.useState, imageFile, safeImageUrl, {});
  const { YourImagesContent, YourImagesInputProvider } = new Function('React', 'createContext', 'useContext', 'useMemo', 'useState', 'collectYourImages', 'filterYourImages', 'yourImagesAccess', 'Modal', 'GeneratedImages', 's', compile(read('../components/harness/YourImages.jsx')) + '\nreturn { YourImagesContent, YourImagesInputProvider };')(React, React.createContext, React.useContext, React.useMemo, React.useState, collectYourImages, filterYourImages, yourImagesAccess, () => null, GeneratedImages, {});
  const locked = { unlocked: false, list() { throw Error('locked'); } };
  const markup = renderToStaticMarkup(React.createElement(YourImagesContent, { history: locked }));
  assert.match(markup, /Keep history on this device/); assert.match(markup, /Open history settings/);
  assert.doesNotMatch(markup, /<img|<input|<select/);
  const history = { unlocked: true, list: () => [{ id: 'chat' }], get: () => ({ id: 'chat', title: 'Tree', at: 1000, lanes: [{ modelId: 'sample/image', messages: [{ id: 'u', role: 'user', text: 'Draw a tree' }, { id: 'a', role: 'assistant', images: ['data:image/png;base64,aW1hZ2U='] }] }] }) };
  const html = renderToStaticMarkup(React.createElement(YourImagesInputProvider, { onUse: () => {} }, React.createElement(YourImagesContent, { history })));
  for (const label of ['Search prompts', 'All models', 'Draw a tree', 'Chat saved', 'Download', 'Use as input', 'Open chat']) assert.ok(html.includes(label), label);
  assert.match(html, /type="search"/); assert.match(html, /<select/); assert.match(html, /<time dateTime=/);
  const noInput = renderToStaticMarkup(React.createElement(YourImagesContent, { history }));
  assert.match(noInput, /disabled=""[^>]*aria-label="Use generated image/);
});
