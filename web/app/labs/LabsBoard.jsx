"use client";
import { useEffect, useState } from "react";
import { API_BASE } from "../../lib/api";
import { READING, STATUS_PATH, UNREAD, labRows, loadLabRows } from "../../lib/labs";
import s from "./labs.module.css";

/** The Labs list: rows render at once as "Reading", then take their state from one status read. */
export default function LabsBoard() {
  const [view, setView] = useState({ phase: "loading", rows: labRows(null, "loading") });
  useEffect(() => {
    const ac = new AbortController();
    loadLabRows(API_BASE, fetch, ac.signal).then(setView, () => { /* aborted */ });
    return () => ac.abort();
  }, []);

  return (
    <section className={s.board} aria-busy={view.phase === "loading"}>
      <div className={s.head} role="status">
        <span className={s.dot} data-phase={view.phase} aria-hidden="true" />
        <span>{view.phase === "error" ? UNREAD : view.phase === "loading" ? READING : "Read live from"}</span>
        <code>GET {STATUS_PATH}</code>
      </div>
      {view.phase === "error" && <p className={s.note}>The router’s status did not answer, so no switch below is shown as on or off. The same fields are in GET {STATUS_PATH} when it answers.</p>}
      <ul className={s.rows}>
        {view.rows.map(row => (
          <li key={row.id} className={s.row} data-state={row.state}>
            <div className={s.rowHead}>
              <h2>{row.name}</h2>
              <span className={s.pill} data-state={row.state}>{row.label}</span>
            </div>
            <p>{row.blurb}</p>
            <div className={s.meta}>
              {row.field ? <code>{row.field}</code> : <span>From its documentation</span>}
              <a href={row.href}>Read more</a>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
