import { test } from 'bun:test';
import { yourImagesCases } from '../web/tests/your-images-cases.mjs';
// H167: browser-only behavior has no database, Redis or route dependency.
for (const [name, run] of yourImagesCases) test(`H167: ${name}`, run);
