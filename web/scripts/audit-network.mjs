import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
export function auditNetworkWording(html) {
  assert(html.includes("Join the waitlist"), "Missing network waitlist wording");
  assert(html.includes("Hosting isn’t open yet.") || html.includes("Hosting is open for early hosts running an approved build."), "Missing network admission wording");
}
export function auditNetwork(root) {
  const bytes = fs.readFileSync(path.join(root, "network/check.sh"));
  const html = fs.readFileSync(path.join(root, "network/index.html"), "utf8");
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  assert(bytes.toString().startsWith("#!/bin/sh\n"), "Network checker must be POSIX sh");
  assert(html.includes(`data-network-check-sha256="${digest}"`), "Network checker digest differs from the served file");
  const source = fs.readFileSync(new URL("../public/network/check.sh", import.meta.url));
  assert(bytes.equals(source), "Network checker differs from the source file");
  auditNetworkWording(html);
}
