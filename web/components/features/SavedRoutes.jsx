"use client";
import { useEffect, useRef, useState } from "react";
import { Button, Modal, Code } from "../UI";
import { API_BASE, api, setMode } from "../../lib/api";
import { models as sampleCatalog, money } from "../../lib/demo";
import {
  MAX_MODELS,
  MAX_ROUTES,
  PARAM_FIELDS,
  PRIVACY,
  ROUTE_PREFIX,
  SORTS,
  baseModelId,
  createBody,
  draftToRoute,
  emptyDraft,
  laneRefusal,
  modelsOffList,
  moveItem,
  paramSummary,
  patchBody,
  policySummary,
  routeToDraft,
  sampleRoutes,
  slugify,
  snippet,
  usesAttestedList,
} from "../../lib/saved-routes";
import styles from "./SavedRoutes.module.css";

/**
 * Saved Routes workspace tab. Props (from Dashboard): { live, apiKey, ws, status, catalog, refresh, notify, fail, navigate }.
 * live=false is the explicit sample workspace: it shows fixed, labelled sample routes and never calls the API.
 */

function Field({ label, id, error, hint, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && !error && (
        <small className={styles.hint} id={id + "-hint"}>
          {hint}
        </small>
      )}
      {error && (
        <small className={styles.fieldError} id={id + "-error"} role="alert">
          {error}
        </small>
      )}
    </div>
  );
}

const described = (id, error, hint) => ({ "aria-invalid": error ? true : undefined, "aria-describedby": error ? id + "-error" : hint ? id + "-hint" : undefined });
const PRIVACY_HINT = {
  "": "Any provider that meets the other settings.",
  policy: "Only providers with a documented no-retention policy and no legal hold, or attested ones. The router refuses a call rather than use any other.",
  none: "Only providers whose retention is declared attested and whose attestation is fresh. The router refuses a call rather than use any other.",
  attested: "Sets provider.lane to attested: calls are served only by providers with a fresh, verified attestation, or refused. A request can tighten this, never loosen it. Every model in the route must be available on the lane to save.",
};
const priceText = (m) => (m ? `$${money(m.price, 2)} in · $${money(m.output, 2)} out /1M` : "Not in the catalog");

