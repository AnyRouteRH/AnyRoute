"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { PROVIDERS_PATH } from "../lib/providers.js";
import { NO_DATA, routeCard } from "../lib/route-card.js";
import mc from "./ModelCapabilities.module.css";
import pb from "./ProofBadge.module.css";
import s from "./RouteCard.module.css";

// One provider list per minute, shared by every card on the page. A failed load reads "No data yet" and retries next time.
let shared = null;
function loadProviders() {
  if (shared && Date.now() - shared.at < 60_000) return shared.promise;
  const entry = { at: Date.now() };
  entry.promise = api(PROVIDERS_PATH).then((r) => (Array.isArray(r?.data) ? r.data : [])).catch(() => {
    if (shared === entry) shared = null;
    return [];
  });
  return (shared = entry).promise;
}

/** GET /api/v1/providers for route cards: null while loading, [] when it could not be loaded. */
export function useRouteProviders() {
  const [providers, setProviders] = useState(null);
  useEffect(() => {
    let active = true;
    loadProviders().then((list) => active && setProviders(list));
    return () => { active = false; };
  }, []);
  return providers;
}

const Value = ({ text }) => <dd data-missing={text === NO_DATA || undefined}>{text}</dd>;

/** `model` is a raw GET /api/v1/models record. `place` sets the spacing for the Harness rail or palette. */
export default function RouteCard({ model, providers, dark = false, place, id }) {
  const card = useMemo(() => routeCard(model, providers), [model, providers]);
  if (!card) return null;
  const tone = dark || undefined;
  return <section id={id} className={s.card} data-dark={tone} data-place={place} aria-label={`Route card for ${card.name}`}>
    <dl className={s.stats}>
      <div><dt>Input per 1M</dt><Value text={card.price.input} /></div>
      <div><dt>Output per 1M</dt><Value text={card.price.output} /></div>
      <div><dt>Context</dt><Value text={card.context} /></div>
    </dl>
    <dl className={s.rows}>
      <div><dt>Tags</dt><dd><span className={`${mc.chips} ${s.flush}`} data-dark={tone}>{card.tags.length ? card.tags.map((tag) => <span key={tag.key} className={mc.chip} title={tag.explanation}>{tag.label}</span>) : <span className={mc.chip}>No tags declared</span>}</span></dd></div>
      <div><dt>Routes</dt>{card.routes.length ? <dd><span className={`${pb.group} ${s.routes}`} data-dark={tone}>{card.routes.map((route) => <span key={route.key} className={pb.badge} data-tone={route.tone} title={route.explanation}>{route.label}</span>)}</span></dd> : <Value text={NO_DATA} />}</div>
      <div><dt>Best uptime, 30 days</dt><Value text={card.health.uptime} /></div>
      <div><dt>Best latency, p50</dt><Value text={card.health.latency} /></div>
      {card.proof && <div><dt>Hardware proof</dt><dd className={s.links}>{card.proof.providers.length ? card.proof.providers.map((p) => <a key={p.id} className={s.link} href={p.href}>Check {p.name} →</a>) : <a className={s.link} href={card.proof.href}>How to check →</a>}</dd></div>}
    </dl>
    <details className={`${mc.guide} ${s.flush}`} data-dark={tone}>
      <summary>What this card shows</summary>
      <ul>
        <li>Prices are per 1M tokens from the cheapest live provider; routing may pick another provider by uptime and quality.</li>
        {card.routes.map((route) => <li key={route.key}><b>{route.label}.</b> {route.explanation}</li>)}
        <li>Uptime and latency are each serving provider’s own figures across all the models it serves.</li>
      </ul>
    </details>
  </section>;
}

/** The card behind a disclosure, for a row in a list of models; it is built only once opened. */
export function RouteCardDetails({ model, providers, dark = false }) {
  const [open, setOpen] = useState(false);
  return <details className={`${mc.guide} ${s.toggle}`} data-dark={dark || undefined} onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary>Route card</summary>
    {open && <RouteCard model={model} providers={providers} dark={dark} />}
  </details>;
}
