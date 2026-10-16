import test from 'node:test';
import { commandPaletteCases } from './command-palette-cases.mjs';
for (const [name, run] of commandPaletteCases) test(`J181: ${name}`, run);
