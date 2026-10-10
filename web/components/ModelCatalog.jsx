"use client";
import ModelPerformance from "./ModelPerformance"; // E150
import { catalogSortFromUrl, catalogSortUrl } from "../lib/model-performance.js"; // E150
import { NewModelBadge, NewModelsFilter } from "./NewModels"; // C131
import { useEffect, useMemo, useState } from "react";
import { api, toCatalogModel } from "../lib/api";
import { modelUnavailable } from "../lib/model-availability.js"; // ON5
import { MODEL_CAPABILITIES } from "../lib/model-capabilities.js";
import { CATALOG_SORTS, filterModels, modelTagCounts } from "../lib/model-catalog.js";
import { CapabilityChips, CapabilityGuide } from "./ModelCapabilities";
import { RouteCardDetails, useRouteProviders } from "./RouteCard"; // U99
import { Button, Modal } from "./UI";
import s from "./ModelCatalog.module.css";
import ModelPageLink from "./ModelPageLink"; // E151

export default function ModelCatalog({ onChoose }) {
  const [query, setQuery] = useState("");
  const [tags, setTags] = useState([]);
  const [sort, setSort] = useState("name");
  const [selected, setSelected] = useState(null);
  const [models, setModels] = useState(null);
  const [observedAt, setObservedAt] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const providers = useRouteProviders(); // U99: uptime, latency and attestation for the route cards.
  useEffect(() => { // E150: restore links and browser Back/Forward without replacing other URL state.
    const restore = () => setSort(catalogSortFromUrl(window.location.href));
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const changeSort = value => { // E150
    setSort(value);
    window.history.pushState(window.history.state, "", catalogSortUrl(window.location.href, value));
  };
  useEffect(() => {
    let active = true;
    setError("");
    api("/api/v1/models?health=recent").then(r => {
      if (!active) return;
      setModels(r.data);
      setObservedAt(new Date());
    }).catch(e => active && setError(e.message));
    return () => { active = false; };
  }, [attempt]);
  const visible = useMemo(() => filterModels(models || [], { query, tags, sort }), [models, query, tags, sort]);
  const counts = useMemo(() => modelTagCounts(models || [], { query, tags }), [models, query, tags]);
  const perM = n => (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2));
  const toggle = key => setTags(current => current.includes(key) ? current.filter(tag => tag !== key) : [...current, key]);
  const chooseHref = id => "/dashboard/?model=" + encodeURIComponent(id) + "#playground";
  return <>
    <div className="catalog-tools">
      <label className="search-label"><span className="sr-only">Search models or providers</span><input type="search" className="search-field" placeholder="Search models or providers…" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label className="select-label"><span className="sr-only">Sort models</span><select aria-label="Sort models" value={sort} onChange={e => changeSort(e.target.value)}>{CATALOG_SORTS.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
    </div>
    <div className={s.filters} role="group" aria-label="Filter by capability">{MODEL_CAPABILITIES.map(tag => <button type="button" key={tag.key} title={tag.explanation} aria-pressed={tags.includes(tag.key)} onClick={() => toggle(tag.key)} disabled={!tags.includes(tag.key) && !counts[tag.key]}>{tag.label} <span>{counts[tag.key]}</span></button>)}</div>
    <NewModelsFilter tags={tags} onToggle={toggle} /> {/* C131 */}
    <CapabilityGuide />
    <div className="catalog-meta"><p className="catalog-note">Live catalog{observedAt ? " · updated " + observedAt.toLocaleTimeString("en-GB") : ""} · Prices are per 1M tokens from the cheapest live provider; routing may pick another provider by uptime and quality.</p>{models && !error && <span className="catalog-count" aria-live="polite">{visible.length} of {models.length} models</span>}</div>
    {error && <div className="empty"><h3>The model catalog could not be loaded.</h3><p>{error}</p><Button secondary onClick={() => setAttempt(n => n + 1)}>Retry</Button></div>}
    {!error && !models && <div className="empty loading-state" role="status"><span className="loading-bar" aria-hidden="true" />Loading the live catalog…</div>}
    <div className="model-grid">{visible.map((raw, i) => {
      const model = toCatalogModel(raw);
      return <article className="route-card model-card" key={model.id} style={{ "--i": Math.min(i, 10) }}>
        <div className="eyebrow">{model.author}<span className="live-square" />{model.type}</div>
        <NewModelBadge model={raw} /> {/* C131 */}
        <h3>{model.name}</h3><p>{model.description}</p><CapabilityChips model={raw} />
        <div className="model-meta"><span>{model.context} context</span><span>{model.providers} provider{model.providers === 1 ? "" : "s"}</span></div>
        <div className="model-meta"><span>${perM(model.price)} / 1M input</span><span>${perM(model.output)} / 1M output</span></div>
        <ModelPerformance model={raw} /> {/* E150 */}
        <RouteCardDetails model={raw} providers={providers} />
        <ModelPageLink model={raw} /> {/* E151 */}
        <div className="button-row"><button className="text-button" onClick={() => setSelected(raw)}>Model details →</button>{modelUnavailable(raw) ? <span role="status">Temporarily unavailable</span> : onChoose ? <button className="text-button" onClick={() => onChoose(model.id)}>Try model →</button> : <a className="text-button" href={chooseHref(model.id)}>Try model →</a>}</div>
        <div className="card-ramp" aria-hidden="true" />
      </article>;
    })}</div>
    {!visible.length && models && !error && <div className="empty"><h3>No matching models</h3><p>{!models.length ? "No providers are serving models yet." : "Try a different search or clear the filters."}</p><Button secondary onClick={() => { setQuery(""); setTags([]); }}>Clear filters</Button></div>}
    {selected && <ModelDetails raw={selected} onClose={() => setSelected(null)} onChoose={onChoose} />}
  </>;
}

function ModelDetails({ raw, onClose, onChoose }) {
  const model = toCatalogModel(raw);
  return <Modal title={model.name} onClose={onClose}>
    <p>{model.description}</p><CapabilityChips model={raw} /><CapabilityGuide />
    <dl className="detail-list">
      <div><dt>Model ID</dt><dd>{model.id}</dd></div>
      <div><dt>Context</dt><dd>{(model.contextLength || 0).toLocaleString("en-US")} tokens</dd></div>
      <div><dt>Input / output</dt><dd>${model.price.toLocaleString("en-US", { maximumSignificantDigits: 6 })} / ${model.output.toLocaleString("en-US", { maximumSignificantDigits: 6 })} per 1M tokens</dd></div>
      <div><dt>Providers</dt><dd>{raw.provider_names?.join(", ") || model.providers} · {model.quantization.join(", ") || "quantization not declared"}</dd></div>
      <div><dt>Creator royalty</dt><dd>{model.creator ? `${model.royaltyBps / 100}% to ${model.creator.slice(0, 10)}…` : "None"}</dd></div>
    </dl>
    <div className="note">Providers declare modalities, prices and context limits. Hardware tags reflect the router’s current checks. Ordinary chat is readable by the router in memory; encrypted chat requires the separate gateway setup.</div>
    {modelUnavailable(raw) ? <p role="status">Temporarily unavailable. Choose another model.</p> : onChoose ? <Button onClick={() => { onClose(); onChoose(model.id); }}>Choose model</Button> : <Button href={"/dashboard/?model=" + encodeURIComponent(model.id) + "#playground"}>Open playground</Button>}
  </Modal>;
}
