"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Modal, Code } from "../UI";
import { API_BASE, api, setMode } from "../../lib/api";
import { MAX_PRESETS, NAME_RE, PRESET_PREFIX, diffDocs, docText, parseDoc, pinned, presetSummary, samplePresets, shortHash, showValue, slugifyName, snippet, versionLabel } from "../../lib/presets";
import routeStyles from "./SavedRoutes.module.css";
import styles from "./Presets.module.css";

/**
 * Presets workspace tab: versioned saved routes (@preset/<name>[@<version>]) with a version list, a diff view and rollback.
 * Props (from Dashboard): { live, apiKey, ws, catalog, notify }. live=false shows fixed, labelled samples and never calls the API.
 */

const when = (iso) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const enc = encodeURIComponent;

function Tags({ items, empty }) {
  if (!items.length) return <span className={routeStyles.none}>{empty}</span>;
  return (
    <ul className={routeStyles.tags}>
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

function PresetEditor({ existing, catalog, apiKey, onClose, onSaved }) {
  const [name, setName] = useState(existing?.name || "");
  const [text, setText] = useState(() => docText(existing?.config));
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const catalogIds = useMemo(() => (catalog?.length ? new Set(catalog.map((m) => m.id)) : undefined), [catalog]);

  async function submit(e) {
    e.preventDefault();
    setError("");
    const parsed = parseDoc(text, { catalogIds });
    const errs = { ...(parsed.ok ? {} : parsed.errors), ...(NAME_RE.test(name) ? {} : { name: "2-48 lowercase letters, digits and hyphens, starting with a letter or digit." }) };
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const r = await api("/api/v1/presets/" + enc(name), { key: apiKey, method: "PUT", body: parsed.doc });
      await onSaved(r.data);
    } catch (e2) {
      setError(e2?.message || String(e2));
      setBusy(false);
    }
  }

  return (
    <Modal title={existing ? `New version of ${PRESET_PREFIX}${existing.name}` : "New preset"} onClose={onClose}>
      <form className={routeStyles.editor} onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="preset-name">Name</label>
          <input
            id="preset-name"
            value={name}
            disabled={!!existing}
            placeholder="support"
            onChange={(e) => setName(slugifyName(e.target.value) || e.target.value.toLowerCase())}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? "preset-name-error" : undefined}
          />
          {errors.name && (
            <small className={routeStyles.fieldError} id="preset-name-error" role="alert">
              {errors.name}
            </small>
          )}
        </div>
        <div className="field">
          <label htmlFor="preset-doc">Preset (JSON)</label>
          <textarea
            id="preset-doc"
            className={styles.doc}
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-invalid={Object.keys(errors).some((k) => k !== "name") ? true : undefined}
            aria-describedby="preset-doc-hint"
          />
          <small className={routeStyles.hint} id="preset-doc-hint">
            description, models, provider, params, system_prompt (up to 16,000 characters), response_format, tools (up to 32), tool_choice. Saving a change adds a version; nothing is overwritten.
          </small>
          {Object.entries(errors)
            .filter(([k]) => k !== "name")
            .map(([k, msg]) => (
              <small key={k} className={routeStyles.fieldError} role="alert">
                {msg}
              </small>
            ))}
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="button-row">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : existing ? "Save version" : "Create preset"}
          </Button>
          <Button type="button" secondary onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteDialog({ preset, apiKey, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={`Delete ${PRESET_PREFIX}${preset.name}?`} onClose={onClose}>
      <p>
        All {preset.versions} version{preset.versions === 1 ? "" : "s"} go with it. Calls that send <code className="mono">{PRESET_PREFIX + preset.name}</code>, pinned or not, fail with <code className="mono">preset_not_found</code> right away. Receipts of past calls are unaffected. This cannot be undone.
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
              await api("/api/v1/presets/" + enc(preset.name), { key: apiKey, method: "DELETE" });
              await onDeleted();
            } catch (e) {
              setError(e?.message || String(e));
              setBusy(false);
            }
          }}
        >
          {busy ? "Deleting…" : "Delete preset"}
        </Button>
        <Button secondary onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

