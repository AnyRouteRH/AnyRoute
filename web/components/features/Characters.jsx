"use client";
import { useEffect, useMemo, useState } from "react";
import { Button, Modal, Code, CopyButton } from "../UI";
import { API_BASE, api, setMode } from "../../lib/api";
import { CHARACTER_PREFIX, VISIBILITIES, cardSummary, characterModel, characterSummary, chatPreviewBody, clientSnippet, exportPath, greetingsOf, parseCardFile, sampleCharacters, sillyTavernSnippet } from "../../lib/characters";
import routeStyles from "./SavedRoutes.module.css";
import styles from "./Characters.module.css";

/**
 * Characters workspace tab: Tavern character cards (V2 or V3, JSON or PNG) kept on the router and called as
 * model "@character/<id>", with a one-message chat preview and the SillyTavern connection.
 * Props (from Dashboard): { live, apiKey, ws, catalog, notify, fail, navigate }. live=false shows fixed, labelled samples and never calls the API.
 */

const enc = encodeURIComponent;
const VISIBILITY = { public: "Public", unlisted: "Unlisted", private: "Private" };
const VISIBILITY_HELP = {
  public: "Listed in discovery: anyone can find, read and call it. You see how many calls it gets and what they cost, never what was said.",
  unlisted: "Not listed: anyone with the id can read and call it.",
};

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

function ModelSelect({ id, value, onChange, models, empty }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {value && !models.some((m) => m.id === value) && <option value={value}>{value}</option>}
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.id}
        </option>
      ))}
    </select>
  );
}

