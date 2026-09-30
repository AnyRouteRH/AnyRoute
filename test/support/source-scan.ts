import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// A small scanner over the router's TypeScript source, used by the data-inventory tests to find every rate-limit key, log call,
// reader of a caller's address and reader of a request body. It understands strings, template literals and comments well enough
// to split a call's arguments; it does not parse TypeScript.

export const ROOT = join(import.meta.dir, "..", "..");

export function sourceFiles(dir = "src"): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(join(ROOT, d))) {
      const rel = join(d, name);
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (rel.endsWith(".ts")) out.push(rel);
    }
  };
  walk(dir);
  return out.sort();
}

export const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

/** Arguments of the call whose "(" is at `open`, split at top-level commas, and the index of the closing ")". */
export function parseCall(src: string, open: number): { args: string[]; end: number } {
  const args: string[] = [];
  let i = open;
  let depth = 0;
  let start = open + 1;
  const skipString = (q: string) => {
    i++; // past the opening quote
    while (i < src.length) {
      const ch = src[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (q === "`" && ch === "$" && src[i + 1] === "{") {
        i += 2;
        let d = 1;
        while (i < src.length && d > 0) {
          const c2 = src[i];
          if (c2 === '"' || c2 === "'" || c2 === "`") {
            skipString(c2);
            continue;
          }
          if (c2 === "{") d++;
          else if (c2 === "}") d--;
          i++;
        }
        continue;
      }
      if (ch === q) {
        i++;
        return;
      }
      i++;
    }
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      skipString(ch);
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 2;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        args.push(src.slice(start, i));
        return { args, end: i };
      }
    } else if (ch === "," && depth === 1) {
      args.push(src.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  throw new Error("unbalanced call in source");
}

/** Every call of the given pattern (which must end at the opening parenthesis) in a file, with its arguments. */
export function findCalls(file: string, pattern: RegExp): { file: string; line: number; text: string; args: string[] }[] {
  const src = read(file);
  const out: { file: string; line: number; text: string; args: string[] }[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const open = m.index + m[0].length - 1;
    const { args, end } = parseCall(src, open);
    out.push({ file, line: src.slice(0, m.index).split("\n").length, text: src.slice(m.index, end + 1), args });
  }
  return out;
}

/** The string and template literals inside an expression, as the text between the quotes. */
export function literals(expr: string): string[] {
  return [...expr.matchAll(/`([^`]*)`|"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

export const rel = (file: string) => relative(ROOT, join(ROOT, file));
