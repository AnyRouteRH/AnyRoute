import { loadInventory } from "../../../lib/keep";

// The inventory this page is built from, byte for byte: canonical JSON, so its SHA-256 is the hash shown on /keep and recorded in the
// transparency log. Built once with the site; served as a static file.
export const dynamic = "force-static";

export function GET() {
  return new Response(loadInventory().text, { headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } });
}
