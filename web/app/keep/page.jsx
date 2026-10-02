import PageFrame from "../../components/PageFrame";
import { Button } from "../../components/UI";
import { aboutRequestLabel, buildCommit, loadInventory, sourceUrl, tablesByCategory } from "../../lib/keep";
import PromptStorageDisclosure from "../../components/harness/PromptStorageDisclosure"; // V81: browser storage supplement.
import KeepFilter from "./KeepFilter";
import KeepLog from "./KeepLog";
import s from "./keep.module.css";

export const metadata = {
  title: "What we keep: every table, column and log line — Anyroute",
  description:
    "Every table and column the Anyroute router stores, the Redis keys and log lines around them, and every place a request's text or a caller's address is read. Generated from the schema when the site is built, checked by automated checks, and hashed into a public transparency log.",
};

// Everything below is read from the inventory the router's source generates (web/app/keep/inventory.generated.json) when the site
// is built. The prose around it only says how to read it.

const VERDICT = {
  "no-request-content": "Cannot hold request content",
  "digest-only": "A hash, not the text",
  "wallet-address": "A wallet address, not a network address",
  config: "Settings written by you or an operator",
  "public-reference": "A public address, not a caller's",
  "request-header": "A request header, kept as written",
  "may-hold-fragment": "May hold a short piece of request text",
  "holds-request-text": "Holds request text",
  "network-address": "Holds a network address",
};
const HOLDS = {
  address: "The caller's network address",
  "key-hash": "A SHA-256 of an API key",
  account: "An account id",
  wallet: "A wallet address",
  "telegram-user": "A Telegram user id",
  model: "A model id",
  digest: "A SHA-256 digest",
  "nothing-personal": "Nothing personal",
};
const CARRIES = {
  "prompt-or-answer": "Prompts or answers",
  settings: "Settings",
  "payment-or-signature": "Payments or signatures",
  "public-data": "Public data",
};

