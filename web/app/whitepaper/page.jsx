import PageFrame from "../../components/PageFrame";
import { loadWhitepaper } from "../../lib/whitepaper";
import s from "./whitepaper.module.css";

export const metadata = {
  title: "AnyRoute Whitepaper — Anyroute",
  description: "The AnyRoute router, SEAL evidence, privacy paths, host network and agent controls: implementation, activation and honest limits.",
};

export default function WhitepaperPage() {
  const paper = loadWhitepaper();
  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <span className="eyebrow">ANYROUTE / WHITEPAPER</span>
          <h1>{paper.title.text}</h1>
          <p>The architecture, evidence and boundaries of the router, SEAL, the host network and agent controls.</p>
        </div>
        <div className="side-layout">
          <nav className={`side-nav ${s.nav}`} aria-label="Whitepaper sections">
            <span className="side-nav-label">On this page</span>
            {paper.headings.filter((heading) => heading.level === 2).map((heading) => (
              <a key={heading.id} href={`#${heading.id}`}>{heading.text}</a>
            ))}
          </nav>
          <article className={`page-body prose ${s.body}`} dangerouslySetInnerHTML={{ __html: paper.html }} />
        </div>
      </main>
    </PageFrame>
  );
}
