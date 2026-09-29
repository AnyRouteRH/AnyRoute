import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Io } from "../src/onboard/io.ts";
import { tmpDir } from "./helpers.ts";

export type ScriptedIo = Io & { outText(): string; errText(): string; asked: string[] };

/** A terminal that answers from a list. `interactive` is true only when answers are given. */
export function scriptedIo(answers?: string[]): ScriptedIo {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const queue = [...(answers ?? [])];
  return {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    interactive: answers !== undefined,
    async ask(question, defaultValue) {
      asked.push(question);
      const a = queue.shift();
      if (a === undefined) throw new Error(`the script ran out of answers at: ${question}`);
      return a || defaultValue || "";
    },
    outText: () => out.join("\n"),
    errText: () => err.join("\n"),
    asked,
  };
}

export const IMAGE = "vllm/vllm-openai:v0.10.0@sha256:" + "ab".repeat(32);
export const REV = "0123456789abcdef0123456789abcdef01234567";
export const FIXED_KEY = "1f".repeat(32);

/** A small weights directory (safetensors-like) in a temp dir. */
export function weightsDir(files: Record<string, string> = { "config.json": '{"arch":"tiny"}', "model.safetensors": "0123456789abcdef".repeat(32) }): string {
  const dir = tmpDir();
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

export function weightsFile(name = "tiny-q4.gguf", content = "GGUF" + "x".repeat(300)): string {
  const dir = tmpDir();
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

/** Flags for a Phala GPU deployment of the given weights. A flag in `extra` replaces the same flag here. */
export function gpuFlags(weights: string, out: string, extra: string[] = []): string[] {
  const base = ["--yes", "--target", "phala-gpu", "--weights", weights, "--hf-repo", "Org/Model", "--hf-revision", REV, "--model-image", IMAGE, "--id", "demo-model", "--out", out];
  const named = (argv: string[]) => argv.filter((a) => a.startsWith("--")).map((a) => a.split("=")[0]);
  const overridden = new Set(named(extra));
  const kept: string[] = [];
  for (let i = 0; i < base.length; i++) {
    if (!base[i].startsWith("--")) continue;
    const takesValue = base[i + 1] !== undefined && !base[i + 1].startsWith("--");
    if (!overridden.has(base[i])) kept.push(base[i], ...(takesValue ? [base[i + 1]] : []));
  }
  return [...kept, ...extra];
}
