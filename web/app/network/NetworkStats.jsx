"use client";
import { useEffect, useState } from "react";
import { fetchNetworkStats, networkStatCards } from "../../lib/network-stats";
import s from "./stats.module.css";

export default function NetworkStats({ initialData = null }) {
  const [data, setData] = useState(initialData);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const refresh = async () => { const next = await fetchNetworkStats(fetch, controller.signal); if (active) setData(next); };
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, []);
  return <section className={s.section} aria-label="Network statistics">
    <span className="eyebrow">NETWORK STATISTICS</span>
    <div className={`stats ${s.strip}`} data-stagger aria-live="polite">
      {networkStatCards(data).map(card => <div className={`stat ${s.card}`} key={`${data?.as_of ?? "empty"}:${card.label}`} data-reveal>
        <strong className={card.value === null ? s.text : ""}>{card.value === null ? card.text : <span data-count={card.value}>{card.text}</span>}{card.unit && <sup>{card.unit}</sup>}</strong><p>{card.label}</p>
      </div>)}
    </div>
    {!data ? <p>No data yet. Network statistics appear when available.</p> : <p>Hosts: {data.hosts.probation} on probation · {data.hosts.live} live · {data.hosts.rejected} rejected. Policy: {data.policy_version === null ? "No data yet" : `v${data.policy_version}`}. Snapshot: <time dateTime={data.as_of}>{data.as_of.replace("T", " ").replace(/\.\d+Z$/, " UTC")}</time>.{data.hosts.total === 0 && " No data yet from network hosts."}{data.bonds && !data.bonds.fresh && " The bond index is not current."}</p>}
    <p className={s.note}>Attested hosts require fresh successful attestation and admission evidence. Capacity counts distinct eligible models, not throughput. Token ranges cover retained public-lane records in 100,000-token buckets; this is not differential privacy. Private-lane host totals are unavailable: existing DP counters at <code>/api/v1/stats</code> cover the router as a whole. Waitlist entries express interest, not admission. <a href="/docs/#network-stats">Definitions and limits</a>.</p>
  </section>;
}
