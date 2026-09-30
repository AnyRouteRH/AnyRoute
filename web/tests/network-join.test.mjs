import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { joinDigest } from "../lib/network-join.js";
import { hostsOpen } from "../lib/network-hosts.js";
import { auditNetworkJoin } from "../scripts/audit-network-join.mjs";

test("hosting stays closed unless the router explicitly reports hosts_open true", async () => {
  for (const data of [{}, { network: {} }, { network: { hosts_open: false } }, { network: { hosts_open: "true" } }]) assert.equal(await hostsOpen(async () => ({ ok: true, json: async () => ({ data }) })), false);
  let call;
  assert.equal(await hostsOpen(async (...args) => { call = args; return { ok: true, json: async () => ({ data: { network: { hosts_open: true } } }) }; }), true);
  assert.equal(call[0], "/api/v1/status"); assert.equal(call[1].credentials, "omit"); assert.equal(call[1].cache, "no-store");
  assert.equal(await hostsOpen(async () => { throw new Error(); }), false);
  assert.equal(await hostsOpen(async () => ({ ok: false })), false);
});
test("page shows installer, join, safety warning, limits and the build-time digest", () => {
  const page = fs.readFileSync("app/network/page.jsx", "utf8"), content = fs.readFileSync("app/network/NetworkContent.jsx", "utf8"), join = fs.readFileSync("app/network/Join.jsx", "utf8");
  assert.match(page, /joinSha=\{joinDigest\(\)\}/); assert.match(content, /<Join sha=\{joinSha\}/);
  for (const fragment of ["When hosting opens", "Hosting isn’t open yet.", "sh deploy/seal/install.sh", "node join.mjs --key-file", "dedicated operator wallet", "router still reads inference requests in memory", "data-network-join-sha256", "--dry-run", "--status PROVIDER_ID", "--api-key-file", "--api-key-env NAME", "--credential-only PROVIDER_ID", "16–500", "group or world readable", "&lt;redacted&gt;"]) assert.ok(join.includes(fragment), fragment);
  assert.doesNotMatch(join, /\b(?:demo|mock|simulated|placeholder)\b|local-build/i);
});
test("audit rejects a missing bundle, modified bytes, stale SHA and a substituted source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "join-audit-"));
  const bytes = fs.readFileSync("public/network/join.mjs"), html = `<code data-network-join-sha256="${joinDigest()}"></code>`;
  try {
    fs.mkdirSync(path.join(root, "network")); fs.writeFileSync(path.join(root, "network/index.html"), html);
    assert.throws(() => auditNetworkJoin(root));
    fs.writeFileSync(path.join(root, "network/join.mjs"), bytes); auditNetworkJoin(root);
    fs.appendFileSync(path.join(root, "network/join.mjs"), "\n// altered\n"); assert.throws(() => auditNetworkJoin(root), /digest differs/);
    fs.writeFileSync(path.join(root, "network/join.mjs"), bytes);
    fs.writeFileSync(path.join(root, "network/index.html"), html.replace(joinDigest(), "0".repeat(64))); assert.throws(() => auditNetworkJoin(root), /digest differs/);
    const changed = Buffer.concat([bytes, Buffer.from("\n// changed\n")]);
    fs.writeFileSync(path.join(root, "network/join.mjs"), changed);
    fs.writeFileSync(path.join(root, "network/index.html"), html.replace(joinDigest(), createHash("sha256").update(changed).digest("hex")));
    assert.throws(() => auditNetworkJoin(root), /source file/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("signup docs describe credential handoff and later configuration", () => {
  const docs = fs.readFileSync("components/NetworkHostsDocs.jsx", "utf8");
  for (const fragment of ["/network/join.mjs", "--api-key-file", "--api-key-env NAME", "--credential-only PROVIDER_ID", "--dry-run", "&lt;redacted&gt;", "credential failure leaves signup in place"]) assert.ok(docs.includes(fragment), fragment);
});
