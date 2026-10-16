import { test } from 'bun:test';
import { chatProjectCases } from '../web/tests/chat-projects-cases.mjs';
for (const [name, run] of chatProjectCases) test(`J183: ${name}`, run);
