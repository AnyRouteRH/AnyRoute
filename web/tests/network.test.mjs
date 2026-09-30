import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROLES, REGIONS, PAYOUTS, PRIVACY_PROMISE, validateWaitlist, submitWaitlist, deleteWaitlist } from "../lib/network.js";
import { checkerDigest } from "../lib/network-check.js";
import { auditNetwork } from "../scripts/audit-network.mjs";
const valid = { role: "developer", hardware: "", readiness: "", region: "europe", contact: "", paid_in: "any", website: "" };
const id = "00000000-0000-4000-8000-000000000000", code = "a".repeat(64);
test("form validates all enums, optional fields and exact length boundaries", () => {
  assert.deepEqual(validateWaitlist(valid), {});
  for (const [key, options] of [["role", ROLES], ["region", REGIONS], ["paid_in", PAYOUTS]]) { for (const [v] of options) assert.deepEqual(validateWaitlist({ ...valid, [key]: v }), {}); assert.ok(validateWaitlist({ ...valid, [key]: "wrong" })[key]); }
  for (const [key, limit] of [["hardware", 200], ["readiness", 300], ["contact", 120]]) { assert.deepEqual(validateWaitlist({ ...valid, [key]: "x".repeat(limit) }), {}); assert.ok(validateWaitlist({ ...valid, [key]: "x".repeat(limit + 1) })[key]); }
});
test("submission and deletion use only relative URLs and no credentials", async () => {
  const calls = []; const fetcher = async (...args) => { calls.push(args); return { ok: true, json: async () => ({ id, delete_code: code }) }; };
  assert.deepEqual(await submitWaitlist(valid, fetcher), { id, delete_code: code });
  await deleteWaitlist(id, code, fetcher);
  assert.equal(calls[0][0], "/api/v1/network/waitlist"); assert.equal(calls[1][0], `/api/v1/network/waitlist/${id}`);
  for (const [, init] of calls) { assert.equal(init.credentials, "omit"); assert.equal(init.cache, "no-store"); }
  assert.deepEqual(JSON.parse(calls[1][1].body), { delete_code: code });
});
test("failed requests stay failures; invalid fields never reach the network", async () => {
  let calls = 0;
  await assert.rejects(submitWaitlist({ ...valid, role: "wrong" }, async () => { calls++; }), /check/); assert.equal(calls, 0);
  await assert.rejects(submitWaitlist(valid, async () => ({ ok: false, status: 429 })), /Too many/);
  await assert.rejects(submitWaitlist(valid, async () => ({ ok: true, json: async () => ({}) })), /delete code/);
  await assert.rejects(deleteWaitlist(id, code, async () => ({ ok: false, status: 404 })), /No entry/);
});
test("verbatim privacy promise, delete code and hosting limits are wired into the page", () => {
  assert.equal(PRIVACY_PROMISE, "We keep only what you type here, to count interest and contact you if you asked us to. We don't store your IP address. We delete the list when the program launches or is cancelled.");
  const form = fs.readFileSync("app/network/Waitlist.jsx", "utf8"), page = fs.readFileSync("app/network/page.jsx", "utf8");
  assert.match(form, /\{PRIVACY_PROMISE\}/); assert.match(form, /\{entry.delete_code\}/); assert.match(form, /name="website"/);
  assert.match(page, /router still reads requests in memory/); assert.match(page, /Hosting isn’t open yet/);
  assert.doesNotMatch(page, /curl\s*\|\s*sh|\b(?:earn|yield|APY|returns|passive income|decentralized|trustless|demo|mock|simulated|placeholder)\b/i);
  assert.doesNotMatch(form, /localStorage|sessionStorage|https?:\/\//);
});
test("audit verifies the actual served checker hash and rejects modified bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "network-audit-"));
  try {
    fs.mkdirSync(path.join(root, "network")); const bytes = fs.readFileSync("public/network/check.sh");
    fs.writeFileSync(path.join(root, "network/check.sh"), bytes);
    fs.writeFileSync(path.join(root, "network/index.html"), `<code data-network-check-sha256="${checkerDigest()}"></code>Join the waitlist`);
    auditNetwork(root); fs.appendFileSync(path.join(root, "network/check.sh"), "# changed\n"); assert.throws(() => auditNetwork(root), /digest differs/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
