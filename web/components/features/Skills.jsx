"use client";
import { useCallback, useEffect, useState } from "react";
import { API_BASE, api } from "../../lib/api";
import { Button, Modal } from "../UI";
import { LEVEL_LABEL, SKILL_LEVELS, findingLine, formatPrice, installLabel, skillsQuery } from "../../lib/skills";

/**
 * Skills tab: the Secured Skills Hub registry. Props (from Dashboard): { live, apiKey, notify, fail }.
 * Search and filter by scan level, read a skill's scan report, install (paid skills debit the key's balance: 90% to the author,
 * 10% network fee). Levels are text labels in the existing badge style. Scanned, not guaranteed.
 */
export default function Skills({ live, apiKey, notify, fail }) {
  const [q, setQ] = useState("");
  const [level, setLevel] = useState("");
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await api("/api/v1/skills" + skillsQuery({ q, level }));
      setRows(res.data);
    } catch (e) {
      setRows([]);
      fail?.(e.message);
    }
  }, [q, level, fail]);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  const inspect = async (s) => {
    try {
      setOpen((await api("/api/v1/skills/" + s.id)).data);
    } catch (e) {
      fail?.(e.message);
    }
  };

  const install = async (s) => {
    if (!apiKey) return fail?.("Sign in with an API key to install a skill.");
    setBusy(s.id);
    try {
      const res = await api("/api/v1/skills/" + s.id + "/install", { key: apiKey, method: "POST" });
      notify?.(res.data.price_usd > 0 ? `Installed ${s.name}: ${formatPrice(res.data.price_usd)} paid, receipt ${res.data.id}.` : `Installed ${s.name}. Download it from the details view.`);
    } catch (e) {
      fail?.(e.message);
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <div className="panel-heading">
        <h2>Skills, scanned before they run.</h2>
        <span className="badge">Scanned, not guaranteed</span>
      </div>
      <p className="catalog-note">
        Every skill is hashed and scanned for data exfiltration, prompt injection, obfuscation, dangerous shell commands, untrusted package indexes and binaries. Trusted and caution skills can be installed; dangerous or revoked ones are blocked, with the report shown. A clean scan is not proof a skill is safe: read it before you run it.
      </p>
      <div className="catalog-tools">
        <input aria-label="Search skills" className="search-field" placeholder="Search name, description or author…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Filter by scan level" value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">All levels</option>
          {SKILL_LEVELS.map((l) => (
            <option key={l} value={l}>
              {LEVEL_LABEL[l]}
            </option>
          ))}
        </select>
      </div>
      {rows === null ? (
        <p className="catalog-note">Loading skills…</p>
      ) : rows.length ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Skill</th>
                <th>Author</th>
                <th>Scan</th>
                <th>Score</th>
                <th>Price</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.name}</strong> <span className="mono">{s.version}</span>
                    <br />
                    <small>{s.description}</small>
                  </td>
                  <td>{s.author}</td>
                  <td>
                    <span className="badge">{LEVEL_LABEL[s.level]}</span>
                  </td>
                  <td className="mono">{s.score}</td>
                  <td className="mono">{formatPrice(s.price_usd)}</td>
                  <td>
                    <div className="button-row">
                      <button type="button" className="text-button" onClick={() => inspect(s)}>
                        Report →
                      </button>
                      <button type="button" className="text-button" disabled={s.level === "dangerous" || s.revoked || busy === s.id || !live} title={installLabel(s, live)} onClick={() => install(s)}>
                        {busy === s.id ? "Installing…" : "Install"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <h3>No skills match</h3>
          <p>Import one with POST /api/v1/skills/import, or clear the filters.</p>
          <Button
            secondary
            onClick={() => {
              setQ("");
              setLevel("");
            }}
          >
            Clear filters
          </Button>
        </div>
      )}
      {open && (
        <Modal title={`${open.name} ${open.version}`} onClose={() => setOpen(null)}>
          <p>
            <span className="badge">{LEVEL_LABEL[open.level]}</span> <span className="mono">score {open.score}</span> {open.revoked ? <span className="badge">Revoked: {open.revoked_reason}</span> : null}
          </p>
          <p className="mono">sha256 {open.content_hash}</p>
          <p>{open.scan.note}</p>
          {open.scan.findings.length ? (
            <ul>
              {open.scan.findings.map((f, i) => (
                <li key={i} className="mono">
                  {findingLine(f)}
                </li>
              ))}
            </ul>
          ) : (
            <p>No findings.</p>
          )}
          {open.downloadable && (
            <Button href={(API_BASE || "") + "/api/v1/skills/" + open.id + "/download"} secondary>
              Download tar.gz
            </Button>
          )}
        </Modal>
      )}
    </>
  );
}
