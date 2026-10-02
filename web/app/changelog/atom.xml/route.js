import { atomFeed } from '../../../lib/changelog-feeds.js';

export const dynamic = 'force-static';
export function GET() {
  return new Response(atomFeed(), { headers: { 'content-type': 'application/atom+xml; charset=utf-8' } });
}
