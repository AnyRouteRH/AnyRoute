"use client";
// G165: one static shell; the browser reads existing public APIs without a key.
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { MODEL_CAPABILITIES, modelCapabilities } from "../lib/model-capabilities.js";
import { compareContext, compareHref, comparisonDifferences, loadModelComparison, parseCompareIds } from "../lib/model-compare.js";
import { firstListed, modelChatHref, modelPageHref, modelPrices, modelProviderRows } from "../lib/model-page.js";
import { modelUnavailable } from "../lib/model-availability.js";
import { Button, CopyButton } from "./UI";
import ProofBadge from "./ProofBadge";
import s from "./ModelCompare.module.css";

export function ModelCompareView({ columns, providers = [], endpoints = {}, healthError = false, shareUrl = "" }) {
  const reference = columns.find(column => column.model)?.model;
  const capabilities = columns.map(({ model }) => model ? modelCapabilities(model) : null);
  const different = index => new Set(capabilities.filter(Boolean).map(caps => caps.includes(MODEL_CAPABILITIES[index].key))).size > 1;
  const facts = [
    ["Input per million tokens", model => modelPrices(model).input],
    ["Output per million tokens", model => modelPrices(model).output],
    ["Context length", model => compareContext(model) ? `${compareContext(model).toLocaleString("en-US")} tokens` : "Not listed"],
    ["First listed by Anyroute", model => firstListed(model) || "Date not known"],
  ];
  return <article className={s.page}>
    <header className={s.heading}><a className="text-button" href="/models/">← All models</a><span className="eyebrow">MODELS</span><h1>Compare models side by side</h1><p>Compare abilities, token prices, context and providers before choosing a model.</p>{shareUrl && <CopyButton text={shareUrl} label="Copy comparison link" />}</header>
    {shareUrl && <label className={s.share}>Comparison link<input type="text" readOnly value={shareUrl} onFocus={event => event.target.select()} /></label>}
    <p className={s.note}>Prices are from the cheapest live provider; routing may choose another provider. Differences compare with {reference?.name || reference?.id || "the first found model"}. First listed is when Anyroute first observed the model, rather than its release date.</p>
    {healthError && <p role="status">Some provider health could not be loaded. Available readings are shown below.</p>}
    <p className={s.note}>On a small screen, scroll the table sideways to see every model.</p>
    <div className={s.scroll} role="region" aria-label="Model comparison table" tabIndex={0}><table className={s.table}>
      <caption>Abilities, prices, context and provider uptime</caption>
      <thead><tr><th scope="col">Compare</th>{columns.map(({ id, model }) => <th scope="col" key={id}>{model ? <><a href={modelPageHref(id)}>{model.name || id}</a><p>{id}</p><Button href={modelChatHref(id)}>Try in Chat</Button>{modelUnavailable(model) && <p>Temporarily unavailable</p>}</> : <><span>{id}</span><p>Model not found</p></>}</th>)}</tr></thead>
      <tbody>
        <tr><th scope="row">Differences</th>{columns.map(({ id, model }) => <td key={id} data-different={comparisonDifferences(model, reference).length > 0 || undefined}>{model ? model.id === reference.id ? "Compared with this model" : comparisonDifferences(model, reference).length ? comparisonDifferences(model, reference).map(text => <strong className={s.difference} key={text}>{text}</strong>) : "No price or context difference in known readings" : "Not found"}</td>)}</tr>
        {MODEL_CAPABILITIES.map((capability, index) => <tr key={capability.key}><th scope="row">{capability.label}</th>{columns.map(({ id, model }, column) => <td key={id} data-different={!!model && different(index) || undefined}>{model ? capabilities[column].includes(capability.key) ? "Listed" : "Not listed" : "Not found"}</td>)}</tr>)}
        {facts.map(([label, read]) => <tr key={label}><th scope="row">{label}</th>{columns.map(({ id, model }) => <td key={id}>{model ? read(model) : "Not found"}</td>)}</tr>)}
        <tr><th scope="row">Providers and 30-day uptime</th>{columns.map(({ id, model }) => {
          const rows = model ? modelProviderRows(model, providers, endpoints[id]) : [];
          return <td key={id}>{!model ? "Not found" : rows.length ? <ul>{rows.map(({ provider, modelSpecific, uptime }) => <li key={provider.slug}><strong>{provider.name}</strong><ProofBadge evidence={{ source: "attestation", data: { ...provider.attestation, provider: provider.slug } }} /><p>{uptime} · {modelSpecific ? "For this model" : "Across this provider’s models"}</p></li>)}</ul> : <><p>No provider records could be matched.</p>{Array.isArray(model.provider_names) && <p>{model.provider_names.join(", ")}</p>}</>}</td>;
        })}</tr>
      </tbody>
    </table></div>
    <p className={s.note}>Abilities are declared by providers. Missing readings stay unknown. Hardware checks do not prove answer quality or hide ordinary prompts from the router. Ordinary Chat sends request text that the router reads in memory; encrypted chat needs the separate gateway setup.</p>
    <a className="text-button" href="/docs/#compare-models">Read about model comparisons</a>
  </article>;
}
export default function ModelCompare() {
  const [state, setState] = useState({ loading: true }), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const ids = parseCompareIds(window.location.search);
    if (ids.length < 2) { setState({ needsPicks: true }); return () => controller.abort(); }
    setState({ loading: true });
    loadModelComparison(ids, api, controller.signal).then(result => {
      if (active) setState({ ...result, shareUrl: new URL(compareHref(ids), window.location.origin).href });
    }).catch(() => { if (active) setState({ error: true }); });
    return () => { active = false; controller.abort(); };
  }, [attempt]);
  if (state.needsPicks) return <div className="empty"><h1>Pick two or three models</h1><p>Use Compare on model pages or catalogue cards, then open the comparison from your picks.</p><Button href="/models/">Choose models</Button></div>;
  if (state.loading) return <div className="empty" role="status">Loading comparison…</div>;
  if (state.error) return <div className="empty"><h1>The comparison could not be loaded</h1><p>Check your connection and try again.</p><Button onClick={() => setAttempt(value => value + 1)}>Retry</Button></div>;
  return <ModelCompareView {...state} />;
}
