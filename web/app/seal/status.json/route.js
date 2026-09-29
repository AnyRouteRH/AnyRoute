import { sealStatusJson } from "../../../lib/seal-spec";

// Built once with the site from spec/README.md and spec/CHANGELOG.md; served as a static file.
export const dynamic = "force-static";

export function GET() {
  return new Response(JSON.stringify(sealStatusJson(), null, 2) + "\n", { headers: { "content-type": "application/json; charset=utf-8" } });
}
