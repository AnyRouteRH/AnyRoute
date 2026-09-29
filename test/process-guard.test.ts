import { describe, expect, test } from "bun:test";
import { isAbsorbableNetworkError } from "../src/lib/process-guard.ts";

const run = async (code: string) => {
  const p = Bun.spawn(["bun", "-e", code], { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" });
  return { exit: await p.exited, out: await new Response(p.stdout).text() };
};

describe("process guard", () => {
  test("classifies only upstream connection failures as absorbable", () => {
    expect(isAbsorbableNetworkError(Object.assign(new Error("connect ECONNREFUSED host:443"), { code: "ECONNREFUSED", syscall: "connect" }))).toBe(true);
    expect(isAbsorbableNetworkError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(true);
    expect(isAbsorbableNetworkError(new TypeError("undefined is not a function"))).toBe(false);
    expect(isAbsorbableNetworkError(Object.assign(new Error("x"), { code: "ERR_ASSERTION" }))).toBe(false);
    expect(isAbsorbableNetworkError(null)).toBe(false);
  });

  test("an unhandled connection error event does not kill the process; any other uncaught error still does", async () => {
    const setup = `import { installProcessGuard } from "./src/lib/process-guard.ts"; import { EventEmitter } from "node:events"; installProcessGuard(() => { console.log("FATAL"); process.exit(3); });`;
    const survives = await run(`${setup} setTimeout(() => { console.log("ALIVE"); process.exit(0); }, 100); setTimeout(() => new EventEmitter().emit("error", Object.assign(new Error("connect ECONNREFUSED h:443"), { code: "ECONNREFUSED", syscall: "connect" })), 0);`);
    expect(survives.out).toContain("ALIVE");
    expect(survives.exit).toBe(0);
    const dies = await run(`${setup} setTimeout(() => { throw new TypeError("a real bug"); }, 0); setTimeout(() => { console.log("ALIVE"); process.exit(0); }, 200);`);
    expect(dies.out).toContain("FATAL");
    expect(dies.exit).toBe(3);
  });
});
