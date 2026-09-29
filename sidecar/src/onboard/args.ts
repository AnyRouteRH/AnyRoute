// A small flag parser for the onboarding CLI: `--name value`, `--name=value`, repeatable flags, and booleans.
// Unknown flags are errors, so a typo cannot silently drop a setting.

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type FlagKind = "string" | "boolean" | "list";
export type FlagSpec = Record<string, FlagKind>;
export type Parsed = { values: Map<string, string | boolean | string[]>; positional: string[] };

export function parseFlags(argv: string[], spec: FlagSpec): Parsed {
  const values: Parsed["values"] = new Map();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    const kind = spec[name];
    if (!kind) throw new UsageError(`unknown option --${name}`);
    if (kind === "boolean") {
      if (eq >= 0) {
        const v = arg.slice(eq + 1);
        if (v !== "true" && v !== "false") throw new UsageError(`--${name} takes no value (or true / false)`);
        values.set(name, v === "true");
      } else values.set(name, true);
      continue;
    }
    let value: string;
    if (eq >= 0) value = arg.slice(eq + 1);
    else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      value = next;
      i++;
    }
    if (kind === "list") {
      const prior = (values.get(name) as string[] | undefined) ?? [];
      values.set(name, [...prior, value]);
    } else {
      if (values.has(name)) throw new UsageError(`--${name} was given twice`);
      values.set(name, value);
    }
  }
  return { values, positional };
}

export class Flags {
  constructor(private readonly p: Parsed) {}
  get positional() {
    return this.p.positional;
  }
  str(name: string): string | undefined {
    const v = this.p.values.get(name);
    return typeof v === "string" ? v : undefined;
  }
  bool(name: string): boolean {
    return this.p.values.get(name) === true;
  }
  list(name: string): string[] {
    const v = this.p.values.get(name);
    return Array.isArray(v) ? v : [];
  }
  has(name: string): boolean {
    return this.p.values.has(name);
  }
  int(name: string, min: number, max: number): number | undefined {
    const v = this.str(name);
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new UsageError(`--${name} must be a whole number between ${min} and ${max}`);
    return Number(v);
  }
}
