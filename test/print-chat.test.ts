// H174: shared browser-only cases, using each runner’s own test registration.
import { test } from "bun:test";
import { registerPrintChatTests } from "../web/tests/print-chat-cases.mjs";
registerPrintChatTests(test);