function Tags({ items, empty }) {
  if (!items.length) return <span className={styles.none}>{empty}</span>;
  return (
    <ul className={styles.tags}>
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

function RouteEditor({ existing, catalog, apiKey, onClose, onSaved }) {
  const [draft, setDraft] = useState(() => (existing ? routeToDraft(existing) : emptyDraft()));
  const [slugTouched, setSlugTouched] = useState(!!existing);
  const [query, setQuery] = useState("");
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const form = useRef(null);
  // Models with a live attested endpoint (GET /api/v1/models?lane=attested), loaded when the privacy choice needs them.
  const [laneList, setLaneList] = useState({ state: "idle", ids: new Set() });
  const needsList = usesAttestedList(draft.privacy);
  useEffect(() => {
    if (!needsList) return;
    let alive = true;
    setLaneList({ state: "loading", ids: new Set() });
    api("/api/v1/models?lane=attested", { key: apiKey })
      .then((r) => alive && setLaneList({ state: "ok", ids: new Set((r?.data || []).map((m) => m.id)) }))
      .catch(() => alive && setLaneList({ state: "error", ids: new Set() }));
    return () => {
      alive = false;
    };
  }, [needsList, apiKey]);
  const laneKnown = needsList && laneList.state === "ok";
  const offLane = laneKnown ? modelsOffList(draft.models, laneList.ids) : [];
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const setParam = (key, value) => setDraft((d) => ({ ...d, params: { ...d.params, [key]: value } }));
  const full = draft.models.length >= MAX_MODELS;
  const q = query.trim().toLowerCase();
  const pickable = catalog.filter((m) => m.type !== "Embeddings" && !draft.models.includes(m.id) && (!laneKnown || laneList.ids.has(m.id)));
  const matches = pickable.filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)).slice(0, 6);
  // Settings made through the API that this form does not edit; saving keeps them as they are.
  const extraPrice = Object.keys(draft.extraMaxPrice).length ? { max_price: draft.extraMaxPrice } : {};
  const extras = [...policySummary({ provider: { ...draft.extraProvider, ...extraPrice } }).slice(1), ...Object.keys(draft.extraMaxPrice).filter((k) => k !== "request").map((k) => `max_price.${k}`), ...paramSummary({ params: draft.extraParams })];

  function add(id) {
    if (full) return;
    set({ models: [...draft.models, id] });
    setQuery("");
    setErrors((e) => ({ ...e, models: undefined }));
  }

  async function submit(e) {
    e.preventDefault();
    const r = draftToRoute(draft, { catalogIds: new Set(catalog.map((m) => m.id)) });
    setErrors(r.errors);
    setError("");
    if (!r.ok) {
      setError("Check the highlighted fields.");
      // The form is long: take the person to the first field that needs attention.
      requestAnimationFrame(() => form.current?.querySelector('[aria-invalid="true"]')?.focus());
      return;
    }
    setBusy(true);
    try {
      const out = existing
        ? await api("/api/v1/routes/" + encodeURIComponent(existing.slug), { key: apiKey, method: "PATCH", body: patchBody(r, existing.slug) })
        : await api("/api/v1/routes", { key: apiKey, method: "POST", body: createBody(r) });
      await onSaved(out.data);
    } catch (err) {
      const unknown = err?.metadata?.unknown_models;
      if (unknown?.length) setErrors((x) => ({ ...x, models: "Not in the live catalog: " + unknown.join(", ") + "." }));
      const refused = laneRefusal(err);
      if (refused) setErrors((x) => ({ ...x, models: refused }));
      if (err?.type === "route_exists") setErrors((x) => ({ ...x, slug: "This account already has a route with that slug." }));
      setError(err?.message || String(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={existing ? `Edit ${ROUTE_PREFIX}${existing.slug}` : "New saved route"} onClose={onClose}>
      <form ref={form} onSubmit={submit} noValidate className={styles.editor}>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <Field label="Name" id="route-name" error={errors.name}>
          <input
            id="route-name"
            value={draft.name}
            maxLength={80}
            placeholder="e.g. Support chat"
            autoFocus
            onChange={(e) => set({ name: e.target.value, ...(slugTouched ? {} : { slug: slugify(e.target.value) }) })}
            {...described("route-name", errors.name)}
          />
        </Field>
        <Field label="Slug" id="route-slug" error={errors.slug} hint="Lowercase letters, digits and hyphens. Renaming breaks callers that use the old slug.">
          <div className={styles.slugInput}>
            <span aria-hidden="true">{ROUTE_PREFIX}</span>
            <input
              id="route-slug"
              value={draft.slug}
              maxLength={48}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="support-chat"
              onChange={(e) => {
                setSlugTouched(true);
                set({ slug: e.target.value.toLowerCase() });
              }}
              {...described("route-slug", errors.slug, true)}
            />
          </div>
        </Field>
        <Field label="Description (optional)" id="route-description" error={errors.description}>
          <textarea id="route-description" className={styles.shortText} value={draft.description} maxLength={280} placeholder="What this route is for" onChange={(e) => set({ description: e.target.value })} {...described("route-description", errors.description)} />
        </Field>

        <fieldset className={styles.group}>
          <legend>Models, in fallback order</legend>
          <p className="help-text">The first model is tried first; if none of its providers can serve the call, the next one is.</p>
          {draft.models.length ? (
            <ol className={styles.picked} aria-label="Selected models">
              {draft.models.map((id, i) => (
                <li key={id}>
                  <span className={styles.rank} aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className={styles.pickedName}>
                    <span className="mono">{id}</span>
                    <small>
                      {priceText(byId.get(baseModelId(id)))}
                      {offLane.includes(id) && <span className={styles.warn}> · not on the attested lane now</span>}
                    </small>
                  </span>
                  <span className={styles.moves}>
                    <button type="button" className="icon-button" aria-label={`Move ${id} up`} disabled={i === 0} onClick={() => set({ models: moveItem(draft.models, i, -1) })}>
                      ↑
                    </button>
                    <button type="button" className="icon-button" aria-label={`Move ${id} down`} disabled={i === draft.models.length - 1} onClick={() => set({ models: moveItem(draft.models, i, 1) })}>
                      ↓
                    </button>
                    <button type="button" className="icon-button" aria-label={`Remove ${id}`} onClick={() => set({ models: draft.models.filter((m) => m !== id) })}>
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          {errors.models && (
            <div className={styles.fieldError} id="route-models-error" role="alert">
              {errors.models}
            </div>
          )}
          {offLane.length > 0 && !errors.models && (
            <div className={styles.fieldError} role="status">
              The router will not save this route while {offLane.join(", ")} {offLane.length === 1 ? "has" : "have"} no attested provider. Remove {offLane.length === 1 ? "it" : "them"} or choose Standard privacy.
            </div>
          )}
          {needsList && laneList.state === "error" && <p className="help-text">The attested model list did not load; the router checks the models when you save.</p>}
          {laneKnown && <p className="help-text">Only models with a live attested provider are offered while privacy is set to {draft.privacy === "attested" ? "the attested lane" : "attested retention"}.</p>}
          <Field label={`Add a model · ${draft.models.length}/${MAX_MODELS}`} id="route-model-search">
            <input id="route-model-search" type="search" autoComplete="off" value={query} disabled={full} aria-invalid={errors.models ? true : undefined} aria-describedby={errors.models ? "route-models-error" : undefined} placeholder={full ? "Eight models is the maximum" : `Search ${pickable.length} model${pickable.length === 1 ? "" : "s"}…`} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (matches[0]) add(matches[0].id);
              }
            }} />
          </Field>
          {!full && (
            <ul className={styles.results} aria-label="Matching models">
              {matches.map((m) => (
                <li key={m.id}>
                  <button type="button" onClick={() => add(m.id)}>
                    <span className="mono">{m.id}</span>
                    <small>{priceText(m)}</small>
                    <b aria-hidden="true">+</b>
                    <span className="sr-only">Add {m.id}</span>
                  </button>
                </li>
              ))}
              {!matches.length && <li className={styles.none}>{!catalog.length ? "The model catalog did not load; reload the page to pick models." : pickable.length ? "No model matches that search." : "Every chat model in the catalog is already in this route."}</li>}
            </ul>
          )}
        </fieldset>

        <fieldset className={styles.group}>
          <legend>Provider policy</legend>
          <Field label="Privacy" id="route-privacy" hint={PRIVACY_HINT[draft.privacy]}>
            <select id="route-privacy" value={draft.privacy} onChange={(e) => set({ privacy: e.target.value })} {...described("route-privacy", null, true)}>
              {PRIVACY.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Provider order" id="route-sort">
            <select id="route-sort" value={draft.sort} onChange={(e) => set({ sort: e.target.value })}>
              {SORTS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <label className="check-label">
            <input type="checkbox" checked={draft.allowFallbacks} onChange={(e) => set({ allowFallbacks: e.target.checked })} /> Fall back to another provider of the same model
          </label>
          <label className="check-label">
            <input type="checkbox" checked={draft.zdr} onChange={(e) => set({ zdr: e.target.checked })} /> Zero-data-retention providers only
          </label>
          <div className="two-fields">
            <Field label="Max prompt price · USD/1M" id="route-max-prompt" error={errors.maxPrompt}>
              <input id="route-max-prompt" type="number" inputMode="decimal" min="0" step="any" placeholder="No cap" value={draft.maxPrompt} onChange={(e) => set({ maxPrompt: e.target.value })} {...described("route-max-prompt", errors.maxPrompt)} />
            </Field>
            <Field label="Max completion price · USD/1M" id="route-max-completion" error={errors.maxCompletion}>
              <input id="route-max-completion" type="number" inputMode="decimal" min="0" step="any" placeholder="No cap" value={draft.maxCompletion} onChange={(e) => set({ maxCompletion: e.target.value })} {...described("route-max-completion", errors.maxCompletion)} />
            </Field>
          </div>
        </fieldset>

        <fieldset className={styles.group}>
          <legend>Default parameters</legend>
          <p className="help-text">Applied only when a request leaves them unset; empty fields pass the request’s own values through.</p>
          <div className={styles.params}>
            {PARAM_FIELDS.map((f) => (
              <Field key={f.key} label={f.label} id={"route-" + f.key} error={errors[f.key]}>
                <input id={"route-" + f.key} type="number" inputMode={f.int ? "numeric" : "decimal"} min={f.min} max={f.max} step={f.step} placeholder="Request value" value={draft.params[f.key]} onChange={(e) => setParam(f.key, e.target.value)} {...described("route-" + f.key, errors[f.key])} />
              </Field>
            ))}
            <Field label="Stop sequences" id="route-stop" error={errors.stop} hint="Up to 4, comma-separated; \n is a newline.">
              <input id="route-stop" value={draft.stop} placeholder="e.g. END, \n\n" onChange={(e) => set({ stop: e.target.value })} {...described("route-stop", errors.stop, true)} />
            </Field>
          </div>
        </fieldset>

        {extras.length > 0 && (
          <div className="note">
            Also kept from the API: {extras.join(" · ")}.
          </div>
        )}
        <div className="note">A route stores models, provider preferences and sampling defaults only. It never stores prompts or system messages.</div>
        <div className="button-row">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : existing ? "Save changes" : "Create route"}
          </Button>
          <Button type="button" secondary onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteDialog({ route, apiKey, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={`Delete ${ROUTE_PREFIX}${route.slug}?`} onClose={onClose}>
      <p>
        Calls that send <code className="mono">{ROUTE_PREFIX + route.slug}</code> will fail with <code className="mono">route_not_found</code> right away. Receipts of past calls are unaffected. This cannot be undone.
      </p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="button-row modal-actions">
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api("/api/v1/routes/" + encodeURIComponent(route.slug), { key: apiKey, method: "DELETE" });
              await onDeleted();
            } catch (e) {
              setError(e?.message || String(e));
              setBusy(false);
            }
          }}
        >
          {busy ? "Deleting…" : "Delete route"}
        </Button>
        <Button secondary onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

export default function SavedRoutes({ live, apiKey, ws, catalog = [], notify }) {
  const [routes, setRoutes] = useState(null); // null while loading
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState(null); // { route } to edit, {} to create
  const [removing, setRemoving] = useState(null);
  const [selected, setSelected] = useState("");
  const [lang, setLang] = useState("js");
  const snippetRef = useRef(null);
  // A plain sub-key (no management rights, no team) is a member: it can read and call routes, not edit them.
  const readOnly = live && !!ws?.me && !ws.me.management && !ws.me.team;
  const rows = live ? routes || [] : sampleRoutes;
  const byId = new Map((live ? catalog : sampleCatalog).map((m) => [m.id, m]));
  const current = rows.find((r) => r.slug === selected) || rows[0] || null;
  const origin = typeof window !== "undefined" ? API_BASE || window.location.origin : "";
  const atLimit = live && (routes?.length ?? 0) >= MAX_ROUTES;

  async function load() {
    setLoadError("");
    try {
      const r = await api("/api/v1/routes", { key: apiKey });
      setRoutes(r.data);
      return r.data;
    } catch (e) {
      setLoadError(e?.message || String(e));
      setRoutes((x) => x ?? []);
    }
  }
  useEffect(() => {
    if (live && apiKey) load();
  }, [live, apiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function use(slug) {
    setSelected(slug);
    requestAnimationFrame(() => snippetRef.current?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
  }

  const heading = (
    <div className="panel-heading">
      <div>
        <h2>Name a policy. Call it anywhere.</h2>
        <p className="help-text">
          A saved route bundles fallback models, provider preferences and default parameters under one name. Any OpenAI-compatible client calls it as <code className="mono">model: "@route/&lt;slug&gt;"</code>.
        </p>
      </div>
      {!live ? (
        <span className="badge">Sample routes · not saved</span>
      ) : readOnly ? (
        <span className="badge">Read only · member key</span>
      ) : (
        <Button onClick={() => setEditing({})} disabled={atLimit || routes === null} title={atLimit ? `An account can save at most ${MAX_ROUTES} routes. Delete one first.` : undefined}>
          New route
        </Button>
      )}
    </div>
  );

  if (live && routes === null)
    return (
      <>
        {heading}
        <div className="empty loading-state" role="status">
          <span className="loading-bar" aria-hidden="true" />
          Loading saved routes…
        </div>
      </>
    );

  return (
    <>
      {heading}
      {!live && (
        <div className="note">
          Saved routes live on the router, one set per account. This sample workspace has no account, so the routes below are fixed examples: they cannot be called, edited or deleted here.{" "}
          <button
            className="text-button"
            onClick={() => {
              setMode("live");
              window.location.reload();
            }}
          >
            Switch to your live workspace →
          </button>
        </div>
      )}
      {live && readOnly && <div className="note">This key is a member key: it can list and call the account’s routes. Owners and admins create and edit them.</div>}
      {loadError && (
        <div className="error" role="alert">
          Could not load saved routes: {loadError}{" "}
          <button className="text-button" onClick={load}>
            Retry
          </button>
        </div>
      )}
      {rows.length ? (
        <>
          <div className={styles.meta}>
            <span className="catalog-count">{live ? `${rows.length} / ${MAX_ROUTES} routes` : `${rows.length} sample routes`}</span>
          </div>
          <div className="table-wrap">
            <table className={"data-table " + styles.table}>
              <thead>
                <tr>
                  <th>Route</th>
                  <th>Fallback order</th>
                  <th>Provider policy</th>
                  <th>Defaults</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.slug} style={{ "--i": Math.min(i, 12) }} className={current?.slug === r.slug ? styles.current : undefined}>
                    <td className="cell-primary">
                      <strong>{r.name}</strong>
                      <code className={styles.slug}>{ROUTE_PREFIX + r.slug}</code>
                      {r.sample && <span className="badge">Sample</span>}
                      {r.description && <small className={styles.description}>{r.description}</small>}
                    </td>
                    <td data-label="Fallback order">
                      <ol className={styles.order}>
                        {r.config.models.map((m) => (
                          <li key={m}>
                            <span className="mono">{m}</span>
                            {live && !byId.has(baseModelId(m)) && <span className={styles.warn}>not in catalog</span>}
                          </li>
                        ))}
                      </ol>
                    </td>
                    <td data-label="Provider policy">
                      <Tags items={policySummary(r.config)} />
                    </td>
                    <td data-label="Defaults">
                      <Tags items={paramSummary(r.config)} empty="Request values" />
                    </td>
                    <td className="cell-action">
                      <div className={styles.actions}>
                        <button className="text-button" onClick={() => use(r.slug)} aria-label={`Show code for ${ROUTE_PREFIX}${r.slug}`}>
                          Use →
                        </button>
                        {live && !readOnly && (
                          <>
                            <button className="text-button" onClick={() => setEditing({ route: r })} aria-label={`Edit ${ROUTE_PREFIX}${r.slug}`}>
                              Edit
                            </button>
                            <button className="text-button" onClick={() => setRemoving(r)} aria-label={`Delete ${ROUTE_PREFIX}${r.slug}`}>
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        !loadError && (
          <div className="empty">
            <h3>No saved routes yet.</h3>
            <p>{readOnly ? "An owner or admin of this account can create the first one." : "Save a fallback list and provider policy once, then call it by name from any app."}</p>
            {!readOnly && <Button onClick={() => setEditing({})}>Create your first route</Button>}
          </div>
        )
      )}

      <div className="panel-heading" ref={snippetRef}>
        <div>
          <h2>Call it by name.</h2>
          <p className="help-text">Pass the route as the model. The response names the model that served it{live ? " and the route." : "."}</p>
        </div>
        {rows.length > 1 && (
          <select aria-label="Route shown in the snippet" className={styles.pick} value={current?.slug || ""} onChange={(e) => setSelected(e.target.value)}>
            {rows.map((r) => (
              <option key={r.slug} value={r.slug}>
                {ROUTE_PREFIX + r.slug}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className={styles.useGrid}>
        <div>
          <div className={styles.langs} role="group" aria-label="Snippet language">
            {[
              ["js", "JavaScript"],
              ["python", "Python"],
            ].map(([id, label]) => (
              <button key={id} type="button" aria-pressed={lang === id} onClick={() => setLang(id)}>
                {label}
              </button>
            ))}
          </div>
          <Code label={"OpenAI SDK · " + (current ? (current.sample ? "sample " : "") + ROUTE_PREFIX + current.slug : "example")}>{snippet(current?.slug, origin, lang)}</Code>
        </div>
        <div className={styles.rules}>
          <span className="eyebrow">How a route resolves</span>
          <ol>
            <li>
              <strong>The request wins.</strong> Any parameter, <code className="mono">provider</code> field or <code className="mono">models</code> list the call sets overrides the route’s default. The exception is privacy: for <code className="mono">lane</code> and <code className="mono">disclosure</code> the stricter of the two applies, so a request can tighten a route but never loosen it.
            </li>
            <li>
              <strong>Then the route.</strong> Its first model is primary, the rest are fallbacks; its provider policy and defaults fill the gaps.
            </li>
            <li>
              <strong>Key limits still apply.</strong> A key’s allowed models and guardrails are enforced on whatever the route resolves to.
            </li>
          </ol>
          <p>Routes belong to one account: another account’s key gets <code className="mono">route_not_found</code>.</p>
        </div>
      </div>

      {editing && (
        <RouteEditor
          existing={editing.route}
          catalog={catalog}
          apiKey={apiKey}
          onClose={() => setEditing(null)}
          onSaved={async (saved) => {
            await load();
            setSelected(saved.slug);
            setEditing(null);
            notify?.(editing.route ? `Saved ${ROUTE_PREFIX}${saved.slug}.` : `Created ${ROUTE_PREFIX}${saved.slug}. Call it with model: "${ROUTE_PREFIX}${saved.slug}".`);
          }}
        />
      )}
      {removing && (
        <DeleteDialog
          route={removing}
          apiKey={apiKey}
          onClose={() => setRemoving(null)}
          onDeleted={async () => {
            const slug = removing.slug;
            await load();
            setRemoving(null);
            if (selected === slug) setSelected("");
            notify?.(`Deleted ${ROUTE_PREFIX}${slug}.`);
          }}
        />
      )}
    </>
  );
}
