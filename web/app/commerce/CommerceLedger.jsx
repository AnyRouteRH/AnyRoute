"use client";
import { useEffect, useState } from "react";
import { API_BASE } from "../../lib/api";
import { DUNE_QUERY_URL, EXCLUSIONS, REFRESH_MS, WINDOW_LABELS, WINDOW_NAMES, describeWindow, fetchCommerceStats } from "../../lib/commerce-stats";
import s from "./commerce.module.css";

/** One measure: the filtered figure large, the gross figure beside it. Never the gross figure alone. */
function Pair({ p, big = false }) {
  return <div className={big ? s.pairBig : s.pair}>
    <dt>{p.label}</dt>
    <dd><strong>{p.filtered}</strong><span>gross {p.gross}</span></dd>
  </div>;
}

/** A solid bar: counted settlements, then each exclusion, as shares of the gross count. */
function Bar({ segments, label }) {
  if (!segments.length) return <div className={s.bar} data-empty="true" role="img" aria-label={`${label}: no settlements`} />;
  return <div className={s.bar} role="img" aria-label={`${label}: ${segments.map(g => g.text).join(", ")}`}>
    {segments.map(g => <span key={g.key} data-kind={g.key} style={{ flexGrow: g.share }} title={g.text} />)}
  </div>;
}

/** The live ledger; `initial` (a validated snapshot) renders figures before the first refresh. */
export default function CommerceLedger({ initial = null }) {
  const [result, setResult] = useState(initial ? { state: "ok", data: initial } : { state: "loading" });
  const [win, setWin] = useState("7d");
  useEffect(() => {
    let ac = new AbortController();
    const run = async () => {
      ac.abort();
      ac = new AbortController();
      try {
        const next = await fetchCommerceStats(API_BASE, fetch, ac.signal);
        setResult(prev => (next.state === "error" && prev.data ? { ...prev, stale: true } : next));
      } catch { /* aborted */ }
    };
    run();
    const t = setInterval(() => { if (!document.hidden) run(); }, REFRESH_MS);
    return () => { clearInterval(t); ac.abort(); };
  }, []);

  if (result.state === "loading") return <p className={s.lead} role="status">Reading the ledger…</p>;
  if (result.state === "off") return <section className={s.field} aria-live="polite"><h2>Not switched on here yet.</h2><p>This router does not publish its commerce ledger. The <a href="/docs/#commerce-stats">methodology</a> and the <a href={DUNE_QUERY_URL}>Dune query</a> are public all the same.</p></section>;
  if (result.state === "error" && !result.data) return <div className="error" role="alert">The ledger could not be read just now. It refreshes every minute while this page is open.</div>;

  const v = describeWindow(result.data, win);
  return <div className={s.stack}>
    {result.stale && <div className="error" role="alert">The ledger could not be read just now. The figures below are from the last successful read.</div>}
    <div className={s.windows} role="group" aria-label="Window">
      {WINDOW_NAMES.map(n => <button key={n} type="button" aria-pressed={win === n} onClick={() => setWin(n)}>{WINDOW_LABELS[n]}</button>)}
    </div>

    <section aria-labelledby="totals-h" aria-live="polite">
      <h2 id="totals-h" className={s.h}>All settlements · last {v.label}</h2>
      <p className={s.calm}>{v.empty ? `No settlements in the last ${v.label} yet. Both figures read zero until the first one settles.` : "Large figures count only what passed every rule. Under each is the gross figure, before any rule."}</p>
      <dl className={s.pairs}>{v.headline.map(p => <Pair key={p.key} p={p} big />)}</dl>
    </section>

    <section aria-labelledby="filters-h">
      <h2 id="filters-h" className={s.h}>What was taken out</h2>
      <ul className={s.legend} aria-label="How to read the bars">
        <li><span className={s.key} data-kind="filtered" />Counted</li>
        {EXCLUSIONS.map(e => <li key={e.key}><span className={s.key} data-kind={e.key} />{e.label}</li>)}
      </ul>
      <Bar segments={v.segments} label={`All settlements, last ${v.label}`} />
      <dl className={s.excluded}>{v.excluded.map(e => <div key={e.key}><dt>{e.label}</dt><dd>{e.n.toLocaleString("en-US")}</dd></div>)}</dl>
      <p className={s.note}>{v.funding}</p>
    </section>

    <section aria-labelledby="kinds-h">
      <h2 id="kinds-h" className={s.h}>By kind · last {v.label}</h2>
      <div className={s.kinds}>{v.kinds.map(k => <article key={k.kind} className={s.kind} aria-labelledby={`kind-${k.kind}`}>
        <header className={s.kindHead}>
          <h3 id={`kind-${k.kind}`}>{k.label}</h3>
          <span className={s.pill} data-tone={k.wired ? "on" : "off"}>{k.wired ? "connected" : "not connected yet"}</span>
        </header>
        <Bar segments={k.segments} label={`${k.label}, last ${v.label}`} />
        {k.empty ? <p className={s.calm}>{k.wired ? `No settlements in the last ${v.label}.` : "Nothing reports these settlements to the ledger yet."}</p>
          : <dl className={s.pairsSmall}>{k.pairs.map(p => <Pair key={p.key} p={p} />)}</dl>}
      </article>)}</div>
    </section>

    <p className={s.note}>Amounts are USDG. Figures cover settlements in the window ending {v.asOf}; the page refreshes every minute while it is open. Nothing here names a payer, a payee or a transaction, and no figure is split by privacy lane. Read the <a href="/docs/#commerce-stats">methodology and its limits</a>, or recompute the on-chain part yourself with the <a href={DUNE_QUERY_URL}>Dune query</a>.</p>
  </div>;
}
