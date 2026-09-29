import { UsageError } from "./args.ts";

// Terminal access for the CLI, behind an interface so tests can script the answers and read the output.

export type Io = {
  /** Normal output (stdout): the things a person copies. */
  out(text: string): void;
  /** Progress and prompts (stderr). */
  err(text: string): void;
  /** True when questions may be asked. */
  interactive: boolean;
  ask(question: string, defaultValue?: string): Promise<string>;
  close?(): void;
};

export function terminalIo(o: { yes?: boolean } = {}): Io {
  let rl: import("node:readline/promises").Interface | undefined;
  const interactive = !o.yes && !!process.stdin.isTTY && !!process.stderr.isTTY;
  return {
    out: (t) => void process.stdout.write(t.endsWith("\n") ? t : t + "\n"),
    err: (t) => void process.stderr.write(t.endsWith("\n") ? t : t + "\n"),
    interactive,
    async ask(question, defaultValue) {
      const { createInterface } = await import("node:readline/promises");
      rl ??= createInterface({ input: process.stdin, output: process.stderr });
      const answer = (await rl.question(`${question}${defaultValue ? ` [${defaultValue}]` : ""}: `)).trim();
      return answer || defaultValue || "";
    },
    close: () => rl?.close(),
  };
}

/** Ask until the answer passes `check` (which returns an error message, or null when fine). */
export async function askValid(io: Io, question: string, check: (v: string) => string | null, defaultValue?: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const v = await io.ask(question, defaultValue);
    const problem = check(v);
    if (!problem) return v;
    io.err(`  ${problem}`);
  }
  throw new UsageError(`${question}: no valid answer given`);
}

export async function askYesNo(io: Io, question: string, defaultYes: boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const v = (await io.ask(`${question} (${defaultYes ? "Y/n" : "y/N"})`)).toLowerCase();
    if (!v) return defaultYes;
    if (["y", "yes"].includes(v)) return true;
    if (["n", "no"].includes(v)) return false;
    io.err("  answer y or n");
  }
  throw new UsageError(`${question}: no valid answer given`);
}
