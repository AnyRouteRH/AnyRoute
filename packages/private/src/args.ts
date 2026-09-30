// A small argument parser: `--name value`, `--name=value`, and flags without a value. No dependencies.

export type OptionSpec = { values?: readonly string[]; flags?: readonly string[] };
export type Parsed = { options: Map<string, string>; flags: Set<string>; positionals: string[] };

export class UsageError extends Error {
  override name = "UsageError";
}

export function parseArgs(argv: readonly string[], spec: OptionSpec): Parsed {
  const values = new Set(spec.values ?? []);
  const known = new Set(spec.flags ?? []);
  const out: Parsed = { options: new Map(), flags: new Set(), positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      out.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      out.positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (values.has(name)) {
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || (eq < 0 && value.startsWith("--"))) throw new UsageError(`--${name} needs a value.`);
      if (out.options.has(name)) throw new UsageError(`--${name} was given twice.`);
      out.options.set(name, value);
    } else if (known.has(name)) {
      if (eq >= 0) throw new UsageError(`--${name} does not take a value.`);
      out.flags.add(name);
    } else throw new UsageError(`Unknown option --${name}. Run with --help to see the options.`);
  }
  return out;
}

/** A whole number within [min, max], or a UsageError naming the option. */
export function intOption(name: string, raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined) return def;
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new UsageError(`--${name} must be a whole number from ${min} to ${max}.`);
  return Number(raw);
}