/** Read a card file in the browser, show what it holds, then POST its JSON. The PNG itself is never uploaded. */
function Importer({ live, apiKey, models, onImported }) {
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState(null);
  const [fileError, setFileError] = useState("");
  const [visibility, setVisibility] = useState("unlisted");
  const [model, setModel] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const summary = parsed ? cardSummary(parsed.card) : null;

  async function loadFile(file) {
    if (!file) return;
    setFileError("");
    setError("");
    setParsed(null);
    setFileName(file.name);
    try {
      setParsed(parseCardFile(new Uint8Array(await file.arrayBuffer())));
    } catch (e) {
      setFileError(e?.message || String(e));
    }
  }

  async function submit(e) {
    e.preventDefault();
    if (!parsed || !live) return;
    setBusy(true);
    setError("");
    try {
      const r = await api("/api/v1/characters", { key: apiKey, method: "POST", body: { visibility, card: parsed.card, ...(model ? { model } : {}) } });
      setParsed(null);
      setFileName("");
      await onImported(r.data);
    } catch (e2) {
      setError(e2?.message || String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.import} onSubmit={submit} aria-labelledby="character-import-title" noValidate>
      <h3 id="character-import-title">Import a card</h3>
      <div className="field">
        <label htmlFor="character-file">Character card (.json or .png)</label>
        <input
          id="character-file"
          className={styles.fileInput}
          type="file"
          accept=".json,.png,application/json,image/png"
          aria-describedby="character-file-hint"
          onChange={(e) => {
            loadFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <small className={routeStyles.hint} id="character-file-hint">
          Read in this browser: V1, V2 and V3 cards, as JSON or inside a PNG (the ccv3 chunk, else chara). Only the card&apos;s JSON is sent, and only when you import it.
        </small>
      </div>
      {fileError && (
        <div className="error" role="alert">
          {fileName}: {fileError}
        </div>
      )}
      {summary && (
        <div className={styles.parsed} aria-live="polite">
          <strong>{summary.name}</strong>
          <small>
            {fileName} · {summary.spec} · {parsed.source === "png" ? `from the PNG's ${parsed.chunk} chunk` : "JSON"}
            {summary.creator ? ` · by ${summary.creator}` : ""}
          </small>
          <Tags items={[`${summary.greetings} greeting${summary.greetings === 1 ? "" : "s"}`, ...(summary.lorebook ? [`lorebook · ${summary.lorebook}`] : []), ...summary.tags]} empty="" />
        </div>
      )}
      <div className="field">
        <span className={styles.label} id="character-visibility-label">
          Visibility
        </span>
        <div className={routeStyles.langs} role="group" aria-labelledby="character-visibility-label">
          {VISIBILITIES.map((v) => (
            <button key={v} type="button" aria-pressed={visibility === v} onClick={() => setVisibility(v)}>
              {VISIBILITY[v]}
            </button>
          ))}
        </div>
        <small className={routeStyles.hint}>{VISIBILITY_HELP[visibility]}</small>
      </div>
      <div className="field">
        <label htmlFor="character-default-model">Default model</label>
        <ModelSelect id="character-default-model" value={model} onChange={setModel} models={models} empty="None: each call names its model" />
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="button-row">
        <Button type="submit" disabled={!parsed || busy || !live} title={!live ? "The sample workspace sends nothing." : undefined}>
          {busy ? "Importing…" : "Import character"}
        </Button>
      </div>
      <p className={styles.private}>
        Private cards are encrypted on your device with <code className="mono">sealCard</code> from <code className="mono">@anyroute/client/characters</code>; the router keeps only the ciphertext and a hash. The dashboard does not create them.
      </p>
    </form>
  );
}

function DeleteDialog({ character, apiKey, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const model = characterModel(character.id);
  return (
    <Modal title={`Delete ${character.name || model}?`} onClose={onClose}>
      <p>
        Calls to <code className="mono">{model}</code> fail from now on, in SillyTavern and every other client. Receipts of past calls are unaffected. This cannot be undone.
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
              await api("/api/v1/characters/" + enc(character.id), { key: apiKey, method: "DELETE" });
              await onDeleted();
            } catch (e) {
              setError(e?.message || String(e));
              setBusy(false);
            }
          }}
        >
          {busy ? "Deleting…" : "Delete character"}
        </Button>
        <Button secondary onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

/** One message to POST /api/v1/characters/:id/chat, not streamed, with the lane the router reports. */
function Preview({ live, apiKey, character, chattable, models, onPick }) {
  const [model, setModel] = useState("");
  const [greeting, setGreeting] = useState(0);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState("");
  const [reply, setReply] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const greetings = character?.card ? greetingsOf(character.card) : [];

  useEffect(() => {
    setGreeting(0);
    setReply(null);
    setSent("");
    setError("");
  }, [character?.id]);

  async function send(e) {
    e.preventDefault();
    setError("");
    let body;
    try {
      body = chatPreviewBody({ message, model, greeting });
    } catch (e2) {
      setError(e2.message);
      return;
    }
    setSent(body.messages[0].content);
    setReply(null);
    if (!live) {
      setReply({ text: character.preview?.reply || "", lane: character.preview?.lane, note: character.preview?.note, model: model || character.default_model, sample: true });
      return;
    }
    setBusy(true);
    const seen = {};
    try {
      const r = await api(`/api/v1/characters/${enc(character.id)}/chat`, {
        key: apiKey,
        method: "POST",
        body,
        onResponse: (res) => {
          seen.lane = res.headers.get("x-anyroute-character-lane");
          seen.note = res.headers.get("x-anyroute-character-note");
          seen.receipt = res.headers.get("x-receipt-id");
        },
      });
      setReply({ text: r?.choices?.[0]?.message?.content ?? "", lane: seen.lane, note: seen.note, model: r?.model, receipt: r?.receipt?.id || seen.receipt });
    } catch (e2) {
      setError(e2?.message || String(e2));
    } finally {
      setBusy(false);
    }
  }

  if (!chattable.length)
    return (
      <div className="empty">
        <h3>Nothing to preview yet.</h3>
        <p>Import a public or unlisted card to try it here. A private card is opened on your device, so it is tried from your own client.</p>
      </div>
    );

  return (
    <div className={styles.chatGrid}>
      <form className={styles.chatForm} onSubmit={send} noValidate>
        <div className="field">
          <label htmlFor="character-preview-pick">Character</label>
          <select id="character-preview-pick" value={character?.id || ""} onChange={(e) => onPick(e.target.value)}>
            {chattable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.id}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="character-preview-model">Model</label>
          <ModelSelect id="character-preview-model" value={model} onChange={setModel} models={models} empty={character?.default_model ? `Card default (${character.default_model})` : "Pick a model: this card has no default"} />
        </div>
        {greetings.length > 1 && (
          <div className="field">
            <label htmlFor="character-preview-greeting">Greeting</label>
            <select id="character-preview-greeting" value={greeting} onChange={(e) => setGreeting(Number(e.target.value))}>
              {greetings.map((g, i) => (
                <option key={i} value={i}>
                  {i === 0 ? "First message" : `Alternate ${i}`}: {g.length > 48 ? g.slice(0, 47) + "…" : g}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="character-preview-message">Your message</label>
          <textarea id="character-preview-message" className={styles.message} value={message} placeholder="Hello!" onChange={(e) => setMessage(e.target.value)} />
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="button-row">
          <Button type="submit" disabled={busy || !character}>
            {busy ? "Waiting for the reply…" : live ? "Send" : "Show sample reply"}
          </Button>
        </div>
      </form>
      <div className={styles.transcript} aria-live="polite">
        <span className="eyebrow">{live ? "Preview" : "Sample preview · not generated"}</span>
        {greetings[greeting] && (
          <p className={styles.turn}>
            <span>{character.name}</span>
            {greetings[greeting]}
          </p>
        )}
        {sent && (
          <p className={styles.turn + " " + styles.user}>
            <span>You</span>
            {sent}
          </p>
        )}
        {busy && (
          <div className="loading-state" role="status">
            <span className="loading-bar" aria-hidden="true" />
            Waiting for {character.name}…
          </div>
        )}
        {reply && (
          <>
            <p className={styles.turn}>
              <span>{character.name}</span>
              {reply.text || <em className={routeStyles.none}>An empty reply.</em>}
            </p>
            <div className={styles.meta}>
              {reply.lane && <span className="badge">Lane {reply.lane}</span>}
              {reply.model && <span>{reply.model}</span>}
              {reply.receipt && <span>receipt {reply.receipt}</span>}
            </div>
            {reply.note && <p className={styles.note}>{reply.note}</p>}
          </>
        )}
      </div>
    </div>
  );
}

export default function Characters({ live, apiKey, catalog = [], notify }) {
  const [characters, setCharacters] = useState(null); // null while loading
  const [loadError, setLoadError] = useState("");
  const [removing, setRemoving] = useState(null);
  const [selected, setSelected] = useState("");
  const [lang, setLang] = useState("sillytavern");
  const rows = live ? characters || [] : sampleCharacters;
  const chattable = rows.filter((c) => c.card);
  const current = chattable.find((c) => c.id === selected) || chattable[0] || null;
  const models = useMemo(() => (catalog || []).filter((m) => m.type !== "Embeddings"), [catalog]);
  const origin = typeof window !== "undefined" ? API_BASE || window.location.origin : "";
  const snippetId = current?.id || rows[0]?.id;

  async function load() {
    setLoadError("");
    try {
      const r = await api("/api/v1/characters?mine=1", { key: apiKey });
      setCharacters(r.data);
      return r.data;
    } catch (e) {
      setLoadError(e?.message || String(e));
      setCharacters((x) => x ?? []);
    }
  }
  useEffect(() => {
    if (live && apiKey) load();
  }, [live, apiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const heading = (
    <div className="panel-heading">
      <div>
        <h2>One card. Any model. Your client.</h2>
        <p className="help-text">
          A character is a Tavern character card kept on the router. Call it as <code className="mono">model: "{CHARACTER_PREFIX}&lt;id&gt;"</code> from SillyTavern or any OpenAI client: the card is the prompt, and the call runs on the attested lane when the model has one.
        </p>
      </div>
      {!live && <span className="badge">Sample characters · not saved</span>}
    </div>
  );

  if (live && characters === null)
    return (
      <>
        {heading}
        <div className="empty loading-state" role="status">
          <span className="loading-bar" aria-hidden="true" />
          Loading characters…
        </div>
      </>
    );

  return (
    <>
      {heading}
      {!live && (
        <div className="note">
          Characters live on the router, one set per account. This sample workspace has no account, so the characters below are fixed examples: they cannot be called, exported or deleted here. You can still read a card file to see what it holds; nothing is sent.{" "}
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
      {loadError && (
        <div className="error" role="alert">
          Could not load characters: {loadError}{" "}
          <button className="text-button" onClick={load}>
            Retry
          </button>
        </div>
      )}

      <Importer
        live={live}
        apiKey={apiKey}
        models={models}
        onImported={async (ch) => {
          await load();
          setSelected(ch.id);
          notify?.(`Imported ${ch.name || "the card"} as ${characterModel(ch.id)}.`);
        }}
      />

      {rows.length ? (
        <>
          <div className={routeStyles.meta}>
            <span className="catalog-count">{live ? `${rows.length} character${rows.length === 1 ? "" : "s"}` : `${rows.length} sample characters`}</span>
          </div>
          <div className="table-wrap">
            <table className={"data-table " + routeStyles.table}>
              <thead>
                <tr>
                  <th>Character</th>
                  <th>Card</th>
                  <th>Default model</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c, i) => (
                  <tr key={c.id} style={{ "--i": Math.min(i, 12) }} className={current?.id === c.id ? routeStyles.current : undefined}>
                    <td className="cell-primary">
                      <strong>{c.name || "Private character"}</strong>
                      <code className={routeStyles.slug}>{characterModel(c.id)}</code>
                      <span className="badge">{VISIBILITY[c.visibility] || c.visibility}</span> {c.sample && <span className="badge">Sample</span>}
                      {c.tags?.length > 0 && <small className={routeStyles.description}>{c.tags.join(" · ")}</small>}
                    </td>
                    <td data-label="Card">
                      <Tags items={characterSummary(c)} empty="" />
                    </td>
                    <td data-label="Default model">{c.default_model ? <span className={"mono " + styles.model}>{c.default_model}</span> : <span className={routeStyles.none}>Named per call</span>}</td>
                    <td className="cell-action">
                      <div className={routeStyles.actions}>
                        <CopyButton text={characterModel(c.id)} label="Copy model" />
                        {c.card && (
                          <button className="text-button" onClick={() => setSelected(c.id)} aria-label={`Preview a chat with ${c.name}`}>
                            Preview →
                          </button>
                        )}
                        {live && c.visibility !== "private" && (
                          <>
                            <a className="text-button" href={API_BASE + exportPath(c.id, "json", c.spec)} download aria-label={`Export ${c.name} as JSON`}>
                              JSON
                            </a>
                            <a className="text-button" href={API_BASE + exportPath(c.id, "png", c.spec)} download aria-label={`Export ${c.name} as PNG`}>
                              PNG
                            </a>
                          </>
                        )}
                        {live && c.owner && (
                          <button className="text-button" onClick={() => setRemoving(c)} aria-label={`Delete ${c.name || characterModel(c.id)}`}>
                            Delete
                          </button>
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
            <h3>No characters yet.</h3>
            <p>Import a card above. It keeps its greetings, lorebook and tags, and any OpenAI client can call it by id.</p>
          </div>
        )
      )}

      <div className="panel-heading">
        <div>
          <h2>Try it before you connect a client.</h2>
          <p className="help-text">One message, not streamed. The reply names the lane it ran on: attested when the model has an attested provider, else public, with a note saying why.</p>
        </div>
      </div>
      <Preview live={live} apiKey={apiKey} character={current} chattable={chattable} models={models} onPick={setSelected} />

      <div className="panel-heading">
        <div>
          <h2>Connect SillyTavern, or any OpenAI client.</h2>
          <p className="help-text">The router builds the prompt from the card, so the client only needs the base URL, your key and the character&apos;s model id.</p>
        </div>
      </div>
      <div className={routeStyles.useGrid}>
        <div>
          <div className={routeStyles.langs} role="group" aria-label="Client">
            {[
              ["sillytavern", "SillyTavern"],
              ["js", "OpenAI SDK"],
            ].map(([id, label]) => (
              <button key={id} type="button" aria-pressed={lang === id} onClick={() => setLang(id)}>
                {label}
              </button>
            ))}
          </div>
          <Code label={(lang === "js" ? "OpenAI SDK · " : "SillyTavern · ") + (snippetId ? characterModel(snippetId) : "example")}>{lang === "js" ? clientSnippet(snippetId, origin) : sillyTavernSnippet(snippetId, origin)}</Code>
        </div>
        <div className={routeStyles.rules}>
          <span className="eyebrow">How a character call resolves</span>
          <ol>
            <li>
              <strong>The model.</strong> <code className="mono">models[0]</code> when the call sends one, else the card&apos;s default model.
            </li>
            <li>
              <strong>The lane.</strong> Attested when the model has an attested provider, else public; <code className="mono">x-anyroute-character-lane</code> says which. A lane the call asks for wins.
            </li>
            <li>
              <strong>Memory stays yours.</strong> The memory ledger stores what your client encrypted, under a scope the router cannot tie to a character. Embeddings are kept only when you opt in.
            </li>
          </ol>
          <p>Creators of public cards see calls and cost per day, never what was said or who said it.</p>
        </div>
      </div>

      {removing && (
        <DeleteDialog
          character={removing}
          apiKey={apiKey}
          onClose={() => setRemoving(null)}
          onDeleted={async () => {
            const gone = removing;
            await load();
            setRemoving(null);
            if (selected === gone.id) setSelected("");
            notify?.(`Deleted ${gone.name || characterModel(gone.id)}.`);
          }}
        />
      )}
    </>
  );
}
