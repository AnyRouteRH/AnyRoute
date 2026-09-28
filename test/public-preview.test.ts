import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewHandler } from "../scripts/preview-server.ts";

const root = mkdtempSync(join(tmpdir(), "anyroute-preview-"));
mkdirSync(join(root, "dashboard"));
writeFileSync(join(root, "index.html"), '<html><body><script>console.log("fixture")</script><h1>Anyroute</h1></body></html>');
writeFileSync(join(root, "dashboard/index.html"), "<html><body>Dashboard</body></html>");
const handle = previewHandler(root);
const request = (path: string, method = "GET") => handle(new Request("http://preview.test" + path, { method }));
afterAll(() => rmSync(root, { recursive: true }));
test("public preview advertises its limits and disables every backend surface", async () => {
  expect(await request("/health").json()).toEqual({ ok: true, mode: "static-demo", payments: false });
  for (const path of ["/api/v1/keys", "/api/v1/paymaster", "/v1/chat/completions", "/trpc/providers.onboard", "/ready"]) {
    for (const method of ["GET", "POST"]) expect(request(path, method).status).toBe(503);
  }
  expect(request("/", "POST").status).toBe(405);
});
test("dashboard always enters sample mode and HTML carries the preview notice and CSP", async () => {
  expect(request("/dashboard/?model=example").headers.get("location")).toBe("/dashboard/?model=example&demo=1");
  expect(request("/dashboard/?demo=0").headers.get("location")).toBe("/dashboard/?demo=1");
  expect(request("/dashboard/?demo=1").status).toBe(200);
  const r = request("/");
  expect(await r.text()).toContain("No live inference or payments");
  expect(r.headers.get("content-security-policy")).toContain("connect-src 'self';");
  expect(r.headers.get("content-security-policy")).toContain("'sha256-");
  expect(request("/.env").status).toBe(404);
  expect(await request("/", "HEAD").text()).toBe("");
});
