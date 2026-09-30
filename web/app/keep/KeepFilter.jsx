"use client";
import { useId, useState } from "react";
import s from "./keep.module.css";

// Narrows the list of tables to those whose name, purpose or column text contains what was typed. It works on the page's own
// elements (each table is a <details data-keep-table>), so the page is complete without it.
export default function KeepFilter() {
  const id = useId();
  const [shown, setShown] = useState(null);
  function apply(value) {
    const q = value.trim().toLowerCase();
    const rows = Array.from(document.querySelectorAll("[data-keep-table]"));
    let n = 0;
    for (const el of rows) {
      const hit = !q || (el.textContent || "").toLowerCase().includes(q);
      el.hidden = !hit;
      if (hit) n++;
      if (q && hit && el instanceof HTMLDetailsElement) el.open = true;
      if (!q && el instanceof HTMLDetailsElement) el.open = false;
    }
    for (const group of document.querySelectorAll("[data-keep-group]")) group.hidden = !!q && !group.querySelector("[data-keep-table]:not([hidden])");
    setShown(q ? n : null);
  }
  return (
    <div className={s.filter} role="search">
      <label htmlFor={id}>Filter tables and columns, for example ip, prompt, receipt or tlog</label>
      <input id={id} type="search" autoComplete="off" spellCheck={false} onChange={(e) => apply(e.target.value)} />
      <span aria-live="polite">{shown == null ? "" : `${shown} table${shown === 1 ? "" : "s"} match`}</span>
    </div>
  );
}
