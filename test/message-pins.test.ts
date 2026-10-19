// K191: the same browser-only behaviour runs with and without service fixtures. The cases render React, which only
// the web package installs; CI's root job doesn't, so there the web suite (web/tests/message-pins.test.mjs) covers them.
import { test } from 'bun:test';
const hasReact = (() => { try { Bun.resolveSync('react', new URL('../web/tests/', import.meta.url).pathname); return true; } catch { return false; } })();
if (hasReact) (await import('../web/tests/message-pins-cases.mjs')).registerMessagePinTests(test);
else test.skip('message pins (runs in the web suite, which has the web dependencies)', () => {});
