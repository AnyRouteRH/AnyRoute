"use client";
import { useEffect, useState } from "react";
import { API_BASE } from "../../lib/api";
import { checkpointUrl, logState, proofUrl } from "../../lib/keep-log";
import s from "./keep.module.css";

// What the router's transparency log says about this inventory's hash, read from GET /api/v1/tlog/proof when the page opens.
export default function KeepLog({ digest }) {
  const [state, setState] = useState({ phase: "loading" });
  useEffect(() => {
    const ac = new AbortController();
    fetch(proofUrl(API_BASE, digest), { signal: ac.signal, headers: { accept: "application/json" } })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        setState(logState(res.status, body, digest));
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setState({ phase: "error", reason: "network" });
      });
    return () => ac.abort();
  }, [digest]);

  return (
    <div className={s.log} aria-live="polite" aria-busy={state.phase === "loading"}>
      <div className={s.logHead}>
        <span className={s.pulse} data-phase={state.phase} aria-hidden="true" />
        <span>Transparency log</span>
        <code>GET /api/v1/tlog/proof?kind=data_inventory</code>
      </div>
      {state.phase === "loading" && <p className={s.logNote}>Asking the router’s log about this hash…</p>}
      {state.phase === "logged" && (
        <dl className={s.logList}>
          <div>
            <dt>In the log</dt>
            <dd>
              Yes: entry <code>{state.index}</code>, kind <code>data_inventory</code>
              {state.checkpointSize != null && (
                <>
                  , under a signed checkpoint of size <code>{state.checkpointSize}</code> (<a href={checkpointUrl(API_BASE)}>read the newest checkpoint</a>)
                </>
              )}
              .
            </dd>
          </div>
          <div>
            <dt>Witnesses</dt>
            <dd>{state.witnessed ? `The checkpoint carries the quorum of witness cosignatures (${state.cosignedBy.join(", ")}).` : "The checkpoint does not carry the quorum of witness cosignatures yet."}</dd>
          </div>
          <div>
            <dt>Rekor</dt>
            <dd>
              {state.rekor ? (
                <>
                  A checkpoint that includes it is anchored in Rekor at log index <code>{state.rekor.logIndex}</code>
                  {state.rekor.checkpointSize != null && <> (checkpoint size {state.rekor.checkpointSize})</>}.{" "}
                  {state.rekor.searchUrl ? (
                    <a href={state.rekor.searchUrl} rel="noopener noreferrer" target="_blank">
                      Open the entry
                    </a>
                  ) : state.rekor.entryUrl ? (
                    <a href={state.rekor.entryUrl} rel="noopener noreferrer" target="_blank">
                      Open the entry
                    </a>
                  ) : null}
                </>
              ) : (
                "Not anchored in Rekor for this checkpoint."
              )}
            </dd>
          </div>
        </dl>
      )}
      {state.phase === "not_logged" && <p className={s.logNote}>The router’s log does not hold this hash. Either this router does not append the inventory (TLOG_DATA_INVENTORY is off) or it has not started with this version yet.</p>}
      {state.phase === "no_log" && <p className={s.logNote}>This router does not run a transparency log, so there is nothing to look up. The hash above can still be checked against the file.</p>}
      {state.phase === "error" && <p className={s.logNote}>The router’s log could not be read just now, so nothing is shown here.</p>}
    </div>
  );
}
