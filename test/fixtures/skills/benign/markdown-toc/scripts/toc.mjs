import { readFileSync } from "node:fs";

const text = readFileSync(process.argv[2], "utf8");
for (const line of text.split("\n")) {
  const m = /^(#{2,4})\s+(.*)$/.exec(line);
  if (!m) continue;
  const depth = m[1].length - 2;
  const slug = m[2].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  console.log(`${"  ".repeat(depth)}- [${m[2]}](#${slug})`);
}
