"use client";
import { useEffect, useId, useState } from "react";
import { api } from "../../lib/api";
import { Button } from "../UI";
import styles from "./Tracing.module.css";

/**
 * Tracing section of the API keys tab. Props: { live, apiKey, ws, notify, fail }.
 * Live: GET and PATCH /api/v1/keys/:hash with `tracing`. The API never returns the endpoint path, a header value or a
 * secret, so the form shows the host and header names and leaves secret fields empty: an empty field keeps the stored value.
 */

// ---- tracing pure helpers: begin (plain JS; web/tests/tracing.test.mjs loads this block) ----
export const TYPES = [
  ["otlp", "OpenTelemetry (OTLP/HTTP)"],
  ["langfuse", "Langfuse"],
  ["helicone", "Helicone"],
];

/** "Name: value" lines to a header object; blank lines are skipped, a line without a colon is an error. */
export function parseHeaders(text) {
  const headers = {};
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(":");
    if (at <= 0) return { error: `Write each header as Name: value (${line.slice(0, 30)}).` };
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { headers };
}

/** The PATCH body for the form. Empty secret fields are left out, so the stored ones are kept for the same type. */
export function tracingBody(form, current) {
  const same = current && current.type === form.type;
  const t = { type: form.type, include_content: !!form.include_content, enabled: form.enabled !== false };
  if (form.type === "otlp") {
    if (form.endpoint) t.endpoint = form.endpoint.trim();
    else if (!same) return { error: "Enter the collector URL." };
    if (form.headers && form.headers.trim()) {
      const h = parseHeaders(form.headers);
      if (h.error) return { error: h.error };
      t.headers = h.headers;
    }
  } else {
    if (form.host) t.host = form.host.trim();
    if (form.type === "langfuse") {
      if (form.public_key) t.public_key = form.public_key.trim();
      if (form.secret_key) t.secret_key = form.secret_key.trim();
      if (!same && (!t.public_key || !t.secret_key)) return { error: "Enter the Langfuse public and secret keys." };
    } else {
      if (form.api_key) t.api_key = form.api_key.trim();
      if (!same && !t.api_key) return { error: "Enter the Helicone API key." };
    }
  }
  return { body: { tracing: t } };
}

/** The export counters in words, and a tone: ok | wait | bad | off. */
export function statusText(t) {
  if (!t) return { tone: "off", text: "Off" };
  if (!t.enabled) return { tone: "off", text: "Paused" };
  const s = t.status;
  if (!s || (!s.exported && !s.failed && !s.dropped)) return { tone: "wait", text: "Waiting for the first public-lane call" };
  if (s.circuit === "open") return { tone: "bad", text: `Paused after repeated failures (${s.last_error || "error"}); retrying soon` };
  const parts = [`${s.exported.toLocaleString("en-US")} exported`];
  if (s.failed) parts.push(`${s.failed.toLocaleString("en-US")} failed`);
  if (s.dropped) parts.push(`${s.dropped.toLocaleString("en-US")} dropped`);
  return { tone: s.failed || s.dropped ? "bad" : "ok", text: parts.join(" · ") + (s.failed && s.last_error ? ` (last: ${s.last_error})` : "") };
}
// ---- tracing pure helpers: end ----

const blank = { type: "otlp", endpoint: "", headers: "", host: "", public_key: "", secret_key: "", api_key: "", include_content: false, enabled: true };

