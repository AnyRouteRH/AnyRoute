"use client";
// E151: one exported shell, resolved from the public catalogue in the browser.
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { PROVIDERS_PATH } from "../lib/providers.js";
import { firstListed, loadModelPage, modelChatHref, modelCurl, modelEndpointsPath, modelPrices, modelProviderRows, setModelMetadata } from "../lib/model-page.js";
import { modelUnavailable } from "../lib/model-availability.js";
import { CapabilityChips } from "./ModelCapabilities";
import ProofBadge from "./ProofBadge";
import { Button, CopyButton } from "./UI";
import s from "./ModelPage.module.css";

export function ModelPageView({ model, providers = null, endpoints = null, observedAt = null, healthError = false }) {
  if (!model) return <div className="empty"><h1>Model not found</h1><p>Choose a model from the catalogue to open its page.</p><Button href="/models/">Back to models</Button></div>;
  const prices = modelPrices(model), listed = firstListed(model), rows = modelProviderRows(model, providers, endpoints);
  const context = model.context_length ?? model.top_provider?.context_length;
  const snippet = modelCurl(model.id);
  return <article className={s.page}>
    <header className={s.heading}>
      <a className="text-button" href="/models/">← All models</a>
      <span className="eyebrow">MODEL</span><h1>{model.name || model.id}</h1><p className={s.id}>{model.id}</p>
      {typeof model.description === "string" && model.description.trim() && <p>{model.description}</p>}
      <CapabilityChips model={model} />
      <div className="button-row"><Button href={modelChatHref(model.id)}>Try in Chat</Button></div>
      {modelUnavailable(model) && <p role="status">Temporarily unavailable. You can open Chat and choose another model.</p>}
    </header>
    <section aria-label="Prices and context"><h2>Prices and context</h2><dl className={s.facts}>
      <div><dt>Input per million tokens</dt><dd>{prices.input}</dd></div>
      <div><dt>Output per million tokens</dt><dd>{prices.output}</dd></div>
      {prices.image && <div><dt>Per image</dt><dd>{prices.image}</dd></div>}
      <div><dt>Context length</dt><dd>{Number.isSafeInteger(context) && context > 0 ? context.toLocaleString("en-US") + " tokens" : "Not listed"}</dd></div>
      <div><dt>First listed by Anyroute</dt><dd>{listed ? <time dateTime={listed}>{listed}</time> : "Date not known"}</dd></div>
    </dl><p className={s.note}>Token prices come from the cheapest live provider. Routing may choose another provider. First listed is when Anyroute first observed the model, rather than its release date.</p></section>
    <section aria-label="Providers and health"><h2>Providers and live health</h2>
      <p className={s.note}>Uptime covers 30 days. Median latency and speed use the latest readings, kept for up to an hour as new requests arrive. Hardware checks do not hide ordinary prompts from the router or prove answer quality.</p>
      {observedAt && <p className={s.note}>Loaded <time dateTime={observedAt.toISOString()}>{observedAt.toLocaleTimeString("en-GB", { timeZone: "UTC" })} UTC</time></p>}
      {healthError && <p role="status">Some provider health could not be loaded. Available readings are shown below.</p>}
      {providers === null ? <p role="status">Loading providers…</p> : rows.length ? <ul className={s.providers}>{rows.map(({ provider, modelSpecific, uptime, latency, speed }) => <li className={s.provider} key={provider.slug}>
        <h3>{provider.name}</h3><ProofBadge evidence={{ source: "attestation", data: { ...provider.attestation, provider: provider.slug } }} />
        <p className={s.note}>{modelSpecific ? "Readings for this model at this provider." : "Provider-wide readings across its models. Model-specific speed is not reported."}</p>
        <dl className={s.facts}><div><dt>Uptime · 30 days</dt><dd>{uptime}</dd></div><div><dt>Recent median latency</dt><dd>{latency}</dd></div><div><dt>Recent median speed</dt><dd>{speed}</dd></div></dl>
      </li>)}</ul> : <p>No provider records could be matched. {Array.isArray(model.provider_names) && model.provider_names.length ? "Listed providers: " + model.provider_names.join(", ") + "." : "No providers are listed."}</p>}
    </section>
    <section className={s.example} aria-label="API example"><h2>Call this model</h2><p>Set ANYROUTE_API_KEY to your API key, then run this request.</p><CopyButton text={snippet} label="Copy curl request" /><pre tabIndex={0} aria-label="curl request"><code>{snippet}</code></pre><p className={s.note}>This example sends an ordinary request. The router reads request text in memory.</p></section>
  </article>;
}

export default function ModelPage() {
  const [state, setState] = useState({ loading: true, model: null, providers: null, endpoints: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const id = new URLSearchParams(window.location.search).get("id") || "";
    setState({ loading: true, model: null, providers: null, endpoints: null });
    (async () => {
      try {
        const model = id ? await loadModelPage(id, api, controller.signal) : null;
        if (!active) return;
        setModelMetadata(document, model);
        setState({ loading: false, model, providers: model ? null : [], endpoints: null });
        if (!model) return;
        const path = modelEndpointsPath(model.id);
        const results = await Promise.allSettled([api(PROVIDERS_PATH, { signal: controller.signal }), path ? api(path, { signal: controller.signal }) : Promise.resolve(null)]);
        if (!active) return;
        const providers = results[0].status === "fulfilled" ? results[0].value?.data : null;
        const endpoints = results[1].status === "fulfilled" ? results[1].value?.data?.endpoints : null;
        setState({ loading: false, model, providers: Array.isArray(providers) ? providers : [], endpoints, observedAt: new Date(), healthError: !Array.isArray(providers) || !!path && !Array.isArray(endpoints) });
      } catch {
        if (active) setState({ loading: false, error: true });
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [attempt]);
  if (state.loading) return <div className="empty" role="status">Loading model…</div>;
  if (state.error) return <div className="empty"><h1>The model could not be loaded</h1><p>Check your connection and try again.</p><Button onClick={() => setAttempt(value => value + 1)}>Retry</Button> <a href="/models/">Back to models</a></div>;
  return <ModelPageView {...state} />;
}
