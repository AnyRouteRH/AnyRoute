import PageFrame from '../../components/PageFrame';
import { changelog } from '../../lib/changelog-feeds.js';
import Changelog from './Changelog';

export const metadata = {
  title: 'Changelog — Anyroute',
  description: 'See what has shipped on AnyRoute, with links to the pages and public commits.',
  alternates: { canonical: '/changelog/', types: { 'application/rss+xml': '/changelog/rss.xml', 'application/atom+xml': '/changelog/atom.xml', 'application/json': '/changelog/index.json' } },
};

export default function ChangelogPage() {
  return <PageFrame><main className="page-main" id="content">
    <div className="page-title">
      <span className="eyebrow">Shipped changes</span>
      <h1>See what’s new.</h1>
      <p>Follow changes to chat, agents and the network. Each entry links to its page and the public commits behind it.</p>
      <div className="button-row" aria-label="Changelog feeds"><a className="text-button" href="/changelog/rss.xml">RSS feed</a><a className="text-button" href="/changelog/atom.xml">Atom feed</a><a className="text-button" href="/changelog/index.json">JSON feed</a></div>
    </div>
    <Changelog entries={changelog}/>
  </main></PageFrame>;
}
