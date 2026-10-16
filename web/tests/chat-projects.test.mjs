import { test } from 'node:test';
import { chatProjectCases } from './chat-projects-cases.mjs';
for (const [name, run] of chatProjectCases) test(`J183: ${name}`, run);
