// K191: the same browser-only behaviour runs with and without service fixtures.
import { test } from 'bun:test';
import { registerMessagePinTests } from '../web/tests/message-pins-cases.mjs';
registerMessagePinTests(test);
