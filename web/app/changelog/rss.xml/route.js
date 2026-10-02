import { rssFeed } from '../../../lib/changelog-feeds.js';

export const dynamic = 'force-static';
export function GET() {
  return new Response(rssFeed(), { headers: { 'content-type': 'application/rss+xml; charset=utf-8' } });
}
