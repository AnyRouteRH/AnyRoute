"use client";
import { useEffect, useState } from "react";
import { API_BASE } from "../../lib/api";
import { liveRows } from "../../lib/seal-live";
import s from "./seal.module.css";

// The router's own report on the SEAL parts it runs, read from GET /api/v1/status when the page opens.
export default function SealLive() {
  const [state, setState] = useState({ phase: "loading", rows: [] });
  useEffect(() => {
    const ac = new AbortController();
    fetch(API_BASE + "/api/v1/status", { signal: ac.signal, headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error("status " + res.status);
        const body = await res.json();
        setState({ phase: "ready", rows: liveRows(body?.data) });
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setState({ phase: "error", rows: [] });
      });
    return () => ac.abort();
  }, []);

  return (
    <div className={s.live} aria-live="polite" aria-busy={state.phase === "loading"}>
      <div className={s.liveHead}>
        <span className={s.pulse} data-phase={state.phase} aria-hidden="true" />
        <span>Live on anyroute.tech</span>
        <code>GET /api/v1/status</code>
      </div>
      {state.phase === "loading" && <p className={s.liveNote}>Reading this router’s status…</p>}
      {state.phase === "error" && <p className={s.liveNote}>The router’s status could not be read just now, so nothing is shown here. The same facts are in GET /api/v1/status when it answers.</p>}
      {state.phase === "ready" && (
        <dl className={s.liveList}>
          {state.rows.map((row) => (
            <div key={row.name} data-state={row.state}>
              <dt>{row.name}</dt>
              <dd>
                {row.contracts ? (
                  <ul>
                    {row.contracts.map((c) => (
                      <li key={c.name}>
                        <span>{c.name}</span>{" "}
                        {c.href ? (
                          <a className="mono" href={c.href} rel="noopener noreferrer" target="_blank">
                            {c.address}
                          </a>
                        ) : (
                          <code>{c.address}</code>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : row.mono ? (
                  <code>{row.value}</code>
                ) : (
                  row.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