const Source = ({ file }) => (
  <a className={s.src} href={sourceUrl(file)} rel="noopener noreferrer" target="_blank">
    {file}
  </a>
);
const count = (n, one, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function TableDetails({ t }) {
  const reviewed = t.columns.filter((c) => c.review).length;
  return (
    <details className={s.table} id={`t-${t.name}`} data-keep-table>
      <summary>
        <span className={s.tname}>{t.name}</span>
        <span className={s.tmeta}>
          {aboutRequestLabel(t.about_request)} · {count(t.columns.length, "column")}
          {reviewed ? ` · ${reviewed} reviewed` : ""}
        </span>
      </summary>
      <div className={s.tbody}>
        <p>{t.purpose}</p>
        <p className={s.retention}>
          <strong>How long:</strong> {t.retention}
        </p>
        {t.notes?.length > 0 && (
          <ul className={s.notes}>
            {t.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        <div className="table-wrap" role="region" aria-label={`Columns of ${t.name}`} tabIndex={0}>
          <table className={s.cols}>
            <thead>
              <tr>
                <th scope="col">Column</th>
                <th scope="col">What it holds</th>
                <th scope="col">About a request</th>
              </tr>
            </thead>
            <tbody>
              {t.columns.map((c) => (
                <tr key={c.name} id={`c-${t.name}-${c.name}`}>
                  <td>
                    <code>{c.name}</code>
                    <span className={s.type}>{c.type}</span>
                  </td>
                  <td>
                    {c.purpose}
                    {c.retention ? <span className={s.reviewed}>How long: {c.retention}</span> : null}
                    {c.review ? (
                      <span className={s.reviewed} data-verdict={c.review.verdict}>
                        <strong>{VERDICT[c.review.verdict] ?? c.review.verdict}.</strong> {c.review.why}
                      </span>
                    ) : null}
                  </td>
                  <td className={s.req}>{aboutRequestLabel(c.about_request)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

export default async function KeepPage() {
  const { text, doc, sha256 } = loadInventory();
  const commit = buildCommit();
  const { summary } = doc;
  const out = doc.outside_postgres;
  const groups = tablesByCategory(doc);
  const conveying = out.body_readers.filter((r) => r.carries === "prompt-or-answer");
  const others = out.body_readers.filter((r) => r.carries !== "prompt-or-answer");

  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <span className="eyebrow">DATA INVENTORY · GENERATED FROM THE SCHEMA</span>
          <h1>What we keep.</h1>
          <p>
            Every table and column the router stores, the Redis keys and log lines around them, and every place a request’s text or a caller’s address is read. It is written next to the code, checked against the schema by automated checks, and built into this
            page from the schema when the site is built.
          </p>
          <div className="button-row">
            <Button href="/keep/inventory.json">inventory.json</Button>
            <Button href="#provenance" secondary>
              Hash and commit
            </Button>
          </div>
        </div>

        <div className="side-layout">
          <nav className={`side-nav ${s.nav}`} aria-label="Sections" data-reveal="fade">
            <span className="side-nav-label">On this page</span>
            <a href="#summary">Summary</a>
            <a href="#provenance">Hash and commit</a>
            <a href="#reads">Where text and addresses are read</a>
            <a href="#redis">Redis</a>
            <a href="#logs">Logs</a>
            <a href="#other">Other stores</a>
            <a href="#database">The database</a>
            {groups.map((g) => (
              <a key={g.id} className={s.subnav} href={`#cat-${g.id}`}>
                {g.label}
              </a>
            ))}
            <a href="#browser">Your browser</a>
          </nav>

          <article className={`page-body prose ${s.body}`}>
            <h2 id="summary">The short version.</h2>
            <p className={s.headline}>{summary.headline}</p>
            <ul className={s.facts}>
              {summary.facts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            {summary.caveats.length > 0 && (
              <>
                <h3>Where something is kept, exactly</h3>
                <div className={s.caveats}>
                  {summary.caveats.map((c) => (
                    <section key={c.title} className={s.caveat}>
                      <h4>{c.title}</h4>
                      <p>{c.text}</p>
                    </section>
                  ))}
                </div>
              </>
            )}
            <p className={s.reads}>{summary.reads}</p>

            <h2 id="provenance">Which version this is.</h2>
            <p>
              This page and <a href="/keep/inventory.json">/keep/inventory.json</a> are generated from the same source, so they always agree. The hash is the SHA-256 of the exact bytes of that file.
            </p>
            <dl className={s.prov}>
              <div>
                <dt>Built from commit</dt>
                <dd>
                  {commit ? (
                    <>
                      <code>{commit.sha}</code>
                      {commit.dirty ? <span className={s.dirty}> with uncommitted changes in the working tree</span> : null}
                    </>
                  ) : (
                    "This build did not record a commit."
                  )}
                </dd>
              </div>
              <div>
                <dt>Inventory SHA-256</dt>
                <dd>
                  <code className={s.hash}>{sha256}</code>
                </dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>
                  {count(summary.counts.tables, "table")}, {count(summary.counts.columns, "column")}, {count(summary.counts.reviewed_columns, "column")} that looked like request content or an address and carry a written review
                </dd>
              </div>
              <div>
                <dt>Check it yourself</dt>
                <dd>
                  <code>curl -s https://&lt;this site&gt;/keep/inventory.json | sha256sum</code> prints the hash above. The file is canonical JSON: keys sorted, no whitespace.
                </dd>
              </div>
            </dl>
            <KeepLog digest={sha256} />
            <p className={s.small}>
              The hash is appended to the router’s public transparency log as a <code>data_inventory</code> entry when a router with a new inventory starts, where the operator has switched that on. Anyone can look it up by hash at{" "}
              <code>/api/v1/tlog/lookup</code>, and, where the log is anchored in Rekor, follow the link above to that entry.
            </p>

            <h2 id="reads">Where a request’s text and a caller’s address are read.</h2>
            <p>
              An automated check scans the router’s source for every route that reads a request body and every piece of code that reads a caller’s address, and fails until each one is described here. The rows below say what is read, what happens to it and what is
              kept.
            </p>
            <h3>Request text</h3>
            <div className={`table-wrap ${s.wide}`} role="region" aria-label="Where request text is read" tabIndex={0}>
              <table className={s.readers}>
                <thead>
                  <tr>
                    <th scope="col">Where</th>
                    <th scope="col">What is read, and what happens</th>
                    <th scope="col">What is kept</th>
                  </tr>
                </thead>
                <tbody>
                  {conveying.map((r) => (
                    <tr key={r.file}>
                      <td>
                        <Source file={r.file} />
                      </td>
                      <td>
                        {r.reads} {r.then}
                      </td>
                      <td>{r.kept}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <details className={s.more}>
              <summary>
                {count(others.length, "route")} that read a body but carry no prompt (settings, payments, public data)
              </summary>
              <div className={`table-wrap ${s.wide}`} role="region" aria-label="Routes that read a body without prompts" tabIndex={0}>
                <table className={s.readers}>
                  <thead>
                    <tr>
                      <th scope="col">Where</th>
                      <th scope="col">Carries</th>
                      <th scope="col">What is read, and what happens</th>
                      <th scope="col">What is kept</th>
                    </tr>
                  </thead>
                  <tbody>
                    {others.map((r) => (
                      <tr key={r.file}>
                        <td>
                          <Source file={r.file} />
                        </td>
                        <td>{CARRIES[r.carries] ?? r.carries}</td>
                        <td>
                          {r.reads} {r.then}
                        </td>
                        <td>{r.kept}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <h3>A caller’s network address</h3>
            <div className={`table-wrap ${s.wide}`} role="region" aria-label="Where a caller's address is read" tabIndex={0}>
              <table className={s.readers}>
                <thead>
                  <tr>
                    <th scope="col">Where</th>
                    <th scope="col">What is read, and what happens</th>
                    <th scope="col">What is kept</th>
                  </tr>
                </thead>
                <tbody>
                  {out.address_readers.map((r) => (
                    <tr key={r.file}>
                      <td>
                        <Source file={r.file} />
                      </td>
                      <td>
                        {r.reads} {r.then}
                      </td>
                      <td>{r.kept}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h2 id="redis">Redis.</h2>
            <p>{out.redis.summary}</p>
            <div className={`table-wrap ${s.wide}`} role="region" aria-label="Redis keys" tabIndex={0}>
              <table className={s.readers}>
                <thead>
                  <tr>
                    <th scope="col">Key</th>
                    <th scope="col">What it is for</th>
                    <th scope="col">Part of the key</th>
                    <th scope="col">Lives for</th>
                  </tr>
                </thead>
                <tbody>
                  {out.redis.families.map((f) => (
                    <tr key={f.key} data-holds={f.holds}>
                      <td>
                        <code>{f.key}</code>
                        <Source file={f.evidence[0].file} />
                      </td>
                      <td>{f.purpose}</td>
                      <td>
                        <span className={s.holds} data-holds={f.holds}>
                          {HOLDS[f.holds] ?? f.holds}
                        </span>
                      </td>
                      <td>{f.ttl}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={s.small}>
              <strong>Without Redis</strong> (development): {out.redis.memory_fallback.purpose}
            </p>

            <h2 id="logs">Logs.</h2>
            <p>{out.logs.summary}</p>
            <h3>What a line can carry</h3>
            <ul className={s.plain}>
              {out.logs.records.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <h3>What the code never passes to the logger</h3>
            <ul className={s.plain}>
              {out.logs.never_records.map((r) => (
                <li key={r.item}>
                  {r.item} <Source file={r.evidence[0].file} />
                </li>
              ))}
            </ul>
            <h3>What this cannot promise</h3>
            <ul className={s.plain}>
              {out.logs.caveats.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p className={s.small}>
              <strong>Retention.</strong> {out.logs.retention} <strong>Format.</strong> {out.logs.format}
            </p>

            <h2 id="other">Other places data lives.</h2>
            <div className={s.stores}>
              {out.other_stores.map((o) => (
                <section key={o.id} className={s.store} id={`store-${o.id}`}>
                  <h3>{o.name}</h3>
                  <p>{o.purpose}</p>
                  <dl>
                    <div>
                      <dt>Holds</dt>
                      <dd>{o.holds}</dd>
                    </div>
                    <div>
                      <dt>Lives for</dt>
                      <dd>{o.ttl}</dd>
                    </div>
                  </dl>
                  <Source file={o.evidence[0].file} />
                </section>
              ))}
            </div>

            <h2 id="database">The database, table by table.</h2>
            <p>
              {count(summary.counts.tables, "table")} and {count(summary.counts.columns, "column")}, grouped by what they are for. “About a request” says whether a value is recorded for each call, summed from calls, or has nothing to do with calls. A column
              whose name or type suggests request content or a network address (a name such as prompt, body, ip or address, or a free-form JSON or network type) carries a written review, shown with the column.
            </p>
            <KeepFilter />
            {groups.map((g) => (
              <section key={g.id} id={`cat-${g.id}`} className={s.group} data-keep-group>
                <h3>{g.label}</h3>
                <p className={s.groupNote}>{g.summary}</p>
                {g.tables.map((t) => (
                  <TableDetails key={t.name} t={t} />
                ))}
              </section>
            ))}

            <h2 id="browser">In your browser.</h2>
            <p>{out.browser.summary}</p>
            <PromptStorageDisclosure /> {/* V81: browser-only prompt storage. */}
            <ul className={s.plain}>
              {out.browser.items.map((b) => (
                <li key={b.store}>
                  <code>{b.store}</code>: {b.holds} <Source file={b.evidence[0].file} />
                </li>
              ))}
            </ul>
            <p className={s.small}>
              The inventory is read from <code>src/privacy</code>. The check that keeps it true is <a href={sourceUrl("test/data-inventory.test.ts")}>in the repository</a>. The full text of the file this page is built from is at{" "}
              <a href="/keep/inventory.json">/keep/inventory.json</a> ({(text.length / 1024).toFixed(0)} KB).
            </p>
          </article>
        </div>
      </main>
    </PageFrame>
  );
}
