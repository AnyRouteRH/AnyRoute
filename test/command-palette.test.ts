// J181: no database, Redis or new backend route is needed for these browser actions.
import { test } from 'bun:test';
import { commandPaletteCases } from '../web/tests/command-palette-cases.mjs';
for (const [name, run] of commandPaletteCases) test(`J181: ${name}`, run);
