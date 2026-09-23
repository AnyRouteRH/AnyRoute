"use client";
import { useEffect, useState } from "react";
import { models as sampleModels } from "../lib/demo";
import { api, getMode, setMode, toCatalogModel } from "../lib/api";
import { Button, Modal } from "./UI";

export default function ModelCatalog({ onChoose, source }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [sort, setSort] = useState("name");
  const [selected, setSelected] = useState(null);
  const [mode, setModeState] = useState(source || null);
  const [liveModels, setLiveModels] = useState(null);
  const [observedAt, setObservedAt] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const m = source || getMode();
    setModeState(m);
    if (m !== "live") return;
    api("/api/v1/models")
      .then((r) => {
        setLiveModels(r.data.map(toCatalogModel));
        setObservedAt(new Date());
      })
      .catch((e) => setError(e.message));
  }, [source]);
  const live = mode === "live";
  const models = live ? liveModels || [] : sampleModels;
  const visible = models
    .filter((m) => (m.name + " " + m.id).toLowerCase().includes(query.toLowerCase()) && (filter === "All" || (filter === "Private" ? m.private : m.type === filter)))
    .sort((a, b) => (sort === "price" ? a.price - b.price : a.name.localeCompare(b.name)));
  const perM = (n) => (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2));
  return (
    <>
      <div className="catalog-tools">
        <label className="search-label">
          <span className="sr-only">Search models</span>
          <input className="search-field" placeholder="Search models or authors…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label className="select-label">
          <span className="sr-only">Filter models</span>
          <select aria-label="Filter models" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option>All</option>
            <option>General</option>
            <option>Reasoning</option>
            <option>Private</option>
          </select>
        </label>
        <label className="select-label">
          <span className="sr-only">Sort models</span>
          <select aria-label="Sort models" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="name">Name</option>
            <option value="price">{live ? "Price" : "Sample price"}</option>
          </select>
        </label>
      </div>
      <div className="catalog-meta">
        <p className="catalog-note">
          {live
            ? `Live catalog${observedAt ? " · updated " + observedAt.toLocaleTimeString("en-GB") : ""} · Prices are per 1M tokens from the cheapest live provider; routing may pick another provider by uptime and quality.`
            : "Sample catalog · Prices and availability below are illustrative, not live offers."}
        </p>
        {(!live || liveModels) && !error && (
          <span className="catalog-count" aria-live="polite">
            {visible.length} of {models.length} {live ? "models" : "sample models"}
          </span>
        )}
      </div>
      {live && error && (
        <div className="empty">
          <h3>The model catalog could not be loaded.</h3>
          <p>{error}</p>
          <Button
            secondary
            onClick={() => {
              setMode("demo");
              window.location.reload();
            }}
          >
            View the sample catalog
          </Button>
        </div>
      )}
      {live && !error && !liveModels && (
        <div className="empty loading-state" role="status">
          <span className="loading-bar" aria-hidden="true" />
          Loading the live catalog…
        </div>
      )}
      <div className="model-grid">
        {visible.map((m, i) => (
          <article className="route-card model-card" key={m.id} style={{ "--i": Math.min(i, 10) }}>
            <div className="eyebrow">
              {m.author}
              <span className="live-square" />
              {m.type}
            </div>
            <h3>{m.name}</h3>
            <p>{m.description}</p>
            <div className="model-meta">
              <span>{m.context} context</span>
              <span>{live ? (m.private ? "Attested private route" : "Standard route") : m.private ? "Private route fixture" : "Standard route fixture"}</span>
            </div>
            <div className="model-meta">
              <span>${perM(m.price)} / 1M input</span>
              <span>${perM(m.output)} / 1M output</span>
            </div>
            <div className="button-row">
              <button className="text-button" onClick={() => setSelected(m)}>
                Model details →
              </button>
              {onChoose ? (
                <button className="text-button" onClick={() => onChoose(m.id)}>
                  Try model →
                </button>
              ) : (
                <a className="text-button" href={"/dashboard/?model=" + encodeURIComponent(m.id) + "#playground"}>
                  Try model →
                </a>
              )}
            </div>
            <div className="card-ramp" aria-hidden="true" />
          </article>
        ))}
      </div>
      {!visible.length && (!live || liveModels) && !error && (
        <div className="empty">
          <h3>No matching models</h3>
          <p>{live && !models.length ? "No providers are serving models yet." : "Try a different search or clear the filters."}</p>
          <Button
            secondary
            onClick={() => {
              setQuery("");
              setFilter("All");
            }}
          >
            Clear filters
          </Button>
        </div>
      )}
      {selected && (
        <Modal title={selected.name} onClose={() => setSelected(null)}>
          <p>{selected.description}</p>
          <dl className="detail-list">
            <div>
              <dt>Model ID</dt>
              <dd>{selected.id}</dd>
            </div>
            <div>
              <dt>{live ? "Context" : "Example context"}</dt>
              <dd>{live ? (selected.contextLength || 0).toLocaleString("en-US") + " tokens" : selected.context}</dd>
            </div>
            <div>
              <dt>{live ? "Input / output" : "Sample input / output"}</dt>
              <dd>
                ${perM(selected.price)} / ${perM(selected.output)} per 1M tokens
              </dd>
            </div>
            <div>
              <dt>{live ? "Private route" : "Private sample route"}</dt>
              <dd>{live ? (selected.private ? "Available from an attested provider" : "No attested provider right now") : selected.private ? "Available in this demo" : "Unavailable in this demo"}</dd>
            </div>
            {live && (
              <>
                <div>
                  <dt>Providers</dt>
                  <dd>
                    {selected.providers} · {selected.quantization.join(", ") || "quantization not declared"}
                    {selected.zdr ? " · zero data retention available" : ""}
                  </dd>
                </div>
                <div>
                  <dt>Creator royalty</dt>
                  <dd>{selected.creator ? `${selected.royaltyBps / 100}% to ${selected.creator.slice(0, 10)}…` : "None"}</dd>
                </div>
              </>
            )}
          </dl>
          <div className="note">
            {live ? "Supplied by the provider registry: each provider publishes its models, prices and quantization, and quant canaries check the claims hourly." : "These are frontend fixtures. The production catalog must be supplied by the verified provider registry."}
          </div>
          {onChoose ? (
            <Button
              onClick={() => {
                setSelected(null);
                onChoose(selected.id);
              }}
            >
              Open playground
            </Button>
          ) : (
            <Button href={"/dashboard/?model=" + encodeURIComponent(selected.id) + "#playground"}>Open playground</Button>
          )}
        </Modal>
      )}
    </>
  );
}
