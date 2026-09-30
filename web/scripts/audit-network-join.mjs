import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
export function auditNetworkJoin(root) {
  const bytes = fs.readFileSync(path.join(root, "network/join.mjs"));
  const html = fs.readFileSync(path.join(root, "network/index.html"), "utf8");
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  assert(bytes.toString().startsWith("#!/usr/bin/env node\n") && bytes.length > 50_000, "Network join must be the bundled Node program");
  assert(html.includes(`data-network-join-sha256="${digest}"`), "Network join digest differs from the served file");
  assert(bytes.equals(fs.readFileSync(new URL("../public/network/join.mjs", import.meta.url))), "Network join differs from the source file");
}
