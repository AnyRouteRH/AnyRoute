import { test } from "bun:test";
import { folderInstructionCases } from "../web/tests/folder-instructions-cases.mjs";
// G157: run with either external services or the in-process CI setup.
for (const [name, run] of folderInstructionCases) test(`G157: ${name}`, run);
