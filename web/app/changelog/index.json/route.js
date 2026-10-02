import { jsonFeed } from '../../../lib/changelog-feeds.js';

export const dynamic = 'force-static';
export function GET() {
  return new Response(jsonFeed(), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}
