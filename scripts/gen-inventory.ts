// Writes the data inventory (src/privacy/inventory.ts) as the exact JSON the "What we keep" page publishes at
// /keep/inventory.json: canonical JSON generated from the descriptions and the live schema.
//
//   bun scripts/gen-inventory.ts                 write web/app/keep/inventory.generated.json
//   bun scripts/gen-inventory.ts --out <file>    write somewhere else (the image build does this)
//   bun scripts/gen-inventory.ts --check         exit 1 when the committed file is not what would be generated
//
// It fails, writing nothing, when a table or column has no description or a description names something that is not in the schema.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { inventoryDigest, inventoryJson } from "../src/privacy/inventory.ts";

export const DEFAULT_OUT = resolve(import.meta.dir, "../web/app/keep/inventory.generated.json");

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? resolve(args[outIndex + 1] ?? "") : DEFAULT_OUT;

const json = inventoryJson();
if (flag("--check")) {
  let current = "";
  try {
    current = readFileSync(out, "utf8");
  } catch {
    /* missing */
  }
  if (current !== json) {
    console.error(`${out} is out of date. Run: bun scripts/gen-inventory.ts`);
    process.exit(1);
  }
  console.log(`up to date: ${inventoryDigest()}`);
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
  console.log(`wrote ${out} (${json.length} bytes) sha256 ${inventoryDigest()}`);
}