/** Versions of one preset, newest first, with a diff between any two and rollback to any earlier one. */
function History({ preset, live, readOnly, apiKey, notify, onChanged }) {
  const [versions, setVersions] = useState(live ? null : preset.history);
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(0);

  async function loadVersions() {
    setError("");
    try {
      const r = await api(`/api/v1/presets/${enc(preset.name)}/versions`, { key: apiKey });
      setVersions(r.data);
    } catch (e) {
      setError(e?.message || String(e));
      setVersions((x) => x ?? []);
    }
  }
  useEffect(() => {
    if (live) loadVersions();
    else setVersions(preset.history);
    setFrom(null);
    setTo(null);
  }, [live, preset.name, preset.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const latest = versions?.[0]?.version ?? preset.version;
  const toV = to ?? latest;
  const fromV = from ?? (toV > 1 ? toV - 1 : toV);

  useEffect(() => {
    if (!versions?.length) return;
    let stale = false;
    (async () => {
      if (!live) {
        const a = versions.find((v) => v.version === fromV)?.config;
        const b = versions.find((v) => v.version === toV)?.config;
        setDiff({ from: fromV, to: toV, changes: diffDocs(a, b), identical: JSON.stringify(a) === JSON.stringify(b) });
        return;
      }
      try {
        const r = await api(`/api/v1/presets/${enc(preset.name)}/diff?from=${fromV}&to=${toV}`, { key: apiKey });
        if (!stale) setDiff({ from: r.data.from.version, to: r.data.to.version, changes: r.data.changes, identical: r.data.identical });
      } catch (e) {
        if (!stale) setError(e?.message || String(e));
      }
    })();
    return () => {
      stale = true;
    };
  }, [versions, fromV, toV, live, apiKey, preset.name]);

  async function rollback(version) {
    setBusy(version);
    setError("");
    try {
      const r = await api(`/api/v1/presets/${enc(preset.name)}/rollback`, { key: apiKey, method: "POST", body: { version } });
      notify?.(r.data.changed ? `Restored v${version} of ${PRESET_PREFIX}${preset.name} as v${r.data.version}.` : `v${version} is already what ${PRESET_PREFIX}${preset.name} serves.`);
      await onChanged();
      await loadVersions();
      setFrom(null);
      setTo(null);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(0);
    }
  }

  if (versions === null)
    return (
      <div className="empty loading-state" role="status">
        <span className="loading-bar" aria-hidden="true" />
        Loading versions…
      </div>
    );

  return (
    <section className={styles.history} aria-labelledby="preset-history-title">
      <div className="panel-heading">
        <div>
          <h2 id="preset-history-title">
            Versions of <span className="mono">{PRESET_PREFIX + preset.name}</span>
          </h2>
          <p className="help-text">Every change is a new version. Rollback copies an earlier one forward, so the history only grows and a pinned name keeps its content.</p>
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className={styles.historyGrid}>
        <ol className={styles.versions}>
          {versions.map((v) => (
            <li key={v.version} className={v.version === latest ? styles.latest : undefined}>
              <div>
                <strong>v{v.version}</strong> <code className="mono">{shortHash(v.hash)}</code>
                {v.version === latest && <span className="badge">Serving</span>}
              </div>
              <small>
                {v.source === "rollback" ? `Rollback to v${v.restored_from}` : "Saved"} · {when(v.created_at)}
              </small>
              <div className={styles.versionActions}>
                <button type="button" className="text-button" aria-pressed={v.version === fromV} onClick={() => setFrom(v.version)} aria-label={`Compare from v${v.version}`}>
                  From
                </button>
                <button type="button" className="text-button" aria-pressed={v.version === toV} onClick={() => setTo(v.version)} aria-label={`Compare to v${v.version}`}>
                  To
                </button>
                {live && !readOnly && v.version !== latest && (
                  <button type="button" className="text-button" disabled={!!busy} onClick={() => rollback(v.version)}>
                    {busy === v.version ? "Restoring…" : "Roll back →"}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
        <div className={styles.diff} aria-live="polite">
          <span className="eyebrow">
            Diff v{diff?.from ?? fromV} → v{diff?.to ?? toV}
          </span>
          {!diff ? null : diff.identical || !diff.changes.length ? (
            <p className={routeStyles.none}>Same content{diff.from !== diff.to ? ", same hash" : ""}.</p>
          ) : (
            <ul className={styles.changes}>
              {diff.changes.map((c) => (
                <li key={c.op + c.path} className={styles[c.op]}>
                  <code className="mono">{c.path}</code>
                  {c.op !== "add" && <del>{showValue(c.from)}</del>}
                  {c.op !== "remove" && <ins>{showValue(c.to)}</ins>}
                </li>
              ))}
            </ul>
          )}
          <p className={styles.pin}>
            Pin a version: <code className="mono">{pinned(preset.name, toV)}</code>
          </p>
        </div>
      </div>
    </section>
  );
}

export default function Presets({ live, apiKey, ws, catalog = [], notify }) {
  const [presets, setPresets] = useState(null); // null while loading
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState(null); // { preset } for a new version, {} to create
  const [removing, setRemoving] = useState(null);
  const [selected, setSelected] = useState("");
  const [lang, setLang] = useState("js");
  const historyRef = useRef(null);
  const readOnly = live && !!ws?.me && !ws.me.management && !ws.me.team;
  const rows = live ? presets || [] : samplePresets;
  const current = rows.find((p) => p.name === selected) || rows[0] || null;
  const origin = typeof window !== "undefined" ? API_BASE || window.location.origin : "";
  const atLimit = live && (presets?.length ?? 0) >= MAX_PRESETS;

  async function load() {
    setLoadError("");
    try {
      const r = await api("/api/v1/presets", { key: apiKey });
      setPresets(r.data);
      return r.data;
    } catch (e) {
      setLoadError(e?.message || String(e));
      setPresets((x) => x ?? []);
    }
  }
  useEffect(() => {
    if (live && apiKey) load();
  }, [live, apiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function show(name) {
    setSelected(name);
    requestAnimationFrame(() => historyRef.current?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
  }

  const heading = (
    <div className="panel-heading">
      <div>
        <h2>Config as code. Every change versioned.</h2>
        <p className="help-text">
          A preset is a saved route that can also carry a system prompt, tools and a response_format. Call it as <code className="mono">model: "@preset/&lt;name&gt;"</code>, or pin one version with <code className="mono">@preset/&lt;name&gt;@3</code>.
        </p>
      </div>
      {!live ? (
        <span className="badge">Sample presets · not saved</span>
      ) : readOnly ? (
        <span className="badge">Read only · member key</span>
      ) : (
        <Button onClick={() => setEditing({})} disabled={atLimit || presets === null} title={atLimit ? `An account can save at most ${MAX_PRESETS} presets. Delete one first.` : undefined}>
          New preset
        </Button>
      )}
    </div>
  );

  if (live && presets === null)
    return (
      <>
        {heading}
        <div className="empty loading-state" role="status">
          <span className="loading-bar" aria-hidden="true" />
          Loading presets…
        </div>
      </>
    );

  return (
    <>
      {heading}
      {!live && (
        <div className="note">
          Presets live on the router, one set per account. This sample workspace has no account, so the presets below are fixed examples: they cannot be called, edited or rolled back here.{" "}
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
      {live && readOnly && <div className="note">This key is a member key: it can list, compare and call the account’s presets. Owners and admins save versions and roll back.</div>}
      {loadError && (
        <div className="error" role="alert">
          Could not load presets: {loadError}{" "}
          <button className="text-button" onClick={load}>
            Retry
          </button>
        </div>
      )}
      {rows.length ? (
        <>
          <div className={routeStyles.meta}>
            <span className="catalog-count">{live ? `${rows.length} / ${MAX_PRESETS} presets` : `${rows.length} sample presets`}</span>
          </div>
          <div className="table-wrap">
            <table className={"data-table " + routeStyles.table}>
              <thead>
                <tr>
                  <th>Preset</th>
                  <th>Version</th>
                  <th>Fallback order</th>
                  <th>Defaults</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p, i) => (
                  <tr key={p.name} style={{ "--i": Math.min(i, 12) }} className={current?.name === p.name ? routeStyles.current : undefined}>
                    <td className="cell-primary">
                      <strong>{p.name}</strong>
                      <code className={routeStyles.slug}>{PRESET_PREFIX + p.name}</code>
                      {p.sample && <span className="badge">Sample</span>}
                      {p.description && <small className={routeStyles.description}>{p.description}</small>}
                    </td>
                    <td data-label="Version">
                      <span className="mono">{versionLabel(p)}</span>
                      <small className={routeStyles.description}>
                        {p.versions} version{p.versions === 1 ? "" : "s"}
                      </small>
                    </td>
                    <td data-label="Fallback order">
                      <ol className={routeStyles.order}>
                        {p.config.models.map((m) => (
                          <li key={m}>
                            <span className="mono">{m}</span>
                          </li>
                        ))}
                      </ol>
                    </td>
                    <td data-label="Defaults">
                      <Tags items={presetSummary(p.config)} empty="Request values" />
                    </td>
                    <td className="cell-action">
                      <div className={routeStyles.actions}>
                        <button className="text-button" onClick={() => show(p.name)} aria-label={`Show versions of ${PRESET_PREFIX}${p.name}`}>
                          Versions →
                        </button>
                        {live && !readOnly && (
                          <>
                            <button className="text-button" onClick={() => setEditing({ preset: p })} aria-label={`Save a new version of ${PRESET_PREFIX}${p.name}`}>
                              Edit
                            </button>
                            <button className="text-button" onClick={() => setRemoving(p)} aria-label={`Delete ${PRESET_PREFIX}${p.name}`}>
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
            <h3>No presets yet.</h3>
            <p>{readOnly ? "An owner or admin of this account can create the first one." : "Save models, defaults and a system prompt once, then call them by name and roll back any change."}</p>
            {!readOnly && <Button onClick={() => setEditing({})}>Create your first preset</Button>}
          </div>
        )
      )}

      {current && (
        <div ref={historyRef}>
          <History preset={current} live={live} readOnly={readOnly} apiKey={apiKey} notify={notify} onChanged={load} />
        </div>
      )}

      <div className="panel-heading">
        <div>
          <h2>Call it by name.</h2>
          <p className="help-text">The response names the model that served it and the preset version: name, number and hash.</p>
        </div>
      </div>
      <div className={routeStyles.useGrid}>
        <div>
          <div className={routeStyles.langs} role="group" aria-label="Snippet language">
            {[
              ["js", "JavaScript"],
              ["python", "Python"],
            ].map(([id, label]) => (
              <button key={id} type="button" aria-pressed={lang === id} onClick={() => setLang(id)}>
                {label}
              </button>
            ))}
          </div>
          <Code label={"OpenAI SDK · " + (current ? PRESET_PREFIX + current.name : "example")}>{snippet(current?.name, null, origin, lang)}</Code>
        </div>
        <div className={routeStyles.rules}>
          <span className="eyebrow">How a preset resolves</span>
          <ol>
            <li>
              <strong>The request wins.</strong> Parameters, <code className="mono">provider</code> fields, <code className="mono">models</code>, <code className="mono">tools</code> and <code className="mono">response_format</code> the call sets override the preset. For <code className="mono">lane</code> and <code className="mono">disclosure</code> the stricter of the two applies.
            </li>
            <li>
              <strong>One system prompt.</strong> The preset’s <code className="mono">system_prompt</code> is added first only when the call has no <code className="mono">system</code> or <code className="mono">developer</code> message.
            </li>
            <li>
              <strong>Key limits still apply.</strong> A key allowed <code className="mono">@preset/&lt;name&gt;</code> may use that preset’s models; guardrails run on the final request.
            </li>
          </ol>
          <p>Presets belong to one account: another account’s key gets <code className="mono">preset_not_found</code>.</p>
        </div>
      </div>

      {editing && (
        <PresetEditor
          existing={editing.preset}
          catalog={catalog}
          apiKey={apiKey}
          onClose={() => setEditing(null)}
          onSaved={async (saved) => {
            await load();
            setSelected(saved.name);
            setEditing(null);
            notify?.(saved.changed ? `Saved ${pinned(saved.name, saved.version)}.` : `No change: ${PRESET_PREFIX}${saved.name} stays at v${saved.version}.`);
          }}
        />
      )}
      {removing && (
        <DeleteDialog
          preset={removing}
          apiKey={apiKey}
          onClose={() => setRemoving(null)}
          onDeleted={async () => {
            const name = removing.name;
            await load();
            setRemoving(null);
            if (selected === name) setSelected("");
            notify?.(`Deleted ${PRESET_PREFIX}${name}.`);
          }}
        />
      )}
    </>
  );
}