export default function Tracing({ live, apiKey, ws, notify, fail }) {
  const id = useId();
  const keys = (ws?.keys || []).filter((k) => !k.disabled);
  const [hash, setHash] = useState("");
  const [current, setCurrent] = useState(null);
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const selected = hash || ws?.me?.hash || keys[0]?.hash || "";

  useEffect(() => {
    if (!live || !selected || !apiKey) return;
    let stop = false;
    api("/api/v1/keys/" + selected, { key: apiKey })
      .then((r) => {
        if (stop) return;
        const t = r.data?.tracing || null;
        setCurrent(t);
        setForm({ ...blank, ...(t ? { type: t.type, include_content: t.include_content, enabled: t.enabled } : {}) });
      })
      .catch((e) => !stop && fail?.(e.message));
    return () => {
      stop = true;
    };
  }, [live, selected, apiKey]);

  if (!live) {
    return (
      <section className={styles.tracing} aria-labelledby={id + "h"}>
        <h3 id={id + "h"}>Tracing</h3>
        <p className="help-text">Connect a key to send spans of its public-lane calls to your own OpenTelemetry collector, Langfuse or Helicone.</p>
      </section>
    );
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const save = async (body) => {
    setBusy(true);
    try {
      const r = await api("/api/v1/keys/" + selected, { key: apiKey, method: "PATCH", body });
      setCurrent(r.data?.tracing || null);
      setForm((f) => ({ ...f, endpoint: "", headers: "", host: "", public_key: "", secret_key: "", api_key: "" }));
      notify?.(body.tracing ? "Tracing destination saved." : "Tracing turned off.");
    } catch (e) {
      fail?.(e.message);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e) => {
    e.preventDefault();
    const r = tracingBody(form, current);
    if (r.error) return fail?.(r.error);
    save(r.body);
  };
  const st = statusText(current);
  const same = current && current.type === form.type;
  const keep = (what) => (same ? `Leave empty to keep the stored ${what}.` : undefined);

  return (
    <section className={styles.tracing} aria-labelledby={id + "h"}>
      <div className={styles.head}>
        <h3 id={id + "h"}>Tracing</h3>
        <span className={styles[st.tone]}>{st.text}</span>
      </div>
      <p className="help-text">
        One OpenTelemetry GenAI span per public-lane call: model, tokens, cost, latency and receipt id. Attested and unlinkable calls are never exported. Credentials are encrypted and never shown again.
      </p>
      {current && (
        <p className={styles.current}>
          Sending to <code>{current.target}</code> as {TYPES.find((t) => t[0] === current.type)?.[1] || current.type}
          {current.header_names?.length ? <> with {current.header_names.join(", ")}</> : null}
          {current.include_content ? ", including prompts and completions." : ", without prompt or completion text."}
        </p>
      )}
      <form className={styles.form} onSubmit={submit}>
        {keys.length > 1 && (
          <div className="field">
            <label htmlFor={id + "key"}>Key</label>
            <select id={id + "key"} value={selected} onChange={(e) => setHash(e.target.value)}>
              {keys.map((k) => (
                <option key={k.hash} value={k.hash}>
                  {k.name || k.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor={id + "type"}>Destination</label>
          <select id={id + "type"} value={form.type} onChange={set("type")}>
            {TYPES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {form.type === "otlp" ? (
          <>
            <div className="field">
              <label htmlFor={id + "endpoint"}>Collector URL</label>
              <input id={id + "endpoint"} type="url" inputMode="url" placeholder="https://api.honeycomb.io" value={form.endpoint} onChange={set("endpoint")} />
              <p className="help-text">{keep("URL") || "/v1/traces is added unless the URL ends with it."}</p>
            </div>
            <div className="field">
              <label htmlFor={id + "headers"}>Headers</label>
              <textarea id={id + "headers"} rows={2} placeholder="x-honeycomb-team: your-key" value={form.headers} onChange={set("headers")} spellCheck={false} autoComplete="off" />
              <p className="help-text">{keep("headers") || "One per line, Name: value."}</p>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor={id + "host"}>Host (optional)</label>
              <input id={id + "host"} type="url" placeholder={form.type === "langfuse" ? "https://cloud.langfuse.com" : "https://api.worker.helicone.ai"} value={form.host} onChange={set("host")} />
            </div>
            {form.type === "langfuse" ? (
              <>
                <div className="field">
                  <label htmlFor={id + "pk"}>Public key</label>
                  <input id={id + "pk"} placeholder={current?.public_key_hint || "pk-lf-..."} value={form.public_key} onChange={set("public_key")} autoComplete="off" />
                </div>
                <div className="field">
                  <label htmlFor={id + "sk"}>Secret key</label>
                  <input id={id + "sk"} type="password" placeholder="sk-lf-..." value={form.secret_key} onChange={set("secret_key")} autoComplete="off" />
                  {keep("keys") && <p className="help-text">{keep("keys")}</p>}
                </div>
              </>
            ) : (
              <div className="field">
                <label htmlFor={id + "hk"}>API key</label>
                <input id={id + "hk"} type="password" placeholder="sk-helicone-..." value={form.api_key} onChange={set("api_key")} autoComplete="off" />
                {keep("key") && <p className="help-text">{keep("key")}</p>}
              </div>
            )}
          </>
        )}
        <label className={styles.check}>
          <input type="checkbox" checked={form.include_content} onChange={set("include_content")} /> Include prompt and completion text
        </label>
        <div className="button-row">
          <Button type="submit" disabled={busy || !selected}>
            {current ? "Save destination" : "Start tracing"}
          </Button>
          {current && (
            <button type="button" className="text-button" disabled={busy} onClick={() => save({ tracing: null })}>
              Turn off
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
