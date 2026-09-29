import PageFrame from "../../components/PageFrame";
import { REPO_URL, SPEC_LICENSE_URL } from "../../lib/seal-spec";
import s from "./spec.module.css";

const label = (d) => (d.number ? `${d.number} ${d.shortTitle}` : d.shortTitle);

/** One SEAL specification document, rendered at build time from spec/<file>. */
export default function SpecDoc({ doc }) {
  const at = doc.docs.findIndex((d) => d.slug === doc.slug);
  const prev = doc.docs[at - 1];
  const next = doc.docs[at + 1];
  const toc = doc.headings.filter((h) => h.level === 2);
  const source = `${REPO_URL}/blob/main/spec/${doc.file}`;
  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <span className="eyebrow">
            SEAL SPECIFICATION / {doc.number || (doc.slug ? doc.shortTitle.toUpperCase() : "OVERVIEW")}
            {doc.version.version ? ` · v${doc.version.version}` : ""}
          </span>
          <h1>{doc.number ? doc.shortTitle : doc.title}</h1>
          {doc.number ? (
            doc.description && <p>{doc.description}</p>
          ) : (
            <p>{doc.slug ? "Every version of the SEAL specification, newest first." : `The SEAL specification${doc.version.version ? `, version ${doc.version.version}` : ""}: the overview and status table, then ${doc.docs.filter((d) => d.number).length} documents a third party can implement or verify against.`}</p>
          )}
        </div>
        <div className="side-layout">
          <nav className={`side-nav ${s.nav}`} aria-label="SEAL specification" data-reveal="fade">
            <span className="side-nav-label">Documents</span>
            {doc.docs.map((d) => (
              <a key={d.url} href={d.url} aria-current={d.slug === doc.slug ? "page" : undefined}>
                {label(d)}
              </a>
            ))}
            {toc.length > 1 && (
              <>
                <span className={`side-nav-label ${s.tocLabel}`}>On this page</span>
                {toc.map((h) => (
                  <a key={h.id} href={`#${h.id}`} className={s.toc}>
                    {h.text}
                  </a>
                ))}
              </>
            )}
          </nav>
          <article className={`page-body prose ${s.doc}`}>
            <div className="note">
              The SEAL specification is licensed under the{" "}
              <a href={SPEC_LICENSE_URL} rel="noopener noreferrer" target="_blank">
                Apache License 2.0
              </a>
              , so anyone can implement it. That license covers the documents in <code>spec/</code> only; the rest of the Anyroute repository keeps its own license. This page is built from{" "}
              <a href={source} rel="noopener noreferrer" target="_blank">
                <code>spec/{doc.file}</code>
              </a>{" "}
              each time the site is built.
            </div>
            <div className={s.body} dangerouslySetInnerHTML={{ __html: doc.html }} />
            <nav className={s.pager} aria-label="Previous and next document">
              {prev ? (
                <a href={prev.url} rel="prev">
                  <span>Previous</span>
                  {label(prev)}
                </a>
              ) : (
                <span />
              )}
              {next ? (
                <a href={next.url} rel="next">
                  <span>Next</span>
                  {label(next)}
                </a>
              ) : (
                <a href="/seal/">
                  <span>Overview</span>
                  SEAL, in one page
                </a>
              )}
            </nav>
          </article>
        </div>
      </main>
    </PageFrame>
  );
}
